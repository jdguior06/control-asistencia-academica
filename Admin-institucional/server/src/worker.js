// Worker de aprovisionamiento: toma los trabajos de platform_jobs (de a uno) y
// ejecuta infra/scripts/aprovisionar.sh. Guarda cada línea en el log del trabajo
// y los pasos que anuncia el script (::paso::, ::ok::, ::aviso::, ::error::), que
// el panel muestra mientras se crea la institución.
//
// Corre como un servicio aparte del portal (asistencia-worker), con otro usuario
// del sistema: el portal solo escribe en la base; el worker es quien tiene las
// herramientas de IaC y el rol de IAM.
const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');
const { databaseUrl } = require('./config');
const { createPool } = require('./runtime/db');
const { inviteTenant } = require('./runtime/server');
const { JOB_ACTIONS, audit } = require('./runtime/audit');

// Acción del trabajo -> argumento de aprovisionar.sh
const SCRIPT_ACTIONS = { create: 'crear', delete: 'borrar', suspend: 'suspender', resume: 'reanudar' };
const DONE = {
  create: 'La infraestructura quedó lista',
  delete: 'La infraestructura se eliminó',
  suspend: 'Los servidores quedaron apagados',
  resume: 'Los servidores volvieron a encenderse',
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
    RETURNING id, action, tenant_id
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

  const steps = [];
  let result = null;
  let pending = '';
  let dirty = false;

  const flush = async () => {
    if (!pending && !dirty) return;
    const chunk = pending;
    pending = '';
    dirty = false;
    await pool.query(
      'UPDATE platform_jobs SET log = right(log || $2, $3), steps = $4 WHERE id = $1',
      [job.id, chunk, MAX_LOG, JSON.stringify(steps)],
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
      resolve({ code: code ?? (signal ? 1 : 0), steps, result });
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

async function process_(pool, job) {
  console.log(`Trabajo ${job.id}: ${job.action} ${job.tenant.slug} (${job.tenant.engine}, ${job.tenant.region})`);
  const started = Date.now();
  const { code, steps, result } = await runScript(pool, job);
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
    description: code === 0 ? `${DONE[job.action]} (${job.tenant.engine}).` : `Falló: ${error}`,
    details: {
      jobId: job.id, engine: job.tenant.engine, region: job.tenant.region, plan: job.tenant.plan_id, duration,
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

async function main() {
  const pool = createPool(databaseUrl());
  pool.on('error', (error) => console.error('Conexión PostgreSQL cerrada.', error.code ?? error.name));

  // Un trabajo "en curso" al arrancar quedó cortado (reinicio del servidor o del worker).
  await pool.query(`
    UPDATE platform_jobs SET status = 'failed', finished_at = now(),
      error = 'El worker se reinició durante el trabajo. Vuelve a intentarlo.'
    WHERE status = 'running'
  `);
  console.log(`Worker de aprovisionamiento listo (${SCRIPT}).`);

  while (!stopping) {
    try {
      const job = await claim(pool);
      if (job) await process_(pool, job);
      else await sleep(POLL_MS);
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
