import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArchiveRestore, CircleAlert, Clock3, DatabaseBackup, LoaderCircle, Maximize2, RotateCcw, X } from 'lucide-react'
import { ApiError, api, errorMessage, formatDate, type BackupsInfo, type TenantBackup, type TenantConfiguration } from './api'
import { jobLabel, stepIcons } from './job-labels'
import { LogDialog } from './Provisioning'
import { infraStatus } from './infra-status'
import './backups.css'

// Respaldos de la base de datos de una institución (RF-19): el worker hace pg_dump y lo
// guarda en S3. Se pueden pedir a mano o se hacen solos según el plan (semanal o diario).

const POLL_MS = 3000

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function every(hours: number) {
  return hours % 24 === 0 ? (hours / 24 === 1 ? 'cada día' : `cada ${hours / 24} días`) : `cada ${hours} h`
}

export default function Backups({ requestId, tenant, onSessionExpired }: {
  requestId: string
  tenant: TenantConfiguration
  onSessionExpired: () => void
}) {
  const [info, setInfo] = useState<BackupsInfo>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState<TenantBackup>()
  const [confirmation, setConfirmation] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const job = info?.job ?? null
  const active = job?.status === 'queued' || job?.status === 'running'
  const infraReady = infraStatus(tenant.infrastructure) === 'ready'

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, fallback))
  }, [onSessionExpired])

  const load = useCallback(() => api<BackupsInfo>(`/api/platform/requests/${encodeURIComponent(requestId)}/backups`)
    .then(result => setInfo(result))
    .catch(cause => handleError(cause, 'No se pudieron consultar los respaldos.')), [requestId, handleError])

  useEffect(() => {
    const first = window.setTimeout(() => { void load() }, 0)
    const timer = active ? window.setInterval(() => { void load() }, POLL_MS) : undefined
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [load, active])

  async function backup() {
    setBusy(true)
    setError('')
    try {
      await api(`/api/platform/requests/${encodeURIComponent(requestId)}/backup`, { method: 'POST', body: '{}' })
      await load()
    } catch (cause) {
      handleError(cause, 'No se pudo iniciar el respaldo.')
    } finally {
      setBusy(false)
    }
  }

  async function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!restoring) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/platform/requests/${encodeURIComponent(requestId)}/restore`, {
        method: 'POST', body: JSON.stringify({ backupId: restoring.id, confirm: confirmation.trim() }),
      })
      setRestoring(undefined)
      setConfirmation('')
      await load()
    } catch (cause) {
      handleError(cause, 'No se pudo iniciar la restauración.')
    } finally {
      setBusy(false)
    }
  }

  const label = jobLabel(job)

  return <section className="bk" aria-labelledby="bk-title">
    <div className="pa-installation-heading">
      <span className="pa-icon-tile"><DatabaseBackup size={19} aria-hidden="true" /></span>
      <div>
        <h3 id="bk-title">Respaldos de la base de datos</h3>
        <p>{info?.policy
          ? <>Plan: respaldo {info.policy.label.toLocaleLowerCase('es')} automático ({every(info.policy.everyHours)}), se conservan los últimos {info.policy.keep}. Se guardan cifrados en S3.</>
          : 'Copias de la base de datos (pg_dump) guardadas en S3.'}</p>
      </div>
      {job && <span className={`pv-badge pv-badge-${label.tone}`} role="status">
        {active && <LoaderCircle size={13} className="pv-spin" aria-hidden="true" />}{label.text}
      </span>}
    </div>

    {job && active && job.steps.length > 0 && <ol className="pv-steps" aria-label="Pasos del respaldo">
      {job.steps.map(step => {
        const Icon = stepIcons[step.status]
        return <li key={step.number} className={`pv-step pv-step-${step.status}`}>
          <Icon size={15} className={step.status === 'running' ? 'pv-spin' : undefined} aria-hidden="true" />
          <span><strong>{step.number}. {step.title}</strong>{step.summary && <small>{step.summary}</small>}</span>
        </li>
      })}
    </ol>}
    {job?.status === 'failed' && job.error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{job.error}</span></div>}
    {job?.log && <button type="button" className="bk-link" onClick={() => setLogOpen(true)}>
      <Maximize2 size={13} aria-hidden="true" /> {job.action === 'restore' ? 'Registro de la última restauración' : 'Registro del último respaldo'}
      {job.startedAt && <> · {formatDate(job.startedAt)}</>}
    </button>}

    {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

    <div className="pa-invite-actions">
      <button type="button" className="pa-secondary" disabled={busy || active || !infraReady} onClick={() => void backup()}
        title={infraReady ? undefined : 'Necesita la infraestructura lista y encendida'}>
        <DatabaseBackup size={15} /> Respaldar ahora
      </button>
    </div>
    {!infraReady && <p className="pv-note">Los respaldos necesitan la infraestructura lista y encendida.</p>}

    {info && (info.backups.length === 0
      ? <p className="pv-note"><Clock3 size={14} aria-hidden="true" /> Todavía no hay respaldos.</p>
      : <ul className="bk-list" aria-label="Respaldos disponibles">
        {info.backups.map(item => <li key={item.id}>
          <div>
            <strong>{formatDate(item.createdAt)}</strong>
            <small>{size(item.bytes)} · {item.kind === 'manual' ? 'manual' : 'programado'}</small>
          </div>
          <button type="button" className="pa-secondary" disabled={busy || active || !infraReady}
            onClick={() => { setRestoring(item); setConfirmation(''); setError('') }}>
            <ArchiveRestore size={14} /> Restaurar
          </button>
        </li>)}
      </ul>)}

    {restoring && <form className="pa-register-form pv-confirm" onSubmit={event => void restore(event)} autoComplete="off">
      <h4>Restaurar el respaldo del {formatDate(restoring.createdAt)}</h4>
      <p>La base de datos de la institución vuelve a como estaba en ese momento: <strong>se pierde todo lo registrado después</strong>{' '}
        (docentes, módulos, estudiantes y asistencias nuevos). La copia se carga primero en una base aparte; si falla, la actual no se toca.
        La aplicación se detiene unos segundos al final.</p>
      <label htmlFor="bk-confirm">Escribe <code>{tenant.slug}</code> para confirmar</label>
      <input id="bk-confirm" value={confirmation} onChange={event => setConfirmation(event.target.value)} spellCheck={false} required />
      <div className="pa-invite-actions">
        <button type="submit" className="pa-primary pv-danger-solid" disabled={busy || confirmation.trim() !== tenant.slug}><RotateCcw size={15} /> Restaurar</button>
        <button type="button" className="pa-secondary" disabled={busy} onClick={() => setRestoring(undefined)}><X size={15} /> Cancelar</button>
      </div>
    </form>}

    {logOpen && job && <LogDialog job={job} slug={tenant.slug} active={active} onClose={() => setLogOpen(false)} />}
  </section>
}
