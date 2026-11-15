// Worker de aprovisionamiento: toma los trabajos de platform_jobs (de a uno) y
// ejecuta infra/scripts/aprovisionar.sh. Guarda cada línea en el log del trabajo
// y los pasos que anuncia el script (::paso::, ::ok::, ::aviso::, ::error::), que
// el panel muestra mientras se crea la institución.
//
// Corre como un servicio aparte del portal (asistencia-worker), con otro usuario
// del sistema: el portal solo escribe en la base; el worker es quien tiene las
// herramientas de IaC y el rol de IAM.
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');
const { databaseUrl } = require('./config');
const { createPool } = require('./runtime/db');
const { inviteTenant } = require('./runtime/server');
const { JOB_ACTIONS, audit } = require('./runtime/audit');
const { BACKUP_POLICY } = require('./runtime/provisioning');

// Acción del trabajo -> argumento de aprovisionar.sh
const SCRIPT_ACTIONS = {
  create: 'crear', delete: 'borrar', suspend: 'suspender', resume: 'reanudar', backup: 'respaldar', restore: 'restaurar',
};
const DONE = {
  create: 'La infraestructura quedó lista',
  delete: 'La infraestructura se eliminó',
  suspend: 'Los servidores quedaron apagados',
  resume: 'Los servidores volvieron a encenderse',
  backup: 'Se guardó un respaldo de la base de datos',
  restore: 'La base de datos se restauró desde un respaldo',
};

const INFRA = path.resolve(process.env.PLATFORM_INFRA_DIR ?? path.join(__dirname, '..', '..', '..', 'infra'));
const SCRIPT = path.join(INFRA, 'scripts', 'aprovisionar.sh');
const POLL_MS = 3000;
const FLUSH_MS = 1000;
const MAX_LOG = 400_000; // caracteres que se guardan del log (los últimos)
const TIMEOUT_MS = 90 * 60 * 1000;

const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;

let stopping = false;
let child = null;

async function claim(pool) {
  const { rows: [job] } = await pool.query(`
    UPDATE platform_jobs SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM platform_jobs WHERE status = 'queued'
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, action, tenant_id, params, requested_by
  `);
  if (!job) return null;
  const { rows: [tenant] } = await pool.query(`
    SELECT t.id, t.request_id, t.slug, t.region, t.environment, t.engine, t.network_number, r.plan_id, r.institution_name
    FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id
    WHERE t.id = $1
  `, [job.tenant_id]);
  return { ...job, tenant };
}

