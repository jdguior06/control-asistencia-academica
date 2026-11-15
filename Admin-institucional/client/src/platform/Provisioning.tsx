import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDownToLine, Check, CircleAlert, Clock3, Copy, Download, ExternalLink, Layers3, LoaderCircle, Maximize2, Pause, Play,
  Power, RotateCcw, ServerCog, Terminal, Trash2, X,
} from 'lucide-react'
import { ApiError, api, errorMessage, formatDate, webLink, type Plan, type ProvisioningJob, type TenantConfiguration } from './api'
import { engines, optionLabel, regions } from './tenant-options'
import { jobLabel, stepIcons } from './job-labels'
import ChangePlan from './ChangePlan'
import './provisioning.css'

// Infraestructura de una institución: la crea o la elimina el worker de la plataforma
// (infra/scripts/aprovisionar.sh) y aquí se ven sus pasos y su registro en vivo.

const POLL_MS = 3000

// Estado de la infraestructura según el último trabajo (igual que el servidor: provisioning.js).
type State = 'none' | 'ready' | 'suspended' | 'failed'
function infrastructureState(job: ProvisioningJob | null): State {
  if (!job) return 'none'
  const ok = job.status === 'succeeded'
  switch (job.action) {
    case 'create': return ok ? 'ready' : 'failed'
    case 'delete': return ok ? 'none' : 'failed'
    case 'suspend': return ok ? 'suspended' : 'ready'
    case 'resume': return ok ? 'ready' : 'suspended'
    default: return 'ready' // respaldos: no cambian la infraestructura
  }
}

// RF-13: versiones de la app, la plantilla y las herramientas usadas en el trabajo.
function shortDate(iso?: string) {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : ` · ${formatDate(iso)}`
}

