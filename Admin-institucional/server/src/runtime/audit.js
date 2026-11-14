// Registro de auditoría: quién hizo qué, sobre qué institución y con qué resultado.
// Un error al registrar nunca interrumpe la operación auditada.

const ACTIONS = [
  'login', 'logout', 'request', 'registration', 'plan', 'invitation', 'activation',
  'deployment', 'deletion', 'suspension', 'resumption',
];

async function audit(db, event) {
  try {
    await db.query(`
      INSERT INTO platform_audit (action, result, actor, actor_role, resource, reference, description, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      event.action, event.result ?? 'completed', event.actor ?? 'Sistema', event.actorRole ?? 'Sistema',
      event.resource ?? '', event.reference ?? '', event.description ?? '', JSON.stringify(event.details ?? {}),
    ]);
  } catch (error) {
    console.error('No se pudo registrar el evento de auditoría.', error.code ?? error.message);
  }
}

async function listAudit(pool, limit = 300) {
  const { rows } = await pool.query(`
    SELECT id, created_at, action, result, actor, actor_role, resource, reference, description, details
    FROM platform_audit ORDER BY created_at DESC, id DESC LIMIT $1
  `, [limit]);
  return rows.map((row) => ({
    id: String(row.id),
    timestamp: row.created_at,
    action: row.action,
    result: row.result,
    actor: row.actor,
    actorRole: row.actor_role,
    resource: row.resource,
    reference: row.reference,
    description: row.description,
    details: row.details,
  }));
}

// Qué acción de auditoría corresponde a cada trabajo del worker.
const JOB_ACTIONS = { create: 'deployment', delete: 'deletion', suspend: 'suspension', resume: 'resumption' };

module.exports = { ACTIONS, JOB_ACTIONS, audit, listAudit };
