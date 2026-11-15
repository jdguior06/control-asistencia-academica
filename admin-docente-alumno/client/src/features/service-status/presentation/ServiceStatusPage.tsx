import {
  Activity, BellRing, CheckCircle2, Clock3, Cpu, Database, HardDrive, History, MemoryStick, PauseCircle,
  RefreshCw, Server, TriangleAlert, XCircle,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { getErrorMessage } from '../../../core/http/api-error'
import { Button } from '../../../shared/ui/Button'
import { Card, CardHeader } from '../../../shared/ui/Card'
import { Chip, type ChipTone } from '../../../shared/ui/Chip'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { PageHeader } from '../../../shared/ui/PageHeader'
import { PageLoader } from '../../../shared/ui/Spinner'
import { cn } from '../../../shared/lib/cn'
import { useServiceStatus, type PlatformTenantStatus, type ServiceAlert, type ServiceStatus } from '../application/service-status.queries'

const dateTime = new Intl.DateTimeFormat('es-BO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const time = new Intl.DateTimeFormat('es-BO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

const roleLabels: Record<string, string> = { frontend: 'Aplicación web', backend: 'API', base: 'Base de datos' }
const planLabels: Record<string, string> = { basico: 'Básico', estandar: 'Estándar', avanzado: 'Avanzado' }
const environmentLabels: Record<string, string> = { production: 'Producción', staging: 'Pruebas' }
const regionLabels: Record<string, string> = { 'us-east-2': 'Ohio', 'us-east-1': 'Virginia del Norte', 'us-west-2': 'Oregón' }

type Overall = { tone: ChipTone; title: string; text: string; icon: ReactNode }

function overall(status: ServiceStatus): Overall {
  const platform = status.platform
  if (status.local.database === 'error') {
    return { tone: 'alert', title: 'Hay un problema', text: 'La API no puede conectarse a la base de datos.', icon: <XCircle className="size-6" /> }
  }
  if (platform?.tenant.state === 'suspended') {
    return { tone: 'warning', title: 'Servicio suspendido', text: 'La plataforma suspendió los servidores de la institución.', icon: <PauseCircle className="size-6" /> }
  }
  if (platform && platform.alerts.length > 0) {
    return { tone: 'warning', title: 'Funcionando con alertas', text: `${platform.alerts.length} alerta(s) activa(s): la plataforma ya fue avisada.`, icon: <TriangleAlert className="size-6" /> }
  }
  if (platform?.tenant.servers.some(server => !server.up)) {
    return { tone: 'warning', title: 'Funcionando con fallas', text: 'Algún servidor no responde al monitoreo.', icon: <TriangleAlert className="size-6" /> }
  }
  return { tone: 'teal', title: 'Todo funciona', text: 'La aplicación, la API y la base de datos responden.', icon: <CheckCircle2 className="size-6" /> }
}

const overallBox: Partial<Record<ChipTone, string>> = {
  teal: 'bg-teal-soft text-teal-ink',
  warning: 'bg-warning-soft text-warning-ink',
  alert: 'bg-alert-soft text-alert-ink',
}

function Meter({ label, value, icon }: { label: string; value?: number; icon: ReactNode }) {
  const tone = value === undefined ? 'bg-line' : value >= 90 ? 'bg-alert' : value >= 80 ? 'bg-warning' : 'bg-brand'
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">{icon}{label}</p>
      <p className="mt-1 text-2xl font-extrabold tabular-nums">{value === undefined ? '—' : `${value}%`}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas" aria-hidden="true">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(value ?? 0, 100)}%` }} />
      </div>
    </div>
  )
}

function Fact({ label, value, bad }: { label: string; value: ReactNode; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className={cn('mt-0.5 font-bold tabular-nums', bad && 'text-alert-ink')}>{value}</dd>
    </div>
  )
}

function AlertRow({ alert }: { alert: ServiceAlert }) {
  const firing = alert.status === 'firing'
  return (
    <li className="flex gap-3 border-b border-line px-5 py-3 last:border-b-0">
      <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', firing ? 'bg-alert' : 'bg-teal')} aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">{firing ? alert.name : `Resuelta: ${alert.name}`}</p>
        {alert.summary && <p className="text-sm text-muted">{alert.summary}</p>}
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
          <Clock3 className="size-3" aria-hidden="true" /> Detectada {dateTime.format(new Date(alert.startedAt))}
          {alert.resolvedAt && <> · resuelta {dateTime.format(new Date(alert.resolvedAt))}</>}
          {alert.server && <> · {alert.server}</>}
        </p>
      </div>
    </li>
  )
}

function PlatformDetails({ platform }: { platform: PlatformTenantStatus }) {
  const t = platform.tenant
  const live = t.state === 'ready' && platform.prometheus === 'ok' && t.monitored
  return <>
    <Card>
      <CardHeader title="Servidores" description={`Plan ${planLabels[t.plan] ?? t.plan} · ${environmentLabels[t.environment] ?? t.environment} · ${regionLabels[t.region] ?? t.region} (AWS)`} />
      <div className="grid gap-4 p-5">
        {t.servers.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-3">
            {t.servers.map(server => (
              <li key={server.server} className="flex items-center gap-3 rounded-xl border border-line p-3">
                <span className={cn('grid size-9 place-items-center rounded-lg', server.up ? 'bg-teal-soft text-teal-ink' : 'bg-alert-soft text-alert-ink')}>
                  <Server className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{roleLabels[server.role ?? ''] ?? server.server}</span>
                  <span className={cn('block text-xs font-semibold', server.up ? 'text-teal-ink' : 'text-alert-ink')}>{server.up ? 'En línea' : 'Sin respuesta'}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">{t.state === 'suspended' ? 'Los servidores están apagados.' : 'Todavía no hay datos de los servidores.'}</p>}
        {live && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Meter label="CPU" value={t.cpu} icon={<Cpu className="size-3.5" />} />
            <Meter label="Memoria" value={t.memory} icon={<MemoryStick className="size-3.5" />} />
            <Meter label="Disco" value={t.disk} icon={<HardDrive className="size-3.5" />} />
          </div>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fact label="Tiempo de respuesta de la API" value={t.latency === undefined ? '—' : `${t.latency} ms`} />
            <Fact label="Peticiones por segundo" value={t.requests ?? '—'} />
            <Fact label="Errores 5xx (15 min)" value={t.errors ?? '—'} bad={Boolean(t.errors)} />
            <Fact label="Conexiones a la base" value={t.connections ?? '—'} />
          </dl>
        </>}
        <p className="text-xs text-muted">Datos del monitoreo de la plataforma · {time.format(new Date(platform.updatedAt))}</p>
      </div>
    </Card>

    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Alertas activas" />
        {platform.alerts.length === 0
          ? <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted"><CheckCircle2 className="size-4 text-teal" /> Sin alertas activas.</p>
          : <ul>{platform.alerts.map(alert => <AlertRow key={alert.id} alert={alert} />)}</ul>}
      </Card>
      <Card>
        <CardHeader title="Eventos recientes (24 h)" />
        {platform.events.length === 0
          ? <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted"><History className="size-4" /> Sin eventos en las últimas 24 horas.</p>
          : <ul className="max-h-80 overflow-y-auto">{platform.events.map(event => <AlertRow key={event.id} alert={event} />)}</ul>}
      </Card>
    </div>
  </>
}

export function ServiceStatusPage() {
  const status = useServiceStatus()
  const data = status.data
  const summary = data ? overall(data) : undefined

  return <>
    <PageHeader
      title="Estado del servicio"
      description="Consulta si la aplicación de tu institución funciona y las alertas recientes."
      actions={<Button variant="secondary" icon={<RefreshCw className={cn('size-4', status.isFetching && 'animate-spin')} />}
        disabled={status.isFetching} onClick={() => void status.refetch()}>Actualizar</Button>}
    />
    {status.isLoading ? <PageLoader /> : !data ? (
      <Card><EmptyState icon={<Activity className="size-6" />} title="No se pudo consultar el estado"
        description={getErrorMessage(status.error, 'Intenta de nuevo en unos segundos.')} /></Card>
    ) : (
      <div className="grid gap-5">
        <div className={cn('flex items-center gap-4 rounded-2xl p-5', overallBox[summary!.tone])} role="status">
          <span className="shrink-0">{summary!.icon}</span>
          <div className="min-w-0">
            <p className="text-lg font-extrabold">{summary!.title}</p>
            <p className="text-sm opacity-85">{summary!.text}</p>
          </div>
          <span className="ml-auto hidden text-xs font-semibold opacity-75 sm:block">Revisado {time.format(new Date(data.checkedAt))}</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Check label="Aplicación web" ok detail="Estás usando esta página" icon={<Activity className="size-4" />} />
          <Check label="API" ok detail="Responde" icon={<Server className="size-4" />} />
          <Check label="Base de datos" ok={data.local.database === 'ok'}
            detail={data.local.database === 'ok' ? `Responde en ${data.local.databaseMs} ms` : 'No responde'} icon={<Database className="size-4" />} />
        </div>

        {data.platform ? <PlatformDetails platform={data.platform} /> : (
          <Card>
            <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted">
              <BellRing className="size-4" /> Los datos del monitoreo de la plataforma no están disponibles en este momento.
            </p>
          </Card>
        )}
      </div>
    )}
  </>
}

function Check({ label, ok, detail, icon }: { label: string; ok: boolean; detail: string; icon: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', ok ? 'bg-teal-soft text-teal-ink' : 'bg-alert-soft text-alert-ink')}>{icon}</span>
      <div className="min-w-0">
        <p className="font-semibold">{label}</p>
        <p className={cn('text-xs font-semibold', ok ? 'text-teal-ink' : 'text-alert-ink')}>{detail}</p>
      </div>
      <Chip tone={ok ? 'teal' : 'alert'} className="ml-auto">{ok ? 'En línea' : 'Falla'}</Chip>
    </div>
  )
}