function runScript(pool, job) {
  const { tenant } = job;
  const args = [
    SCRIPT, SCRIPT_ACTIONS[job.action],
    '--slug', tenant.slug, '--motor', tenant.engine, '--region', tenant.region,
    '--plan', tenant.plan_id, '--entorno', tenant.environment,
    '--numero', String(tenant.network_number ?? 0),
  ];
  if (job.action === 'restore') args.push('--respaldo', String(job.params?.backupKey ?? ''));

  const steps = [];
  const versions = {};
  let result = null;
  let pending = '';
  let dirty = false;

  const flush = async () => {
    if (!pending && !dirty) return;
    const chunk = pending;
    pending = '';
    dirty = false;
    await pool.query(
      'UPDATE platform_jobs SET log = right(log || $2, $3), steps = $4, versions = $5 WHERE id = $1',
      [job.id, chunk, MAX_LOG, JSON.stringify(steps), JSON.stringify(versions)],
    );
  };

  const onLine = (raw) => {
    const line = raw.replace(ansi, '').replace(/\r$/, '');
    let match;
    if ((match = line.match(/^::paso::(\d+)::(.+)$/))) {
      steps.push({ number: Number(match[1]), title: match[2], status: 'running' });
      dirty = true;
    } else if ((match = line.match(/^::(ok|aviso|error)::(\d+)::(.*)$/))) {
      const step = steps.find((item) => item.number === Number(match[2]));
      if (step) {
        step.status = { ok: 'ok', aviso: 'warning', error: 'error' }[match[1]];
        if (match[3]) step.summary = match[3];
        dirty = true;
      }
    } else if ((match = line.match(/^::resultado::(.+)$/))) {
      try { result = JSON.parse(match[1]); } catch { /* se ignora una línea mal formada */ }
    } else if ((match = line.match(/^::versiones::(.+)$/))) {
      // RF-13: el script anuncia las versiones en varias marcas; se juntan.
      try {
        const parsed = JSON.parse(match[1]);
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value.length <= 200) versions[key] = value;
        }
        dirty = true;
      } catch { /* se ignora una línea mal formada */ }
      return; // no se muestra en el registro: se ve en "Versiones"
    }
    pending += `${line}\n`;
  };

  return new Promise((resolve) => {
    child = spawn('bash', args, {
      cwd: INFRA,
      env: { ...process.env, NO_COLOR: '1', ANSIBLE_FORCE_COLOR: '0', ANSIBLE_NOCOLOR: '1', TF_IN_AUTOMATION: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    readline.createInterface({ input: child.stderr }).on('line', onLine);

    const timer = setInterval(() => { flush().catch((error) => console.error('No se pudo guardar el log.', error.code ?? error.message)); }, FLUSH_MS);
    const limit = setTimeout(() => {
      onLine(`El trabajo superó ${TIMEOUT_MS / 60000} minutos y se detuvo.`);
      child?.kill('SIGTERM');
    }, TIMEOUT_MS);

    child.on('close', async (code, signal) => {
      clearInterval(timer);
      clearTimeout(limit);
      child = null;
      // Un paso que quedó "en curso" cuando el script terminó con error, se marca como fallido.
      if (code !== 0) steps.filter((step) => step.status === 'running').forEach((step) => { step.status = 'error'; });
      await flush().catch(() => {});
      resolve({ code: code ?? (signal ? 1 : 0), steps, result, versions });
    });
  });
}

async function appendLog(pool, jobId, lines) {
  await pool.query('UPDATE platform_jobs SET log = right(log || $2, $3) WHERE id = $1', [jobId, `${lines.join('\n')}\n`, MAX_LOG]);
}

// Después de crear: vincula la instalación y prepara la invitación del administrador
// (el mismo flujo que el botón "Vincular y enviar invitación" del panel).
async function invite(pool, job, result) {
  const keyFile = path.join(INFRA, 'generado', 'tenants', job.tenant.slug, 'clave_vinculacion');
  const bootstrapKey = (await readFile(keyFile, 'utf8')).trim();
  const invited = await inviteTenant(pool, job.tenant.request_id, { appUrl: result.url, bootstrapKey });
  return { invitationStatus: invited.request.tenant?.invitationStatus, previewUrl: invited.previewUrl };
}

// Resumen legible de las versiones para la auditoría (RF-13).
function versionSummary(v) {
  const summary = {};
  if (v.repo_commit) summary.commit = `${v.repo_rama ?? ''} ${v.repo_commit}`.trim();
  if (v.app_commit || v.app_desplegada) summary.app = `commit ${v.app_desplegada ?? v.app_commit}${v.app_version ? ` · v${v.app_version}` : ''}`;
  if (v.plantilla) summary.template = `${v.plantilla} · commit ${v.plantilla_commit ?? '?'}${v.plantilla_hash ? ` · sha256 ${v.plantilla_hash}` : ''}`;
  if (v.motor_version) summary.engineVersion = `${v.motor} ${v.motor_version}${v.proveedor_aws ? ` · proveedor AWS ${v.proveedor_aws}` : ''}`;
  if (v.ansible) summary.ansible = `ansible-core ${v.ansible}${v.ansible_commit ? ` · tareas ${v.ansible_commit}` : ''}`;
  if (v.imagen) summary.image = v.imagen_nombre ? `${v.imagen_nombre} (${v.imagen})` : v.imagen;
  const scanners = ['checkov', 'trivy', 'gitleaks', 'conftest', 'tflint', 'cfn_lint'].filter((key) => v[key]);
  if (scanners.length) summary.scanners = scanners.map((key) => `${key.replace('_', '-')} ${v[key]}`).join(' · ');
  return summary;
}

async function process_(pool, job) {
  console.log(`Trabajo ${job.id}: ${job.action} ${job.tenant.slug} (${job.tenant.engine}, ${job.tenant.region})`);
  const started = Date.now();
  const { code, steps, result, versions } = await runScript(pool, job);
  let finalResult = result;
  let error = null;

  if (code === 0 && job.action === 'create' && result?.url) {
    try {
      const invitation = await invite(pool, job, result);
      finalResult = { ...result, ...invitation };
      await appendLog(pool, job.id, [`Invitación del administrador: ${invitation.invitationStatus}`]);
    } catch (cause) {
      // La infraestructura quedó lista: la invitación se puede reenviar desde el panel.
      finalResult = { ...result, invitationError: cause.message };
      await appendLog(pool, job.id, [`No se pudo preparar la invitación: ${cause.message}`]);
    }
  }
  // Respaldo nuevo y los que la retención del plan eliminó de S3.
  if (code === 0 && job.action === 'backup' && result?.respaldo?.clave) {
    await pool.query(`
      INSERT INTO platform_backups (tenant_id, job_id, object_key, bucket, bytes, kind)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (object_key) DO NOTHING
    `, [job.tenant.id, job.id, result.respaldo.clave, result.respaldo.bucket, result.respaldo.bytes,
      job.params?.kind === 'manual' ? 'manual' : 'programado']);
    if (Array.isArray(result.eliminados) && result.eliminados.length) {
      await pool.query('UPDATE platform_backups SET deleted_at = now() WHERE object_key = ANY($1) AND deleted_at IS NULL', [result.eliminados]);
    }
  }
  if (code === 0 && job.action === 'delete') {
    await pool.query(`
      UPDATE platform_tenants
      SET app_url = NULL, invitation_status = 'pending', invitation_updated_at = NULL, network_number = NULL
      WHERE id = $1
    `, [job.tenant.id]);
  }
  if (code !== 0) {
    const failed = steps.find((step) => step.status === 'error');
    error = failed ? `${failed.title}: ${failed.summary ?? 'falló'}` : `El script terminó con código ${code}.`;
  }

  await pool.query(`
    UPDATE platform_jobs SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1
  `, [job.id, code === 0 ? 'succeeded' : 'failed', finalResult ? JSON.stringify(finalResult) : null, error]);

  const seconds = Math.round((Date.now() - started) / 1000);
  const duration = `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  await audit(pool, {
    action: JOB_ACTIONS[job.action], result: code === 0 ? 'completed' : 'failed',
    actor: 'Worker', actorRole: 'Aprovisionamiento',
    resource: job.tenant.institution_name, reference: job.tenant.slug,
    description: code === 0
      ? `${DONE[job.action]}${['backup', 'restore'].includes(job.action) ? '' : ` (${job.tenant.engine})`}.`
      : `Falló: ${error}`,
    details: {
      jobId: job.id, engine: job.tenant.engine, region: job.tenant.region, plan: job.tenant.plan_id, duration,
      ...versionSummary(versions),
      ...(job.requested_by ? { requestedBy: job.requested_by } : {}),
      ...(job.params?.backupKey ? { backup: job.params.backupKey } : {}),
      ...(result?.respaldo ? { backup: result.respaldo.clave, size: `${Math.max(1, Math.round(result.respaldo.bytes / 1024))} KB` } : {}),
      steps: steps.map((step) => `${step.number}. ${step.title}: ${step.status}${step.summary ? ` · ${step.summary}` : ''}`),
    },
  });
  if (finalResult?.invitationStatus) {
    await audit(pool, {
      action: 'invitation', actor: 'Worker', actorRole: 'Aprovisionamiento',
      resource: job.tenant.institution_name, reference: job.tenant.slug,
      description: `Se generó el enlace de activación del administrador (${finalResult.invitationStatus}).`,
    });
  }
  console.log(`Trabajo ${job.id}: ${code === 0 ? 'terminado' : 'falló'}`);
}

// Tenants creados antes de guardar el hash de su clave: se toma de generado/ (solo el
// worker puede leerlo) para que su app pueda consultar el estado de sus servicios.
async function backfillStatusKeys(pool) {
  const { rows } = await pool.query('SELECT id, slug FROM platform_tenants WHERE status_key_hash IS NULL');
  for (const row of rows) {
    try {
      const key = (await readFile(path.join(INFRA, 'generado', 'tenants', row.slug, 'clave_vinculacion'), 'utf8')).trim();
      if (!key) continue;
      await pool.query('UPDATE platform_tenants SET status_key_hash = $1 WHERE id = $2',
        [createHash('sha256').update(key).digest('hex'), row.id]);
      console.log(`Clave de estado registrada para ${row.slug}.`);
    } catch { /* sin clave en generado/: el tenant no está creado */ }
  }
}

// Respaldos programados (RF-19): según el plan (semanal o diario). El primero, una hora
// después de que la infraestructura quedó lista. Solo instituciones encendidas y sin otro
// trabajo; si un respaldo falla, se espera una hora antes de volver a intentarlo.
const SCHEDULE_MS = 10 * 60 * 1000;
let lastSchedule = 0;

async function scheduleBackups(pool) {
  if (Date.now() - lastSchedule < SCHEDULE_MS) return;
  lastSchedule = Date.now();
  const { rows } = await pool.query(`
    SELECT t.id, t.slug, t.region, t.engine, r.plan_id, r.institution_name, last.finished_at AS ready_at,
           (SELECT max(created_at) FROM platform_backups WHERE tenant_id = t.id) AS last_backup,
           (SELECT max(created_at) FROM platform_jobs WHERE tenant_id = t.id AND action = 'backup') AS last_attempt
    FROM platform_tenants t
    JOIN platform_requests r ON r.id = t.request_id
    JOIN LATERAL (
      SELECT action, status, finished_at FROM platform_jobs
      WHERE tenant_id = t.id AND status IN ('succeeded', 'failed') AND action IN ('create', 'delete', 'suspend', 'resume')
      ORDER BY created_at DESC LIMIT 1
    ) last ON true
    WHERE last.status = 'succeeded' AND last.action IN ('create', 'resume')
      AND NOT EXISTS (SELECT 1 FROM platform_jobs WHERE tenant_id = t.id AND status IN ('queued', 'running'))
  `);
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  for (const row of rows) {
    const policy = BACKUP_POLICY[row.plan_id];
    if (!policy) continue;
    const due = row.last_backup
      ? now - new Date(row.last_backup).getTime() >= policy.everyHours * hour
      : now - new Date(row.ready_at).getTime() >= hour;
    const retryOk = !row.last_attempt || now - new Date(row.last_attempt).getTime() >= hour;
    if (!due || !retryOk) continue;
    try {
      const { rows: [job] } = await pool.query(`
        INSERT INTO platform_jobs (tenant_id, action, params, requested_by)
        VALUES ($1, 'backup', '{"kind":"programado"}', 'Respaldo programado') RETURNING id
      `, [row.id]);
      await audit(pool, {
        action: 'backup', result: 'started', actor: 'Respaldo programado', actorRole: 'Sistema',
        resource: row.institution_name, reference: row.slug,
        description: `Se inició el respaldo programado (${policy.label.toLocaleLowerCase('es')}).`,
        details: { jobId: job.id, plan: row.plan_id, region: row.region },
      });
      console.log(`Respaldo programado de ${row.slug}`);
    } catch (error) {
      if (error.code !== '23505') throw error; // ya tenía un trabajo en curso
    }
  }
}

async function main() {
  const pool = createPool(databaseUrl());
  pool.on('error', (error) => console.error('Conexión PostgreSQL cerrada.', error.code ?? error.name));

  // Un trabajo "en curso" al arrancar quedó cortado (reinicio del servidor o del worker).
  await pool.query(`
    UPDATE platform_jobs SET status = 'failed', finished_at = now(),
      error = 'El worker se reinició durante el trabajo. Vuelve a intentarlo.'
    WHERE status = 'running'
  `);
  await backfillStatusKeys(pool).catch((error) => console.error('No se pudieron completar las claves de estado.', error.message));
  console.log(`Worker de aprovisionamiento listo (${SCRIPT}).`);

  while (!stopping) {
    try {
      const job = await claim(pool);
      if (job) await process_(pool, job);
      else {
        await scheduleBackups(pool);
        await sleep(POLL_MS);
      }
    } catch (error) {
      console.error('Error del worker.', error.code ?? error.message);
      await sleep(POLL_MS);
    }
  }
  await pool.end();
}

function shutdown() {
  stopping = true;
  // Se deja terminar el paso en curso: systemd espera (TimeoutStopSec) antes de cortar.
  if (child) console.log('Esperando a que termine el trabajo en curso…');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  console.error('No se pudo iniciar el worker.', error.code ?? error.message);
  process.exitCode = 1;
});