function JobVersions({ versions }: { versions: Record<string, string> }) {
  const v = versions
  const rows: [string, string | undefined][] = [
    ['Código', v.repo_commit && `rama ${v.repo_rama ?? '?'} · commit ${v.repo_commit}${shortDate(v.repo_fecha)}`],
    ['Aplicación', (v.app_commit || v.app_desplegada) && `admin-docente-alumno · commit ${v.app_desplegada ?? v.app_commit}${v.app_version ? ` · v${v.app_version}` : ''}${v.app_desplegada ? ' (desplegado)' : ''}`],
    ['Plantilla', v.plantilla && `${v.plantilla} · commit ${v.plantilla_commit ?? '?'}${v.plantilla_hash ? ` · sha256 ${v.plantilla_hash}` : ''}`],
    ['Motor', v.motor_version && `${optionLabel(engines, v.motor ?? '')} ${v.motor_version}${v.proveedor_aws ? ` · proveedor AWS ${v.proveedor_aws}` : ''}`],
    ['Ansible', (v.ansible || v.ansible_commit) && `${v.ansible ? `ansible-core ${v.ansible}` : ''}${v.ansible && v.ansible_commit ? ' · ' : ''}${v.ansible_commit ? `tareas commit ${v.ansible_commit}` : ''}`],
    ['Imagen', v.imagen && (v.imagen_nombre ? `${v.imagen_nombre} (${v.imagen})` : v.imagen)],
    ['AWS CLI', v.aws_cli],
    ['Escáneres', ['checkov', 'trivy', 'gitleaks', 'conftest', 'tflint', 'cfn_lint'].filter(key => v[key]).map(key => `${key.replace('_', '-')} ${v[key]}`).join(' · ') || undefined],
  ]
  return <details className="pv-versions">
    <summary>Versiones usadas en este trabajo</summary>
    <dl>{rows.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </details>
}

// El registro en grande: se actualiza en vivo mientras el trabajo corre.
export function LogDialog({ job, slug, active, onClose }: {
  job: ProvisioningJob
  slug: string
  active: boolean
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const titleId = useId()
  const label = jobLabel(job)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  useEffect(() => {
    const log = logRef.current
    if (log && follow) log.scrollTop = log.scrollHeight
  }, [job.log, follow])

  async function copy() {
    try {
      await navigator.clipboard.writeText(job.log)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([job.log], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${slug}-${job.action}-${(job.startedAt ?? job.createdAt ?? '').slice(0, 16).replace(/[:T]/g, '-') || 'registro'}.log`
    link.click()
    URL.revokeObjectURL(url)
  }

  return <dialog ref={dialogRef} className="pv-log-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="pv-log-dialog-header">
      <span className="pv-log-dialog-icon"><Terminal size={18} aria-hidden="true" /></span>
      <div>
        <h2 id={titleId}>Registro del trabajo · {slug}</h2>
        <p>
          <span className={`pv-badge pv-badge-${label.tone}`}>
            {label.tone === 'busy' ? <LoaderCircle size={12} className="pv-spin" aria-hidden="true" /> : null}{label.text}
          </span>
          {job.startedAt && <time dateTime={job.startedAt}>{formatDate(job.startedAt)}</time>}
          <span>{job.log.split('\n').length} líneas</span>
        </p>
      </div>
      <button type="button" className="pv-log-dialog-close" onClick={onClose} aria-label="Cerrar registro"><X size={18} /></button>
    </header>
    <pre ref={logRef} className="pv-log-dialog-body" tabIndex={0} onScroll={event => {
      const log = event.currentTarget
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40
      if (atEnd !== follow) setFollow(atEnd)
    }}>{job.log}</pre>
    <footer className="pv-log-dialog-footer">
      {active && !follow && <button type="button" className="pa-secondary" onClick={() => setFollow(true)}>
        <ArrowDownToLine size={15} /> Ir al final
      </button>}
      <button type="button" className="pa-secondary" onClick={() => void copy()}>
        {copied ? <><Check size={15} /> Copiado</> : <><Copy size={15} /> Copiar</>}
      </button>
      <button type="button" className="pa-secondary" onClick={download}><Download size={15} /> Descargar .log</button>
      <button type="button" className="pa-primary" onClick={onClose}>Cerrar</button>
    </footer>
  </dialog>
}

const roleLabels = { frontend: 'frontend', backend: 'backend (API)', database: 'base de datos' } as const

const engineState = {
  terraform: (slug: string) => `estado de Terraform (s3://…/tenants/${slug}/terraform.tfstate)`,
  opentofu: (slug: string) => `estado de OpenTofu (s3://…/tenants/${slug}/terraform.tfstate)`,
  pulumi: (slug: string) => `stack de Pulumi "${slug}" (backend S3)`,
  cloudformation: (slug: string) => `stacks de CloudFormation "tenant-${slug}" y "tenant-${slug}-ruta"`,
} as Record<string, (slug: string) => string>

// RF-18: antes de eliminar, la lista concreta de recursos y datos que se borran y lo que se conserva.
function DeletionSummary({ tenant, plan }: { tenant: TenantConfiguration; plan?: Plan }) {
  const network = tenant.networkNumber ? `10.${tenant.networkNumber}.0.0/16` : 'propia'
  const region = optionLabel(regions, tenant.region).split(' (')[0]
  return <div className="pv-delete-summary">
    <p>Se eliminan en <strong>{region}</strong> ({tenant.region}), con <strong>{optionLabel(engines, tenant.engine)}</strong>:</p>
    <ul>
      <li><strong>Red</strong>: VPC {network}, subred, tabla de rutas, internet gateway y grupos de seguridad.</li>
      <li><strong>Conexión con la plataforma</strong>: peering y la ruta de retorno en la VPC de la plataforma.</li>
      <li><strong>3 servidores</strong>:{plan?.instances.length
        ? <ul>{plan.instances.map(instance => <li key={instance.role}>{roleLabels[instance.role]}: {instance.awsType}, disco de {instance.systemDiskGb} GB</li>)}</ul>
        : ' frontend, backend y base de datos, con sus discos.'}</li>
      <li><strong>Datos</strong>: la base de datos PostgreSQL con usuarios, módulos, estudiantes y asistencias (está en el disco del servidor de base de datos).</li>
      <li><strong>Acceso</strong>: la ruta <code>{tenant.slug}.…nip.io</code> del gateway y su monitoreo en Prometheus y Grafana.</li>
      <li><strong>Estado del motor</strong>: {engineState[tenant.engine]?.(tenant.slug) ?? 'el estado del motor'}.</li>
    </ul>
    <p>Se conservan: el registro de la institución en el portal, el historial de trabajos y la auditoría, sus contraseñas archivadas en <code>generado/borrados/</code> del servidor de la plataforma
      y sus <strong>respaldos</strong> en S3 (hasta 90 días): se pueden restaurar si se vuelve a crear la infraestructura.</p>
  </div>
}

export default function Provisioning({ requestId, tenant, plan, plans = [], onFinished, onActiveChange, onSessionExpired }: {
  requestId: string
  tenant: TenantConfiguration
  plan?: Plan
  plans?: Plan[]
  onFinished: () => void
  onActiveChange: (active: boolean) => void
  onSessionExpired: () => void
}) {
  const [job, setJob] = useState<ProvisioningJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [changingPlan, setChangingPlan] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const followLog = useRef(true)
  const active = job?.status === 'queued' || job?.status === 'running'
  const provisionable = !regions.find(option => option.value === tenant.region)?.disabled
  const label = jobLabel(job)

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, fallback))
  }, [onSessionExpired])

  const lastJob = useRef<ProvisioningJob | null>(null)

  useEffect(() => { onActiveChange(active) }, [active, onActiveChange])

  // Consulta el último trabajo; mientras está en curso, repite cada 3 segundos.
  useEffect(() => {
    let alive = true
    const tick = () => api<{ job: ProvisioningJob | null }>(`/api/platform/requests/${encodeURIComponent(requestId)}/job`)
      .then(result => {
        if (!alive) return
        const previous = lastJob.current
        // Al terminar un trabajo se recarga la institución (URL e invitación).
        if (previous && result.job?.id === previous.id && ['queued', 'running'].includes(previous.status)
          && !['queued', 'running'].includes(result.job.status)) onFinished()
        lastJob.current = result.job
        setJob(result.job)
      })
      .catch(cause => { if (alive) handleError(cause, 'No se pudo consultar la infraestructura.') })
      .finally(() => { if (alive) setLoading(false) })
    void tick()
    const timer = active ? window.setInterval(() => { void tick() }, POLL_MS) : undefined
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [requestId, active, onFinished, handleError])

  // El registro baja solo mientras el usuario no haya subido a leer.
  useEffect(() => {
    const log = logRef.current
    if (log && followLog.current) log.scrollTop = log.scrollHeight
  }, [job?.log])

  async function start(action: 'provision' | 'deprovision' | 'suspend' | 'resume', event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = action === 'deprovision' ? { confirm: confirmation.trim() } : {}
      const result = await api<{ job: ProvisioningJob }>(`/api/platform/requests/${encodeURIComponent(requestId)}/${action}`, {
        method: 'POST', body: JSON.stringify(body),
      })
      followLog.current = true
      lastJob.current = result.job
      setJob(result.job)
      setConfirmDelete(false)
      setConfirmation('')
      onFinished() // la lista de instituciones muestra el trabajo en curso
    } catch (cause) {
      handleError(cause, 'No se pudo iniciar el trabajo. Intenta de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  const state = infrastructureState(job)
  const canCreate = provisionable && !active && state === 'none'
  const canRetryCreate = provisionable && !active && job?.action === 'create' && job.status === 'failed'
  const canDelete = !active && state !== 'none'
  const canSuspend = !active && state === 'ready'
  const canResume = !active && (state === 'suspended' || (job?.action === 'suspend' && job.status === 'failed'))
  const url = webLink(job?.result?.url)
  const previewUrl = webLink(job?.result?.previewUrl)

  return <section className="pv" aria-labelledby="pv-title">
    <div className="pa-installation-heading">
      <span className="pa-icon-tile"><ServerCog size={19} aria-hidden="true" /></span>
      <div>
        <h3 id="pv-title">Infraestructura</h3>
        <p>La plataforma crea la red, los 3 servidores y el monitoreo con el motor elegido, y luego invita al administrador.</p>
      </div>
      <span className={`pv-badge pv-badge-${label.tone}`} role="status">
        {label.tone === 'busy' ? <LoaderCircle size={13} className="pv-spin" aria-hidden="true" /> : null}{label.text}
      </span>
    </div>

    {loading ? <p className="pv-note"><LoaderCircle size={14} className="pv-spin" aria-hidden="true" /> Consultando…</p> : <>
      {!provisionable && !job && <p className="pv-note">Azure todavía no está disponible: por ahora la infraestructura se crea en AWS.</p>}

      {job && job.steps.length > 0 && <ol className="pv-steps" aria-label="Pasos del trabajo">
        {job.steps.map(step => {
          const Icon = stepIcons[step.status]
          return <li key={step.number} className={`pv-step pv-step-${step.status}`}>
            <Icon size={15} className={step.status === 'running' ? 'pv-spin' : undefined} aria-hidden="true" />
            <span><strong>{step.number}. {step.title}</strong>{step.summary && <small>{step.summary}</small>}</span>
          </li>
        })}
      </ol>}

      {job?.status === 'queued' && <p className="pv-note"><Clock3 size={14} aria-hidden="true" /> Esperando al worker (los trabajos se ejecutan de a uno).</p>}
      {job?.error && job.status === 'failed' && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{job.error}</span></div>}
      {job?.status === 'succeeded' && job.action === 'create' && <div className="pv-links">
        {url && <a className="pa-installation-link" href={url} target="_blank" rel="noreferrer">{url} <ExternalLink size={14} /></a>}
        {previewUrl && <a className="pa-preview-link" href={previewUrl} target="_blank" rel="noreferrer">Abrir invitación del administrador <ExternalLink size={14} /><small>Vista previa: el correo no se envía en la demo</small></a>}
        {job.result?.invitationError && <p className="pv-note">La invitación no se pudo preparar ({job.result.invitationError}). Puedes reenviarla abajo.</p>}
      </div>}

      {job?.versions && <JobVersions versions={job.versions} />}

      {job && job.log && <details className="pv-log" open={active}>
        <summary>Registro del trabajo {job.startedAt && <time dateTime={job.startedAt}>· {formatDate(job.startedAt)}</time>}</summary>
        <button type="button" className="pv-log-expand" onClick={() => setLogOpen(true)} aria-haspopup="dialog">
          <Maximize2 size={13} aria-hidden="true" /> Ver en grande
        </button>
        <pre ref={logRef} tabIndex={0} title="Doble clic para ver en grande" onDoubleClick={() => setLogOpen(true)} onScroll={event => {
          const log = event.currentTarget
          followLog.current = log.scrollHeight - log.scrollTop - log.clientHeight < 40
        }}>{job.log}</pre>
      </details>}
      {logOpen && job && <LogDialog job={job} slug={tenant.slug} active={active} onClose={() => setLogOpen(false)} />}

      {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

      <div className="pa-invite-actions">
        {(canCreate || canRetryCreate) && <button type="button" className="pa-primary" disabled={busy} onClick={() => void start('provision')}>
          {canRetryCreate ? <><RotateCcw size={16} /> Reintentar creación</> : <><Play size={16} /> Crear infraestructura</>}
        </button>}
        {canSuspend && plan && !changingPlan && <button type="button" className="pa-secondary" disabled={busy} onClick={() => { setChangingPlan(true); setConfirmDelete(false) }}>
          <Layers3 size={15} /> Cambiar plan
        </button>}
        {canSuspend && <button type="button" className="pa-secondary" disabled={busy} onClick={() => void start('suspend')}
          title="Apaga los 3 servidores: no consumen vCPU ni horas de cómputo y los datos se conservan">
          <Pause size={15} /> Suspender
        </button>}
        {canResume && <button type="button" className="pa-primary" disabled={busy} onClick={() => void start('resume')}>
          <Power size={15} /> Reanudar
        </button>}
        {canDelete && !confirmDelete && <button type="button" className="pa-secondary pv-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={15} /> {job?.action === 'delete' ? 'Reintentar eliminación' : 'Eliminar infraestructura'}
        </button>}
      </div>

      {changingPlan && canSuspend && plan && <ChangePlan requestId={requestId} tenant={tenant} plans={plans} currentPlanId={plan.id}
        onCancel={() => setChangingPlan(false)} onSessionExpired={onSessionExpired}
        onStarted={started => {
          followLog.current = true
          lastJob.current = started
          setJob(started)
          setChangingPlan(false)
          onFinished()
        }} />}

      {confirmDelete && <form className="pa-register-form pv-confirm" onSubmit={event => void start('deprovision', event)} autoComplete="off">
        <h4>Antes de eliminar, revisa lo que se borra</h4>
        <DeletionSummary tenant={tenant} plan={plan} />
        <p className="pv-confirm-warning"><strong>No se puede deshacer:</strong> los datos de la base se pierden.</p>
        <label htmlFor="pv-confirm">Escribe <code>{tenant.slug}</code> para confirmar</label>
        <input id="pv-confirm" value={confirmation} onChange={event => setConfirmation(event.target.value)} spellCheck={false} required />
        <div className="pa-invite-actions">
          <button type="submit" className="pa-primary pv-danger-solid" disabled={busy || confirmation.trim() !== tenant.slug}><Trash2 size={15} /> Eliminar</button>
          <button type="button" className="pa-secondary" disabled={busy} onClick={() => { setConfirmDelete(false); setConfirmation('') }}><X size={15} /> Cancelar</button>
        </div>
      </form>}
    </>}
  </section>
}
