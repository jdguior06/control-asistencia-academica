import { useCallback, useEffect, useState } from 'react'
import {
  Activity, BellRing, CircleAlert, CircleCheck, CirclePause, Clock3, Cpu, Database, ExternalLink, Gauge,
  HardDrive, LoaderCircle, MemoryStick, RefreshCw, Server, ServerOff,
} from 'lucide-react'
import {
  ApiError, api, errorMessage, webLink,
  type MonitoredServer, type MonitoredTenant, type MonitoringSnapshot,
} from './api'
import { engines, optionLabel, regions } from './tenant-options'
import './platform-monitoring.css'

// Monitoreo con datos reales: el portal consulta a Prometheus (vm-monitoreo) las mismas
// métricas que el panel de Grafana y las combina con el estado de cada institución.

const POLL_MS = 15000

const timeFormat = new Intl.DateTimeFormat('es-BO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

const roles: Record<string, string> = { backend: 'API', frontend: 'Frontend', base: 'PostgreSQL' }

type Tone = 'ok' | 'warning' | 'error' | 'paused' | 'idle' | 'busy'
type Health = { tone: Tone; text: string }

const activeLabels = { create: 'Creando…', delete: 'Eliminando…', suspend: 'Suspendiendo…', resume: 'Reanudando…' } as const

function health(tenant: MonitoredTenant, prometheusOk: boolean): Health {
  if (tenant.activeAction) return { tone: 'busy', text: activeLabels[tenant.activeAction] }
  if (tenant.state === 'none') return { tone: 'idle', text: 'Sin infraestructura' }
  if (tenant.state === 'suspended') return { tone: 'paused', text: 'Suspendida' }
  if (tenant.state === 'failed') return { tone: 'error', text: 'Último trabajo falló' }
  if (!prometheusOk) return { tone: 'idle', text: 'Sin métricas' }
  if (!tenant.monitored) return { tone: 'warning', text: 'Sin agentes reportando' }
  if (tenant.api === false || (tenant.agentsUp ?? 0) < (tenant.agentsTotal ?? 0)) return { tone: 'error', text: 'Con fallas' }
  if ((tenant.alerts ?? 0) > 0) return { tone: 'warning', text: 'Con alertas' }
  return { tone: 'ok', text: 'Operativa' }
}

const healthIcons = {
  ok: CircleCheck, warning: CircleAlert, error: CircleAlert, paused: CirclePause, idle: ServerOff, busy: LoaderCircle,
} satisfies Record<Tone, typeof CircleCheck>

function HealthBadge({ value }: { value: Health }) {
  const Icon = healthIcons[value.tone]
  return <span className={`pm-status pm-status-${value.tone}`}>
    <Icon size={13} className={value.tone === 'busy' ? 'pm-spin' : undefined} aria-hidden="true" />{value.text}
  </span>
}

function Meter({ label, value, Icon }: { label: string; value?: number; Icon: typeof Cpu }) {
  const level = value === undefined ? '' : value >= 90 ? ' pm-meter-error' : value >= 80 ? ' pm-meter-warning' : ''
  return <div className={`pm-meter${level}`}>
    <span className="pm-meter-label"><Icon size={14} aria-hidden="true" />{label}</span>
    <strong>{value === undefined ? '—' : `${value}%`}</strong>
    <span className="pm-meter-track" aria-hidden="true"><span style={{ width: `${Math.min(value ?? 0, 100)}%` }} /></span>
  </div>
}

function ServerChips({ servers }: { servers: MonitoredServer[] }) {
  if (servers.length === 0) return null
  return <ul className="pm-chips" aria-label="Servidores">
    {servers.map(server => <li key={server.server} className={server.up ? undefined : 'pm-chip-down'} title={server.server}>
      {server.up ? <CircleCheck size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}
      {server.role ? roles[server.role] ?? server.role : server.server}
      <span className="pm-visually-hidden">{server.up ? ' en línea' : ' sin respuesta'}</span>
    </li>)}
  </ul>
}

function idleNote(tenant: MonitoredTenant, prometheusOk: boolean) {
  if (tenant.activeAction) return 'Hay un trabajo en curso; las métricas aparecen cuando termine.'
  if (tenant.state === 'suspended') return 'Los servidores están apagados: no generan métricas ni consumen horas de cómputo.'
  if (tenant.state === 'none') return 'Todavía no tiene servidores. Créalos desde Solicitudes.'
  if (tenant.state === 'failed') return 'Revisa el registro del último trabajo en Solicitudes.'
  if (prometheusOk) return 'Prometheus todavía no recibe datos de sus agentes (pueden tardar 1–2 minutos).'
  return 'Las métricas no están disponibles en este momento.'
}

function TenantCard({ tenant, snapshot }: { tenant: MonitoredTenant; snapshot: MonitoringSnapshot }) {
  const prometheusOk = snapshot.prometheus === 'ok'
  const status = health(tenant, prometheusOk)
  const live = !tenant.activeAction && tenant.state === 'ready' && prometheusOk && tenant.monitored
  const grafana = snapshot.grafanaUrl && tenant.state !== 'none'
    ? webLink(`${snapshot.grafanaUrl}/d/tenant-detalle/tenant-detalle?var-tenant=${encodeURIComponent(tenant.slug)}`)
    : undefined
  const app = tenant.state === 'ready' ? webLink(tenant.appUrl) : undefined
  const agentsMissing = (tenant.agentsUp ?? 0) < (tenant.agentsTotal ?? 0)

  return <article className={`pm-tenant pm-tenant-${status.tone}`} aria-labelledby={`pm-t-${tenant.slug}`}>
    <header className="pm-tenant-heading">
      <div>
        <h3 id={`pm-t-${tenant.slug}`}>{tenant.institutionName}</h3>
        <p>{tenant.slug} · plan {tenant.plan} · {optionLabel(engines, tenant.engine)} · {optionLabel(regions, tenant.region).split(' (')[0]}</p>
      </div>
      <HealthBadge value={status} />
    </header>

    {live ? <>
      <div className="pm-meters">
        <Meter label="CPU" value={tenant.cpu} Icon={Cpu} />
        <Meter label="Memoria" value={tenant.memory} Icon={MemoryStick} />
        <Meter label="Disco" value={tenant.disk} Icon={HardDrive} />
      </div>
      <dl className="pm-facts">
        <div><dt>API</dt><dd className={tenant.api === false ? 'pm-bad' : undefined}>{tenant.api === undefined ? '—' : tenant.api ? 'Responde 2xx' : 'No responde'}</dd></div>
        <div><dt>Latencia</dt><dd>{tenant.latency === undefined ? '—' : `${tenant.latency} ms`}</dd></div>
        <div><dt>Peticiones</dt><dd>{tenant.requests === undefined ? '—' : `${tenant.requests}/s`}</dd></div>
        <div><dt>Conexiones BD</dt><dd>{tenant.connections ?? '—'}</dd></div>
        <div><dt>Agentes</dt><dd className={agentsMissing ? 'pm-bad' : undefined}>{tenant.agentsUp ?? 0} de {tenant.agentsTotal ?? 0}</dd></div>
        <div><dt>Alertas</dt><dd className={tenant.alerts ? 'pm-warn' : undefined}>{tenant.alerts ?? 0}</dd></div>
      </dl>
      <ServerChips servers={tenant.servers} />
    </> : <p className="pm-tenant-note">{idleNote(tenant, prometheusOk)}</p>}

    {(grafana || app) && <footer className="pm-tenant-links">
      {grafana && <a href={grafana} target="_blank" rel="noreferrer"><Gauge size={14} aria-hidden="true" /> Panel en Grafana <ExternalLink size={12} aria-hidden="true" /></a>}
      {app && <a href={app} target="_blank" rel="noreferrer"><Activity size={14} aria-hidden="true" /> Aplicación <ExternalLink size={12} aria-hidden="true" /></a>}
    </footer>}
  </article>
}

function Summary({ snapshot }: { snapshot: MonitoringSnapshot }) {
  const ok = snapshot.prometheus === 'ok'
  const counts: Partial<Record<Tone, number>> = {}
  for (const tenant of snapshot.tenants) {
    const tone = health(tenant, ok).tone
    counts[tone] = (counts[tone] ?? 0) + 1
  }
  const items = [
    { label: 'Instituciones', value: snapshot.tenants.length, Icon: Database, tone: 'all' },
    { label: 'Operativas', value: counts.ok ?? 0, Icon: CircleCheck, tone: 'ok' },
    { label: 'Con fallas o alertas', value: (counts.error ?? 0) + (counts.warning ?? 0), Icon: CircleAlert, tone: 'warning' },
    { label: 'Suspendidas', value: counts.paused ?? 0, Icon: CirclePause, tone: 'paused' },
  ]
  return <div className="pm-summary">
    {items.map(({ label, value, Icon, tone }) => <div key={label} className={`pm-summary-item pm-summary-${tone}`}>
      <span><Icon size={16} aria-hidden="true" /></span><strong>{value}</strong><small>{label}</small>
    </div>)}
  </div>
}

function PlatformPanel({ snapshot }: { snapshot: MonitoringSnapshot }) {
  return <section className="pm-panel" aria-labelledby="pm-platform-title">
    <div className="pm-panel-heading"><span className="pm-section-icon"><Server size={19} aria-hidden="true" /></span><h2 id="pm-platform-title">Servidores de la plataforma</h2></div>
    {snapshot.platform.length === 0 ? <p className="pm-empty-line">Sin datos de Prometheus.</p> : <ul className="pm-service-list">
      {snapshot.platform.map(server => <li key={server.server}>
        <span className="pm-service-icon"><Server size={18} aria-hidden="true" /></span>
        <div><strong>{server.server}</strong><p>{server.server.includes('monitoreo') ? 'Prometheus y Grafana' : 'Portal, PostgreSQL, gateway y worker'}</p></div>
        <HealthBadge value={server.up ? { tone: 'ok', text: 'En línea' } : { tone: 'error', text: 'Sin respuesta' }} />
      </li>)}
    </ul>}
  </section>
}

function AlertsPanel({ snapshot }: { snapshot: MonitoringSnapshot }) {
  const names = Object.fromEntries(snapshot.tenants.map(tenant => [tenant.slug, tenant.institutionName]))
  return <section className="pm-panel" aria-labelledby="pm-alerts-title">
    <div className="pm-panel-heading"><span className="pm-section-icon"><BellRing size={19} aria-hidden="true" /></span><h2 id="pm-alerts-title">Alertas activas</h2></div>
    <ul className="pm-event-list">
      {snapshot.alerts.length === 0 ? <li><CircleCheck size={17} aria-hidden="true" /><div>
        <strong>Sin alertas activas</strong>
        <p>{snapshot.prometheus === 'ok' ? 'Ninguna regla de alerta está disparada.' : 'No se pudo consultar Prometheus.'}</p>
      </div></li> : snapshot.alerts.map((alert, index) => <li key={`${alert.name}-${alert.server ?? ''}-${index}`} className={alert.severity === 'critical' ? 'pm-event-error' : 'pm-event-warning'}>
        <CircleAlert size={17} aria-hidden="true" /><div>
          <div className="pm-event-title"><strong>{alert.name}</strong>{alert.severity && <small>{alert.severity}</small>}</div>
          <p>{alert.tenant ? names[alert.tenant] ?? alert.tenant : 'Plataforma'}{alert.server ? ` · ${alert.server}` : ''}</p>
        </div>
      </li>)}
    </ul>
  </section>
}

const sources = {
  ok: { tone: 'ok', title: 'Datos en vivo de Prometheus', text: 'Se actualiza cada 15 segundos.' },
  error: { tone: 'error', title: 'Prometheus no responde', text: 'Solo se muestra el estado de los trabajos.' },
  'not-configured': { tone: 'idle', title: 'Prometheus no configurado', text: 'Falta PLATFORM_PROMETHEUS_URL en el portal.' },
} as const

export default function PlatformMonitoring({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await api<MonitoringSnapshot>('/api/platform/monitoring'))
      setError('')
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
      else setError(errorMessage(cause, 'No se pudo consultar el monitoreo.'))
    } finally {
      setLoading(false)
    }
  }, [onSessionExpired])

  useEffect(() => {
    const first = window.setTimeout(() => { void load() }, 0)
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, POLL_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [load])

  const grafana = webLink(snapshot?.grafanaUrl)
  const source = snapshot ? sources[snapshot.prometheus] : undefined

  return <div className="pm-dashboard">
    <div className="pm-toolbar">
      <div className="pm-demo">
        <span className={`pm-demo-icon pm-source-${source?.tone ?? 'idle'}`}><Activity size={19} aria-hidden="true" /></span>
        <div>
          <strong>{source?.title ?? 'Consultando…'}</strong>
          <p>{snapshot && source ? <>{source.text} <span className="pm-updated"><Clock3 size={11} aria-hidden="true" /> {timeFormat.format(new Date(snapshot.updatedAt))}</span></> : 'Cargando métricas.'}</p>
        </div>
      </div>
      <div className="pm-actions">
        {grafana && <a className="pa-secondary" href={grafana} target="_blank" rel="noreferrer"><Gauge size={15} aria-hidden="true" /> Abrir Grafana</a>}
        <button type="button" className="pa-secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'pm-spin' : undefined} aria-hidden="true" /> Actualizar
        </button>
      </div>
    </div>

    {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

    {snapshot && <>
      <Summary snapshot={snapshot} />
      <section aria-labelledby="pm-tenants-title">
        <header className="pm-usage-heading"><h2 id="pm-tenants-title">Instituciones</h2><span>Uso actual · el máximo entre sus servidores</span></header>
        {snapshot.tenants.length === 0
          ? <div className="pm-panel pm-empty-line">Todavía no hay instituciones registradas.</div>
          : <div className="pm-tenants">{snapshot.tenants.map(tenant => <TenantCard key={tenant.slug} tenant={tenant} snapshot={snapshot} />)}</div>}
      </section>
      <div className="pm-details"><PlatformPanel snapshot={snapshot} /><AlertsPanel snapshot={snapshot} /></div>
    </>}
  </div>
}
