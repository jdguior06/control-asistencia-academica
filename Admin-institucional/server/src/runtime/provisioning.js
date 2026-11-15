// Aprovisionamiento: el portal registra un trabajo (platform_jobs) y el worker
// (src/worker.js) lo ejecuta con infra/scripts/aprovisionar.sh.
const { transaction } = require('./db');
const { newToken, tokenHash, validEmail } = require('./security');
const { JOB_ACTIONS, audit } = require('./audit');

class ProvisioningError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Dónde se puede crear hoy: las 3 regiones que permite la organización de la cuenta de AWS.
// Azure se ve en el formulario, pero todavía no se aprovisiona.
const PROVISIONABLE_REGIONS = ['us-east-2', 'us-east-1', 'us-west-2'];

// Trabajos que cambian la infraestructura (los respaldos no cambian su estado).
const INFRA_ACTIONS = "action IN ('create', 'delete', 'suspend', 'resume')";
const BACKUP_ACTIONS = "action IN ('backup', 'restore')";
// Instituciones con infraestructura por región, según las cuotas de la cuenta (vCPU y VPC).
// Cada tenant usa 6 vCPU y 1 VPC. PLATFORM_TENANTS_PER_REGION: un número para todas las
// regiones o "us-east-2=4,us-east-1=2,us-west-2=2". Por defecto, 2 en cada una.
function regionLimits() {
  const raw = (process.env.PLATFORM_TENANTS_PER_REGION ?? '').trim();
  const limits = Object.fromEntries(PROVISIONABLE_REGIONS.map((region) => [region, 2]));
  if (/^\d+$/.test(raw)) return Object.fromEntries(PROVISIONABLE_REGIONS.map((region) => [region, Number(raw)]));
  for (const part of raw.split(',')) {
    const [region, value] = part.split('=').map((item) => item?.trim());
    if (region in limits && /^\d+$/.test(value ?? '')) limits[region] = Number(value);
  }
  return limits;
}

// Instituciones de cada región que tienen infraestructura (creada, suspendida, fallida o en
// curso): todo lo que no terminó en "eliminada".
const usedByRegion = `
  SELECT t.region, count(*)::int AS n
  FROM platform_tenants t
  JOIN LATERAL (
    SELECT action, status FROM platform_jobs WHERE tenant_id = t.id AND ${INFRA_ACTIONS} ORDER BY created_at DESC LIMIT 1
  ) j ON true
  WHERE NOT (j.action = 'delete' AND j.status = 'succeeded') AND t.id <> $1
  GROUP BY t.region
`;

// Lugares por región para el formulario de creación.
async function regionCapacity(pool) {
  const limits = regionLimits();
  const { rows } = await pool.query(usedByRegion, ['00000000-0000-0000-0000-000000000000']);
  const used = Object.fromEntries(rows.map((row) => [row.region, row.n]));
  return PROVISIONABLE_REGIONS.map((region) => ({
    region, max: limits[region], used: used[region] ?? 0, free: Math.max(0, limits[region] - (used[region] ?? 0)),
  }));
}
const PROVISIONABLE_PLANS = ['basico', 'estandar', 'avanzado'];

const jobSelect = `
  SELECT j.id, j.action, j.status, j.steps, j.log, j.result, j.error, j.versions, j.params, j.requested_by,
         j.created_at, j.started_at, j.finished_at
  FROM platform_jobs j
`;

function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    steps: row.steps,
    log: row.log,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    versions: row.versions && Object.keys(row.versions).length ? row.versions : undefined,
    backupKey: row.params?.backupKey ?? undefined,
    requestedBy: row.requested_by ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function text(value, label, min, max) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max || result.includes('\u0000')) {
    throw new ProvisioningError(400, `${label} debe tener entre ${min} y ${max} caracteres.`);
  }
  return result;
}

// La misma regla que infra/tenant/*: 3 a 30 caracteres (va en la URL y en los nombres de AWS).
function readSlug(value) {
  const slug = text(value, 'El identificador', 3, 30).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ProvisioningError(400, 'El identificador admite minúsculas, números y guiones entre palabras.');
  }
  return slug;
}

async function tenantForRequest(client, requestId, lock = false) {
  const { rows: [tenant] } = await client.query(`
    SELECT t.id, t.slug, t.region, t.engine, t.network_number, r.plan_id, r.institution_name
    FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id
    WHERE t.request_id = $1 ${lock ? 'FOR UPDATE OF t' : ''}
  `, [requestId]);
  return tenant;
}

