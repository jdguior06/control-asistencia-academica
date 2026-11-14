// Aprovisionamiento: el portal registra un trabajo (platform_jobs) y el worker
// (src/worker.js) lo ejecuta con infra/scripts/aprovisionar.sh.
const { transaction } = require('./db');
const { newToken, tokenHash, validEmail } = require('./security');

class ProvisioningError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Lo que la infraestructura sabe crear hoy (infra/tenant/*). Azure se ve en el
// formulario, pero todavía no se aprovisiona.
const PROVISIONABLE_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
const PROVISIONABLE_PLANS = ['basico', 'estandar', 'avanzado'];

const jobSelect = `
  SELECT j.id, j.action, j.status, j.steps, j.log, j.result, j.error,
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
    SELECT t.id, t.slug, t.region, t.engine, t.network_number, r.plan_id
    FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id
    WHERE t.request_id = $1 ${lock ? 'FOR UPDATE OF t' : ''}
  `, [requestId]);
  return tenant;
}

// Último trabajo terminado de la institución (o null si nunca tuvo uno).
async function lastFinishedJob(client, tenantId) {
  const { rows: [last] } = await client.query(`
    SELECT action, status FROM platform_jobs
    WHERE tenant_id = $1 AND status IN ('succeeded', 'failed')
    ORDER BY created_at DESC LIMIT 1
  `, [tenantId]);
  return last ?? null;
}

async function enqueue(client, tenant, action) {
  if (action === 'create') {
    if (tenant.slug.length > 30) {
      throw new ProvisioningError(422, 'El identificador debe tener como máximo 30 caracteres para crear su infraestructura.');
    }
    if (!PROVISIONABLE_REGIONS.includes(tenant.region)) {
      throw new ProvisioningError(422, 'Por ahora solo se crea infraestructura en AWS (us-east-1, us-east-2 o us-west-2).');
    }
    if (!PROVISIONABLE_PLANS.includes(tenant.plan_id)) {
      throw new ProvisioningError(422, 'Solo los planes Básico, Estándar y Avanzado tienen infraestructura definida.');
    }
    // Red 10.N.0.0/16 libre (un bloqueo evita que dos instituciones reciban el mismo número).
    if (!tenant.network_number) {
      await client.query('SELECT pg_advisory_xact_lock(4300002)');
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
      INSERT INTO platform_jobs (tenant_id, action) VALUES ($1, $2)
      RETURNING id, action, status, steps, log, result, error, created_at, started_at, finished_at
    `, [tenant.id, action]);
    return serializeJob(job);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_jobs_one_active_idx') {
      throw new ProvisioningError(409, 'Esta institución ya tiene un trabajo en curso.');
    }
    throw error;
  }
}

// "Crear institución" del panel: registra la institución y encola la creación.
async function createInstitution(pool, body) {
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
      const job = await enqueue(client, tenant, 'create');
      return { requestId: request.id, job };
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_tenants_slug_key') {
      throw new ProvisioningError(409, 'Ya hay una institución registrada con ese identificador.');
    }
    throw error;
  }
}

async function startJob(pool, requestId, action, confirmation) {
  return transaction(pool, async (client) => {
    const tenant = await tenantForRequest(client, requestId, true);
    if (!tenant) throw new ProvisioningError(409, 'Registra la institución antes de crear su infraestructura.');
    const last = await lastFinishedJob(client, tenant.id);
    // Crear: nunca creada, eliminada, o una creación que falló (reintentar: los motores
    // retoman lo que ya existe y Ansible es idempotente).
    if (action === 'create' && last?.action === 'create' && last.status === 'succeeded') {
      throw new ProvisioningError(409, 'La institución ya tiene infraestructura. Elimínala antes de volver a crearla.');
    }
    if (action === 'delete') {
      // Una creación (aunque haya fallado a medias) o una eliminación fallida dejan recursos.
      const exists = last !== null && (last.action === 'create' || last.status === 'failed');
      if (!exists) throw new ProvisioningError(409, 'La institución no tiene infraestructura que eliminar.');
      if (confirmation !== tenant.slug) {
        throw new ProvisioningError(400, `Para confirmar, escribe el identificador «${tenant.slug}».`);
      }
    }
    return enqueue(client, tenant, action);
  });
}

async function latestJob(pool, requestId) {
  const { rows: [row] } = await pool.query(`
    ${jobSelect} JOIN platform_tenants t ON t.id = j.tenant_id
    WHERE t.request_id = $1 ORDER BY j.created_at DESC LIMIT 1
  `, [requestId]);
  return serializeJob(row);
}

module.exports = {
  PROVISIONABLE_PLANS, PROVISIONABLE_REGIONS, ProvisioningError,
  createInstitution, latestJob, serializeJob, startJob,
};
