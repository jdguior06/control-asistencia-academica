// Alertas de Grafana en el portal (RF-29): Grafana (vm-monitoreo) envía cada alerta al
// dispararse y al resolverse. El portal la guarda con su tenant y su hora de detección,
// la muestra en Monitoreo y avisa por correo al operador y al administrador del tenant.
const { createHash, timingSafeEqual } = require('node:crypto');
const nodemailer = require('nodemailer');

function sameToken(given, expected) {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// "Authorization: Bearer <token>" con el token que Ansible puso en Grafana y en el portal.
function authorized(request) {
  const header = request.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return sameToken(token, process.env.PLATFORM_ALERT_TOKEN?.trim());
}

function clean(value, max = 500) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : '';
}

function date(value) {
  const parsed = value ? new Date(value) : null;
  // Grafana manda "0001-01-01T00:00:00Z" como fin de una alerta que sigue activa.
  return parsed && !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() > 2000 ? parsed : null;
}

// Guarda las alertas del aviso y devuelve las que cambiaron de estado (para los correos).
async function receiveGrafana(pool, body) {
  const alerts = Array.isArray(body?.alerts) ? body.alerts.slice(0, 100) : [];
  const changes = [];
  for (const alert of alerts) {
    const labels = alert?.labels ?? {};
    const annotations = alert?.annotations ?? {};
    const startedAt = date(alert?.startsAt) ?? new Date();
    const fingerprint = clean(alert?.fingerprint, 64) || createHash('sha256').update(JSON.stringify(labels)).digest('hex').slice(0, 16);
    const firing = alert?.status !== 'resolved';
    const values = {
      fingerprint,
      rule: clean(labels.alertname, 200) || 'Alerta',
      tenant: clean(labels.tenant, 63) || null,
      server: clean(labels.servidor, 120) || null,
      environment: clean(labels.entorno, 40) || null,
      severity: clean(labels.severidad, 40) || null,
      summary: clean(annotations.summary),
      description: clean(annotations.description, 1000),
      startedAt,
      resolvedAt: firing ? null : date(alert?.endsAt) ?? new Date(),
    };
    const { rows: [row] } = await pool.query(`
      INSERT INTO platform_alerts (fingerprint, rule, tenant, server, environment, severity, summary, description,
                                   status, started_at, resolved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (fingerprint, started_at) DO UPDATE SET
        status = EXCLUDED.status,
        resolved_at = EXCLUDED.resolved_at,
        summary = EXCLUDED.summary,
        description = EXCLUDED.description,
        last_received_at = now()
      RETURNING id, (xmax = 0) AS inserted
    `, [values.fingerprint, values.rule, values.tenant, values.server, values.environment, values.severity,
      values.summary, values.description, firing ? 'firing' : 'resolved', values.startedAt, values.resolvedAt]);
    changes.push({ id: row.id, inserted: row.inserted, firing, ...values });
  }
  // Una alerta resuelta que nunca vimos dispararse no necesita correo de "resuelta".
  return changes.filter((change) => change.firing ? change.inserted : true);
}

function smtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !process.env.SMTP_FROM || !Number.isInteger(port) || Boolean(user) !== Boolean(pass)) return null;
  const secure = process.env.SMTP_SECURE === undefined ? port === 465 : process.env.SMTP_SECURE === 'true';
  return nodemailer.createTransport({
    // STARTTLS obligatorio (Gmail); SMTP_REQUIRE_TLS=false solo para pruebas locales.
    host, port, secure, requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 7000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

const timeFormat = new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'medium', timeStyle: 'medium', timeZone: process.env.PLATFORM_TIMEZONE || 'America/La_Paz',
});

// Correos de un aviso: operador(es) de PLATFORM_ALERT_EMAILS y, si corresponde, el
// administrador del tenant afectado. Sin SMTP configurado, solo se registra "sin correo".
async function notify(pool, changes) {
  if (changes.length === 0) return;
  const transport = smtpTransport();
  const operators = (process.env.PLATFORM_ALERT_EMAILS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const withAdmin = process.env.PLATFORM_ALERT_NOTIFY_TENANT_ADMIN !== 'false';

  for (const change of changes) {
    let status = 'sin-smtp';
    const recipients = [...operators];
    let institution = change.tenant;
    if (change.tenant) {
      const { rows: [tenant] } = await pool.query(`
        SELECT r.admin_email, r.institution_name FROM platform_tenants t
        JOIN platform_requests r ON r.id = t.request_id WHERE t.slug = $1
      `, [change.tenant]);
      if (tenant) {
        institution = tenant.institution_name;
        if (withAdmin && tenant.admin_email) recipients.push(tenant.admin_email);
      }
    }
    const to = [...new Set(recipients.map((item) => item.toLowerCase()))];
    if (transport && to.length > 0) {
      const state = change.firing ? 'ALERTA' : 'Resuelta';
      try {
        await transport.sendMail({
          from: process.env.SMTP_FROM,
          to: to.join(', '),
          subject: `[${state}] ${change.rule}${institution ? ` · ${institution}` : ''}`,
          text: [
            change.firing ? 'Se detectó una alerta en la plataforma de asistencia.' : 'Una alerta de la plataforma se resolvió.',
            '',
            `Alerta: ${change.rule}`,
            `Institución: ${institution ?? 'Plataforma'}${change.server ? ` (servidor ${change.server})` : ''}`,
            `Detectada: ${timeFormat.format(change.startedAt)}`,
            change.resolvedAt ? `Resuelta: ${timeFormat.format(change.resolvedAt)}` : null,
            change.summary ? `Resumen: ${change.summary}` : null,
            change.description ? `Detalle: ${change.description}` : null,
          ].filter((line) => line !== null).join('\n'),
        });
        status = 'enviado';
      } catch (error) {
        console.error('No se pudo enviar el correo de la alerta.', error.code ?? error.message);
        status = 'error';
      }
    } else if (transport) {
      status = 'sin-destinatarios';
    }
    await pool.query('UPDATE platform_alerts SET email_status = $1 WHERE id = $2', [status, change.id])
      .catch(() => {});
  }
}

// Activas (sin resolver) y eventos de las últimas 24 horas, para Monitoreo.
async function alertsForMonitoring(pool) {
  const { rows } = await pool.query(`
    SELECT a.id, a.rule, a.tenant, a.server, a.environment, a.severity, a.summary, a.status,
           a.started_at, a.resolved_at, a.email_status, r.institution_name
    FROM platform_alerts a
    LEFT JOIN platform_tenants t ON t.slug = a.tenant
    LEFT JOIN platform_requests r ON r.id = t.request_id
    WHERE a.status = 'firing' OR a.started_at > now() - interval '24 hours'
       OR a.resolved_at > now() - interval '24 hours'
    ORDER BY COALESCE(a.resolved_at, a.started_at) DESC
    LIMIT 60
  `);
  return rows.map((row) => ({
    id: String(row.id),
    name: row.rule,
    tenant: row.tenant ?? undefined,
    institutionName: row.institution_name ?? undefined,
    server: row.server ?? undefined,
    environment: row.environment ?? undefined,
    severity: row.severity ?? undefined,
    summary: row.summary || undefined,
    status: row.status,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at ?? undefined,
    email: row.email_status ?? undefined,
  }));
}

module.exports = { alertsForMonitoring, authorized, notify, receiveGrafana };