// Último trabajo terminado de la institución (o null si nunca tuvo uno).
async function lastFinishedJob(client, tenantId) {
  const { rows: [last] } = await client.query(`
    SELECT action, status FROM platform_jobs
    WHERE tenant_id = $1 AND status IN ('succeeded', 'failed') AND ${INFRA_ACTIONS}
    ORDER BY created_at DESC LIMIT 1
  `, [tenantId]);
  return last ?? null;
}

// Estado de la infraestructura según el último trabajo terminado:
//   none (sin infraestructura) · ready (encendida) · suspended (apagada) · failed (a medias)
function infrastructureState(last) {
  if (!last) return 'none';
  const ok = last.status === 'succeeded';
  switch (last.action) {
    case 'create': return ok ? 'ready' : 'failed';
    case 'delete': return ok ? 'none' : 'failed';
    case 'suspend': return ok ? 'suspended' : 'ready';
    case 'resume': return ok ? 'ready' : 'suspended';
    default: return 'none';
  }
}

const descriptions = {
  create: 'Se inició la creación de la infraestructura',
  delete: 'Se inició la eliminación de la infraestructura',
  suspend: 'Se inició la suspensión (apagar los servidores)',
  resume: 'Se inició la reanudación (encender los servidores)',
  backup: 'Se inició un respaldo de la base de datos',
  restore: 'Se inició la restauración de la base de datos',
};

async function enqueue(client, tenant, action, user, params = {}) {
  if (action === 'create') {
    if (tenant.slug.length > 30) {
      throw new ProvisioningError(422, 'El identificador debe tener como máximo 30 caracteres para crear su infraestructura.');
    }
    if (!PROVISIONABLE_REGIONS.includes(tenant.region)) {
      throw new ProvisioningError(422, 'Solo se crea infraestructura en AWS Ohio, Virginia del Norte u Oregón.');
    }
    if (!PROVISIONABLE_PLANS.includes(tenant.plan_id)) {
      throw new ProvisioningError(422, 'Solo los planes Básico, Estándar y Avanzado tienen infraestructura definida.');
    }
    // Un bloqueo evita que dos creaciones simultáneas pasen el límite o reciban la misma red.
    await client.query('SELECT pg_advisory_xact_lock(4300002)');
    const { rows } = await client.query(usedByRegion, [tenant.id]);
    const used = rows.find((row) => row.region === tenant.region)?.n ?? 0;
    const max = regionLimits()[tenant.region];
    if (used >= max) {
      throw new ProvisioningError(409, `La región ${tenant.region} ya tiene ${used} instituciones con infraestructura (máximo ${max}, por las cuotas de vCPU y VPC). Elimina una o elige otra región.`);
    }
    // Red 10.N.0.0/16 libre.
    if (!tenant.network_number) {
      const { rows: [free] } = await client.query(`
        SELECT n FROM generate_series(1, 250) AS n
        WHERE n NOT IN (SELECT network_number FROM platform_tenants WHERE network_number IS NOT NULL)
        ORDER BY n LIMIT 1
      `);
      if (!free) throw new ProvisioningError(409, 'No quedan redes libres para nuevas instituciones.');
      await client.query('UPDATE platform_tenants SET network_number = $1 WHERE id = $2', [free.n, tenant.id]);
    }
  }
  try {
    const { rows: [job] } = await client.query(`
      INSERT INTO platform_jobs (tenant_id, action, params, requested_by) VALUES ($1, $2, $3, $4)
      RETURNING id, action, status, steps, log, result, error, versions, params, requested_by, created_at, started_at, finished_at
    `, [tenant.id, action, JSON.stringify(params), user?.name ?? 'Operador']);
    await audit(client, {
      action: JOB_ACTIONS[action], result: 'started',
      actor: user?.name ?? 'Operador', actorRole: 'Operador',
      resource: tenant.institution_name ?? tenant.slug, reference: tenant.slug,
      description: action === 'restore' ? `${descriptions[action]} (${params.backupKey}).`
        : action === 'backup' ? `${descriptions[action]}.` : `${descriptions[action]} con ${tenant.engine}.`,
      details: { jobId: job.id, engine: tenant.engine, region: tenant.region, plan: tenant.plan_id, ...(params.backupKey ? { backup: params.backupKey } : {}) },
    });
    return serializeJob(job);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_jobs_one_active_idx') {
      throw new ProvisioningError(409, 'Esta institución ya tiene un trabajo en curso.');
    }
    throw error;
  }
}

