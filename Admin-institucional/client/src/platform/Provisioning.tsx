import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Check, CircleAlert, Clock3, ExternalLink, LoaderCircle, Pause, Play, Power, RotateCcw, ServerCog, Trash2, X } from 'lucide-react'
import { ApiError, api, errorMessage, formatDate, webLink, type JobStep, type ProvisioningJob, type TenantConfiguration } from './api'
import { regions } from './tenant-options'
import './provisioning.css'

// Infraestructura de una institución: la crea o la elimina el worker de la plataforma
// (infra/scripts/aprovisionar.sh) y aquí se ven sus pasos y su registro en vivo.

const POLL_MS = 3000

const stepIcons = {
  running: LoaderCircle,
  ok: Check,
  warning: AlertTriangle,
  error: CircleAlert,
} satisfies Record<JobStep['status'], typeof Check>

const verbs = {
  create: { queued: 'En cola para crear', running: 'Creando infraestructura…', succeeded: 'Infraestructura lista', failed: 'La creación falló' },
  delete: { queued: 'En cola para eliminar', running: 'Eliminando infraestructura…', succeeded: 'Infraestructura eliminada', failed: 'La eliminación falló' },
  suspend: { queued: 'En cola para suspender', running: 'Apagando servidores…', succeeded: 'Suspendida', failed: 'La suspensión falló' },
  resume: { queued: 'En cola para reanudar', running: 'Encendiendo servidores…', succeeded: 'Infraestructura lista', failed: 'La reanudación falló' },
} satisfies Record<ProvisioningJob['action'], Record<ProvisioningJob['status'], string>>

function jobLabel(job: ProvisioningJob | null) {
  if (!job) return { text: 'Sin infraestructura', tone: 'idle' }
  const text = verbs[job.action][job.status]
  if (job.status === 'queued' || job.status === 'running') return { text, tone: 'busy' }
  if (job.status === 'failed') return { text, tone: 'error' }
  if (job.action === 'delete') return { text, tone: 'idle' }
  return { text, tone: job.action === 'suspend' ? 'paused' : 'ok' }
}

// Estado de la infraestructura según el último trabajo (igual que el servidor: provisioning.js).
type State = 'none' | 'ready' | 'suspended' | 'failed'
function infrastructureState(job: ProvisioningJob | null): State {
  if (!job) return 'none'
  const ok = job.status === 'succeeded'
  switch (job.action) {
    case 'create': return ok ? 'ready' : 'failed'
    case 'delete': return ok ? 'none' : 'failed'
    case 'suspend': return ok ? 'suspended' : 'ready'
    default: return ok ? 'ready' : 'suspended'
  }
}

export default function Provisioning({ requestId, tenant, onFinished, onActiveChange, onSessionExpired }: {
  requestId: string
  tenant: TenantConfiguration
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

      {job && job.log && <details className="pv-log" open={active}>
        <summary>Registro del trabajo {job.startedAt && <time dateTime={job.startedAt}>· {formatDate(job.startedAt)}</time>}</summary>
        <pre ref={logRef} tabIndex={0} onScroll={event => {
          const log = event.currentTarget
          followLog.current = log.scrollHeight - log.scrollTop - log.clientHeight < 40
        }}>{job.log}</pre>
      </details>}

      {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

      <div className="pa-invite-actions">
        {(canCreate || canRetryCreate) && <button type="button" className="pa-primary" disabled={busy} onClick={() => void start('provision')}>
          {canRetryCreate ? <><RotateCcw size={16} /> Reintentar creación</> : <><Play size={16} /> Crear infraestructura</>}
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

      {confirmDelete && <form className="pa-register-form pv-confirm" onSubmit={event => void start('deprovision', event)} autoComplete="off">
        <p>Se borran la red, los 3 servidores y <strong>los datos de la base</strong> de esta institución. No se puede deshacer.</p>
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
