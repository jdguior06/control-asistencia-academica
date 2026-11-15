import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, Check, CircleAlert, GitCommitHorizontal, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { ApiError, api, errorMessage, formatDate, type ProvisioningJob, type UpdatePart, type UpdatePreview } from './api'
import './change-plan.css'

// RF-15: actualizar una institución al último commit de la rama. El worker trae el código,
// vuelve a pasar los escaneos y las políticas, aplica el motor (solo cambia lo que cambió en
// las plantillas) y Ansible despliega la app nueva (compila, migra y reinicia).

const POLL_MS = 3000

function commitText(part: UpdatePart, side: 'current' | 'available') {
  const value = side === 'current' ? part.current : part.available?.commit
  return value ?? '—'
}

export default function UpdateTenant({ requestId, onStarted, onCancel, onSessionExpired }: {
  requestId: string
  onStarted: (job: ProvisioningJob) => void
  onCancel: () => void
  onSessionExpired: () => void
}) {
  const [preview, setPreview] = useState<UpdatePreview>()
  const [backupFirst, setBackupFirst] = useState(true)
  const [securityPatches, setSecurityPatches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, fallback))
  }, [onSessionExpired])

  const load = useCallback(() => api<UpdatePreview>(`/api/platform/requests/${encodeURIComponent(requestId)}/update-preview`)
    .then(setPreview)
    .catch(cause => handleError(cause, 'No se pudo consultar la versión disponible.')), [requestId, handleError])

  // Mientras el worker compara con el repositorio, se repite la consulta.
  const checking = preview?.checking ?? true
  useEffect(() => {
    const first = window.setTimeout(() => { void load() }, 0)
    const timer = checking ? window.setInterval(() => { void load() }, POLL_MS) : undefined
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [load, checking])

  // Sin cambios en el repositorio: solo tiene sentido instalar los parches o, para reparar
  // algo cambiado a mano en los servidores, volver a aplicar todo (sin respaldo: la base no cambia).
  const nothingNew = Boolean(preview && !preview.checking && !preview.parts.some(part => part.changed))

  async function send(body: { mode: 'full' | 'patches'; backupFirst?: boolean; securityPatches?: boolean }) {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ job: ProvisioningJob }>(`/api/platform/requests/${encodeURIComponent(requestId)}/update`, {
        method: 'POST', body: JSON.stringify(body),
      })
      onStarted(result.job)
    } catch (cause) {
      handleError(cause, 'No se pudo iniciar la actualización.')
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (nothingNew) {
      if (securityPatches) void send({ mode: 'patches' })
    } else {
      void send({ mode: 'full', backupFirst, securityPatches })
    }
  }

  const changes = preview?.parts.filter(part => part.changed && part.id !== 'scripts').length ?? 0

  return <form className="cp" onSubmit={submit} aria-labelledby="up-title">
    <h4 id="up-title"><RefreshCw size={16} aria-hidden="true" /> Actualizar la versión de la institución</h4>

    {!preview ? <p className="pv-note"><LoaderCircle size={14} className="pv-spin" aria-hidden="true" /> Consultando versiones…</p> : <>
      <p className="up-summary">
        <GitCommitHorizontal size={14} aria-hidden="true" />
        <span>
          Desplegada: <code>{preview.deployed?.commit ?? '—'}</code>{preview.deployed?.at && <> ({formatDate(preview.deployed.at)})</>}
          {' · '}Disponible en <code>{preview.branch ?? 'la rama'}</code>: <code>{preview.latest?.commit ?? '—'}</code>
          {preview.latest?.subject && <small> “{preview.latest.subject}”</small>}
        </span>
      </p>
      {preview.checking && <p className="pv-note"><LoaderCircle size={14} className="pv-spin" aria-hidden="true" /> Comparando con el repositorio…</p>}
      {preview.error && <p className="pv-note"><CircleAlert size={14} aria-hidden="true" /> {preview.error} Se muestra la última comparación.</p>}

      <table className="cp-table">
        <caption>Qué cambió desde el último despliegue{preview.checkedAt && <> · comprobado {formatDate(preview.checkedAt)}</>}</caption>
        <thead><tr><th scope="col">Parte</th><th scope="col">Desplegada</th><th scope="col">Disponible</th></tr></thead>
        <tbody>
          {preview.parts.map(part => <tr key={part.id} className={part.changed ? 'cp-changed' : undefined}>
            <th scope="row">{part.label}</th>
            <td><code>{commitText(part, 'current')}</code></td>
            <td>
              <code>{commitText(part, 'available')}</code>
              <span className={part.changed ? 'cp-tag' : 'cp-tag up-same'}>{part.changed ? 'hay cambios' : 'sin cambios'}</span>
              {part.available?.subject && <small className="up-subject">{part.available.subject}</small>}
            </td>
          </tr>)}
        </tbody>
      </table>

      <p className="pv-note">{nothingNew
        ? <span><strong>Está al día:</strong> no hay cambios en la app, las plantillas ni Ansible desde el último despliegue. Puedes instalar solo los parches de seguridad.</span>
        : changes > 0
          ? `${changes} parte${changes > 1 ? 's' : ''} con cambios${preview.changedFiles ? ` (${preview.changedFiles} archivo${preview.changedFiles > 1 ? 's' : ''} del repositorio)` : ''}.`
          : 'Hay commits nuevos, pero no tocan la app, las plantillas ni Ansible de esta institución.'}</p>

      <fieldset className="up-options">
        <legend>Opciones</legend>
        {!nothingNew && <label><input type="checkbox" checked={backupFirst} onChange={event => setBackupFirst(event.target.checked)} />
          <span><strong>Respaldar antes de actualizar</strong><small>Copia de la base en S3 antes de tocar nada; se puede restaurar desde «Respaldos».</small></span></label>}
        <label><input type="checkbox" checked={securityPatches} onChange={event => setSecurityPatches(event.target.checked)} />
          <span><strong>Instalar también los parches de seguridad del sistema</strong><small><code>dnf upgrade --security</code> en los 3 servidores, sin reiniciarlos (si el kernel lo pide, se avisa en el registro).</small></span></label>
      </fieldset>

      {nothingNew ? <ul className="cp-effects">
        <li>{securityPatches
          ? 'Solo se instalan los parches en los 3 servidores y se verifica la app (1 a 2 minutos): sin escaneos, sin cambios de infraestructura y sin respaldo, porque la base no se toca.'
          : 'Marca los parches para instalarlos. Volver a aplicar todo solo sirve para reparar algo que se cambió a mano en los servidores.'}</li>
      </ul> : <ul className="cp-effects">
        <li>Primero se traen los cambios de la rama y se vuelven a pasar los escaneos de seguridad y las políticas del equipo.</li>
        <li>El motor ({preview.engine}) solo cambia lo que cambió en las plantillas; las políticas rechazan cualquier reemplazo de servidores, así que los datos se conservan.</li>
        <li>Ansible despliega la app nueva (compila, aplica las migraciones y reinicia): la aplicación puede no responder unos segundos.</li>
      </ul>}
    </>}

    {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    <div className="pa-invite-actions">
      {nothingNew
        ? <button type="submit" className="pa-primary" disabled={busy || !securityPatches}>
          {securityPatches ? <><ShieldCheck size={15} /> Instalar parches</> : <><Check size={15} /> Ya está al día</>}
        </button>
        : <button type="submit" className="pa-primary" disabled={busy || !preview || preview.checking}><ArrowRight size={15} /> Actualizar</button>}
      <button type="button" className="pa-secondary" disabled={busy} onClick={onCancel}><X size={15} /> Cancelar</button>
      {nothingNew && <button type="button" className="up-again" disabled={busy}
        title="Escaneos, motor y Ansible otra vez sobre el mismo commit, sin respaldo: sirve para reparar cambios hechos a mano en los servidores"
        onClick={() => void send({ mode: 'full', backupFirst: false, securityPatches })}>
        Volver a aplicar igual
      </button>}
    </div>
  </form>
}