// "Crear institución" del panel: registra la institución y encola la creación.
async function createInstitution(pool, body, user) {
  const institution = text(body?.institutionName, 'El nombre de la institución', 2, 160);
  const name = text(body?.adminName, 'El nombre del administrador', 2, 120);
  const email = text(body?.adminEmail, 'El correo del administrador', 3, 254).toLowerCase();
  const planId = text(body?.planId, 'El plan', 1, 40);
  const slug = readSlug(body?.slug);
  const region = text(body?.region, 'La región', 2, 40).toLowerCase();
  const environment = body?.environment;
  const engine = body?.engine;
  if (!validEmail(email)) throw new ProvisioningError(400, 'Ingresa un correo válido.');
  if (!['production', 'staging'].includes(environment)) throw new ProvisioningError(400, 'Selecciona un entorno válido.');
  if (!['terraform', 'opentofu', 'pulumi', 'cloudformation'].includes(engine)) {
    throw new ProvisioningError(400, 'Selecciona una herramienta de infraestructura válida.');
  }

  try {
    return await transaction(pool, async (client) => {
      const { rows: [request] } = await client.query(`
        INSERT INTO platform_requests (institution_name, admin_name, admin_email, plan_id, tracking_token_hash, status)
        SELECT $1, $2, $3, id, $5, 'registered' FROM platform_plans WHERE id = $4
        RETURNING id
      `, [institution, name, email, planId, tokenHash(newToken())]);
      if (!request) throw new ProvisioningError(400, 'El plan seleccionado no existe.');
      await client.query(`
        INSERT INTO platform_tenants (request_id, slug, region, environment, engine)
        VALUES ($1, $2, $3, $4, $5)
      `, [request.id, slug, region, environment, engine]);
      const tenant = await tenantForRequest(client, request.id, true);
      await audit(client, {
        action: 'registration', actor: user?.name ?? 'Operador', actorRole: 'Operador',
        resource: institution, reference: slug,
        description: `Se registró la institución (plan ${planId}, ${region}, ${engine}).`,
        details: { plan: planId, region, engine, environment },
      });
      const job = await enqueue(client, tenant, 'create', user);
      return { requestId: request.id, job };
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_tenants_slug_key') {
      throw new ProvisioningError(409, 'Ya hay una institución registrada con ese identificador.');
    }
    throw error;
  }
}

async function startJob(pool, requestId, action, confirmation, user, options = {}) {
  return transaction(pool, async (client) => {
    const tenant = await tenantForRequest(client, requestId, true);
    if (!tenant) throw new ProvisioningError(409, 'Registra la institución antes de crear su infraestructura.');
    const last = await lastFinishedJob(client, tenant.id);
    const state = infrastructureState(last);
    // Crear: nunca creada, eliminada, o una creación que falló (reintentar: los motores
    // retoman lo que ya existe y Ansible es idempotente).
    if (action === 'create' && !(state === 'none' || (last?.action === 'create' && state === 'failed'))) {
      throw new ProvisioningError(409, 'La institución ya tiene infraestructura. Elimínala antes de volver a crearla.');
    }
    if (action === 'delete') {
      if (state === 'none') throw new ProvisioningError(409, 'La institución no tiene infraestructura que eliminar.');
      if (confirmation !== tenant.slug) {
        throw new ProvisioningError(400, `Para confirmar, escribe el identificador «${tenant.slug}».`);
      }
    }
    if (action === 'suspend' && state !== 'ready') {
      throw new ProvisioningError(409, 'Solo se puede suspender una institución con su infraestructura lista.');
    }
    if (action === 'resume' && !(state === 'suspended' || (last?.action === 'suspend' && last.status === 'failed'))) {
      throw new ProvisioningError(409, 'La institución no está suspendida.');
    }
    if ((action === 'backup' || action === 'restore') && state !== 'ready') {
      throw new ProvisioningError(409, 'Los respaldos necesitan la infraestructura lista y encendida (reanuda la institución si está suspendida).');
    }
    if (action === 'restore') {
      const { rows: [backup] } = await client.query(`
        SELECT object_key FROM platform_backups WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      `, [String(options.backupId ?? ''), tenant.id]).catch(() => ({ rows: [] }));
      if (!backup) throw new ProvisioningError(404, 'El respaldo no existe o ya se eliminó por la retención del plan.');
      if (confirmation !== tenant.slug) {
        throw new ProvisioningError(400, `Para confirmar, escribe el identificador «${tenant.slug}».`);
      }
      return enqueue(client, tenant, action, user, { backupKey: backup.object_key, backupId: String(options.backupId) });
    }
    return enqueue(client, tenant, action, user, action === 'backup' ? { kind: 'manual' } : {});
  });
}

// Último trabajo de infraestructura (kind "infra") o de respaldos (kind "backup").
async function latestJob(pool, requestId, kind = 'infra') {
  const { rows: [row] } = await pool.query(`
    ${jobSelect} JOIN platform_tenants t ON t.id = j.tenant_id
    WHERE t.request_id = $1 AND j.${kind === 'backup' ? BACKUP_ACTIONS : INFRA_ACTIONS}
    ORDER BY j.created_at DESC LIMIT 1
  `, [requestId]);
  return serializeJob(row);
}

// Respaldos disponibles (RF-19) y la política del plan.
const BACKUP_POLICY = {
  basico: { label: 'Semanal', everyHours: 24 * 7, keep: 4 },
  estandar: { label: 'Diario', everyHours: 24, keep: 7 },
  avanzado: { label: 'Diario con retención ampliada', everyHours: 24, keep: 30 },
};

async function listBackups(pool, requestId) {
  const { rows } = await pool.query(`
    SELECT b.id, b.object_key, b.bytes, b.kind, b.created_at, r.plan_id
    FROM platform_backups b
    JOIN platform_tenants t ON t.id = b.tenant_id
    JOIN platform_requests r ON r.id = t.request_id
    WHERE t.request_id = $1 AND b.deleted_at IS NULL
    ORDER BY b.created_at DESC
  `, [requestId]);
  const { rows: [plan] } = await pool.query(`
    SELECT r.plan_id FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id WHERE t.request_id = $1
  `, [requestId]);
  const policy = BACKUP_POLICY[plan?.plan_id];
  return {
    policy: policy ? { label: policy.label, everyHours: policy.everyHours, keep: policy.keep } : null,
    backups: rows.map((row) => ({
      id: String(row.id), key: row.object_key, bytes: Number(row.bytes), kind: row.kind, createdAt: row.created_at,
    })),
  };
}

// Estado de todas las instituciones (para el monitoreo del portal).
async function tenantStates(pool) {
  const { rows } = await pool.query(`
    SELECT t.slug, t.region, t.engine, t.environment, r.institution_name, r.plan_id, t.app_url,
           t.invitation_status, last.action AS last_action, last.status AS last_status,
           active.action AS active_action
    FROM platform_tenants t
    JOIN platform_requests r ON r.id = t.request_id
    LEFT JOIN LATERAL (
      SELECT action, status FROM platform_jobs
      WHERE tenant_id = t.id AND status IN ('succeeded', 'failed') AND ${INFRA_ACTIONS} ORDER BY created_at DESC LIMIT 1
    ) last ON true
    LEFT JOIN LATERAL (
      SELECT action FROM platform_jobs
      WHERE tenant_id = t.id AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1
    ) active ON true
    ORDER BY r.institution_name
  `);
  return rows.map((row) => ({
    slug: row.slug,
    institutionName: row.institution_name,
    plan: row.plan_id,
    region: row.region,
    engine: row.engine,
    environment: row.environment,
    appUrl: row.app_url ?? undefined,
    invitationStatus: row.invitation_status,
    state: infrastructureState(row.last_action ? { action: row.last_action, status: row.last_status } : null),
    activeAction: row.active_action ?? undefined,
    deleted: row.last_action === 'delete' && row.last_status === 'succeeded',
  }));
}

module.exports = {
  PROVISIONABLE_PLANS, PROVISIONABLE_REGIONS, ProvisioningError,
  BACKUP_POLICY, INFRA_ACTIONS, createInstitution, infrastructureState, latestJob, listBackups, regionCapacity,
  serializeJob, startJob, tenantStates,
};
