// Monitoreo del portal: el estado de cada institución según Prometheus (las mismas
// consultas que el panel "Plataforma - Vista general" de Grafana) y según sus trabajos.
const { tenantStates } = require('./provisioning');
const { alertsForMonitoring } = require('./alerts');

const T = 'tenant!="plataforma"';
const queries = {
  agentsUp: `sum by (tenant) (up{${T}})`,
  agentsTotal: `count by (tenant) (up{${T}})`,
  api: `min by (tenant) (max by (tenant, servidor) (httpcheck_status{http_status_class="2xx", http_url=~".*/api/health", ${T}}))`,
  cpu: `max by (tenant) (100 * (1 - avg by (tenant, servidor) (rate(node_cpu_seconds_total{mode="idle", ${T}}[2m]))))`,
  memory: `max by (tenant) (100 * (1 - node_memory_MemAvailable_bytes{${T}} / node_memory_MemTotal_bytes{${T}}))`,
  disk: `max by (tenant) (100 * (1 - node_filesystem_avail_bytes{mountpoint="/", ${T}} / node_filesystem_size_bytes{mountpoint="/", ${T}}))`,
  requests: `sum by (tenant) (rate(nginx_requests_total{${T}}[2m]))`,
  latency: `max by (tenant) (httpcheck_duration_milliseconds{rol="backend", http_url=~".*/api/health", ${T}})`,
  connections: `sum by (tenant) (postgresql_backends{${T}})`,
  servers: `max by (tenant, servidor, rol) (up{job="node", ${T}})`,
  errors: `sum by (tenant) (increase(nginx_api_errores_total{${T}}[15m]))`,
  platform: 'max by (servidor) (up{tenant="plataforma"})',
};

async function query(base, expr) {
  const url = new URL('/api/v1/query', base);
  url.searchParams.set('query', expr);
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Prometheus respondió ${response.status}`);
  const body = await response.json();
  return body.data?.result ?? [];
}

function byTenant(result) {
  return Object.fromEntries(result.map((item) => [item.metric.tenant, Number(item.value[1])]));
}

function rounded(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : undefined;
}

async function monitoringSnapshot(pool) {
  const base = process.env.PLATFORM_PROMETHEUS_URL?.trim();
  const grafana = process.env.PLATFORM_GRAFANA_URL?.trim().replace(/\/$/, '');
  const [tenants, events] = await Promise.all([tenantStates(pool), alertsForMonitoring(pool)]);
  // Alertas: las guarda el portal cuando Grafana avisa (alerts.js), no se piden a Prometheus.
  const active = events.filter((event) => event.status === 'firing');
  const snapshot = {
    updatedAt: new Date().toISOString(),
    prometheus: base ? 'ok' : 'not-configured',
    grafanaUrl: grafana || undefined,
    platform: [],
    alerts: active,
    events,
    tenants: tenants.map((tenant) => ({
      ...tenant, servers: [], alerts: active.filter((alert) => alert.tenant === tenant.slug).length,
    })),
  };
  if (!base) return snapshot;

  let results;
  try {
    const entries = await Promise.all(Object.entries(queries).map(async ([key, expr]) => [key, await query(base, expr)]));
    results = Object.fromEntries(entries);
  } catch (error) {
    return { ...snapshot, prometheus: 'error', prometheusError: error.message };
  }

  const values = Object.fromEntries(Object.entries(results).map(([key, result]) => [key, byTenant(result)]));
  snapshot.platform = results.platform.map((item) => ({ server: item.metric.servidor, up: item.value[1] === '1' }));
  snapshot.tenants = snapshot.tenants.map((tenant) => {
    const slug = tenant.slug;
    const seen = slug in values.agentsTotal;
    return {
      ...tenant,
      monitored: seen,
      api: slug in values.api ? values.api[slug] === 1 : undefined,
      agentsUp: seen ? values.agentsUp[slug] : undefined,
      agentsTotal: seen ? values.agentsTotal[slug] : undefined,
      cpu: rounded(values.cpu[slug]),
      memory: rounded(values.memory[slug]),
      disk: rounded(values.disk[slug]),
      requests: rounded(values.requests[slug], 2),
      latency: rounded(values.latency[slug], 0),
      connections: values.connections[slug],
      errors: slug in values.errors ? Math.round(values.errors[slug]) : undefined,
      servers: results.servers.filter((item) => item.metric.tenant === slug)
        .map((item) => ({ server: item.metric.servidor, role: item.metric.rol, up: item.value[1] === '1' }))
        .sort((a, b) => a.server.localeCompare(b.server)),
    };
  });
  return snapshot;
}

module.exports = { monitoringSnapshot };
