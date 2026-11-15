import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CircleAlert, ClipboardList, RefreshCw, Search, X } from 'lucide-react'
import { ApiError, api, errorMessage, type AuditAction, type AuditEvent, type AuditResult } from './api'
import './platform-audit.css'

// Registro de auditoría real: lo escriben el portal (operadores, sitio público) y el
// worker (despliegues, suspensiones, eliminaciones) en la tabla platform_audit.

const actions = {
  login: 'Inicio de sesión',
  logout: 'Cierre de sesión',
  request: 'Recepción de solicitud',
  registration: 'Registro de institución',
  plan: 'Creación de plan',
  invitation: 'Emisión de invitación',
  activation: 'Activación de cuenta',
  deployment: 'Despliegue',
  deletion: 'Eliminación de infraestructura',
  suspension: 'Suspensión',
  resumption: 'Reanudación',
} satisfies Record<AuditAction, string>

const results = {
  started: 'Iniciado',
  completed: 'Completado',
  pending: 'Pendiente',
  failed: 'Fallido',
} satisfies Record<AuditResult, string>

const detailLabels: Record<string, string> = {
  jobId: 'Trabajo', engine: 'Motor', region: 'Región', plan: 'Plan', environment: 'Entorno',
  duration: 'Duración', ip: 'Dirección IP', email: 'Correo', status: 'Estado',
  commit: 'Código (rama y commit)', app: 'Aplicación', template: 'Plantilla', engineVersion: 'Motor',
  ansible: 'Ansible', image: 'Imagen (Packer)', scanners: 'Escáneres',
}

const POLL_MS = 20000

const dateFormat = new Intl.DateTimeFormat('es-BO', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/La_Paz',
})
const timeFormat = new Intl.DateTimeFormat('es-BO', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/La_Paz',
})

function searchable(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function ResultBadge({ result }: { result: AuditResult }) {
  return <span className={`pau-result pau-result-${result}`}>{results[result]}</span>
}

function AuditDetail({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const date = new Date(event.timestamp)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  function close() {
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog ref={dialogRef} className="pau-detail-dialog" aria-labelledby={titleId} onCancel={(event) => {
      event.preventDefault()
      close()
    }}>
      <header className="pau-dialog-header">
        <span className="pau-dialog-icon"><ClipboardList size={21} aria-hidden="true" /></span>
        <div>
          <h2 id={titleId}>Detalle del evento</h2>
          <p>Evento n.º {event.id}</p>
        </div>
        <button type="button" className="pau-dialog-close" onClick={close} aria-label="Cerrar detalle">
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="pau-dialog-body">
        <div className="pau-dialog-summary">
          <h3>{actions[event.action]}</h3>
          <ResultBadge result={event.result} />
          <p>{event.description}</p>
        </div>
        <dl className="pau-dialog-meta">
          <div><dt>{['plan', 'login', 'logout'].includes(event.action) ? 'Recurso' : 'Institución'}</dt><dd>{event.resource}</dd></div>
          {event.reference && <div><dt>Referencia</dt><dd>{event.reference}</dd></div>}
          <div><dt>Actor</dt><dd>{event.actor} · {event.actorRole}</dd></div>
          <div><dt>Fecha y hora</dt><dd><time dateTime={event.timestamp}>{dateFormat.format(date)} · {timeFormat.format(date)}</time></dd></div>
          {Object.entries(event.details ?? {}).filter(([key, value]) => key !== 'steps' && value !== null && value !== undefined && value !== '')
            .map(([key, value]) => <div key={key}><dt>{detailLabels[key] ?? key}</dt><dd>{String(value)}</dd></div>)}
        </dl>
        {Array.isArray(event.details?.steps) && <div className="pau-steps">
          <h4>Pasos</h4>
          <ol>{(event.details.steps as unknown[]).map((step, index) => <li key={index}>{String(step)}</li>)}</ol>
        </div>}
      </div>
      <footer className="pau-dialog-footer">
        <button type="button" className="pau-detail-button" onClick={close}>Cerrar</button>
      </footer>
    </dialog>
  )
}

const platformActions: AuditAction[] = ['plan', 'login', 'logout']

export default function PlatformAudit({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const result = await api<{ events: AuditEvent[] }>('/api/platform/audit')
      setEvents(result.events)
      setError('')
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
      else setError(errorMessage(cause, 'No se pudo cargar el registro de auditoría.'))
    } finally {
      setLoading(false)
      setRefreshing(false)
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

  const institutions = useMemo(() => [...new Set(events.filter(event => !platformActions.includes(event.action) && event.resource).map(event => event.resource))]
    .sort((left, right) => left.localeCompare(right, 'es-BO')), [events])

  const titleId = useId()
  const institutionLabelId = useId()
  const searchInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [institution, setInstitution] = useState('')
  const [action, setAction] = useState<AuditAction | 'all'>('all')
  const [result, setResult] = useState<AuditResult | 'all'>('all')
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent>()
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean)
  const filtering = terms.length > 0 || institution !== '' || action !== 'all' || result !== 'all'

  const visible = events.filter((event) => {
    if (institution && (platformActions.includes(event.action) || event.resource !== institution)) return false
    if (action !== 'all' && action !== event.action) return false
    if (result !== 'all' && result !== event.result) return false
    const text = searchable([
      event.id, actions[event.action], event.description, event.resource, event.reference,
      event.actor, event.actorRole, results[event.result],
      ...Object.values(event.details ?? {}).filter(value => typeof value === 'string'),
    ].join(' '))
    return terms.every((term) => text.includes(term))
  })

  function resetFilters() {
    setQuery('')
    setInstitution('')
    setAction('all')
    setResult('all')
    searchInput.current?.focus()
  }

  return (
    <section className="pau-panel" aria-labelledby={titleId}>
      <div className="pau-header">
        <div>
          <h2 id={titleId}>Registro de eventos</h2>
          <p>Hora de Bolivia</p>
        </div>
        <button type="button" className="pau-clear pau-refresh" onClick={() => void load()} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'pau-spin' : undefined} aria-hidden="true" /> Actualizar
        </button>
      </div>
      {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

      <div className="pau-filters">
        <label className="pau-field">
          <span>Buscar evento</span>
          <span className="pau-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              placeholder="Actor, acción o institución"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
        </label>
        <label className="pau-field">
          <span id={institutionLabelId}>Institución</span>
          <select aria-labelledby={institutionLabelId} value={institution} onChange={(event) => setInstitution(event.target.value)}>
            <option value="">Todas las instituciones</option>
            {institutions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="pau-field">
          <span id="pau-action-label">Acción</span>
          <select aria-labelledby="pau-action-label" value={action} onChange={(event) => setAction(event.target.value as AuditAction | 'all')}>
            <option value="all">Todas las acciones</option>
            {Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="pau-field">
          <span id="pau-result-label">Resultado</span>
          <select aria-labelledby="pau-result-label" value={result} onChange={(event) => setResult(event.target.value as AuditResult | 'all')}>
            <option value="all">Todos los resultados</option>
            {Object.entries(results).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="pau-summary">
        <p role="status" aria-atomic="true">
          {filtering ? `${visible.length} de ${events.length} eventos` : `${events.length} eventos`}
        </p>
        {filtering && <button type="button" className="pau-clear" onClick={resetFilters}>Limpiar filtros</button>}
      </div>

      {loading ? <div className="pau-empty" role="status"><span className="pa-spinner" /><strong>Cargando eventos…</strong></div> : visible.length === 0 ? (
        <div className="pau-empty">
          <span className="pau-empty-icon"><ClipboardList size={22} aria-hidden="true" /></span>
          <strong>{events.length === 0 ? 'Todavía no hay eventos' : 'No hay eventos que coincidan'}</strong>
          <p>{events.length === 0 ? 'Aquí aparecen los accesos, registros, despliegues y suspensiones a medida que ocurren.' : 'Prueba con otros términos o cambia los filtros.'}</p>
        </div>
      ) : (
        <table className="pau-table" aria-labelledby={titleId} role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Acción</th>
              <th scope="col" role="columnheader">Institución o recurso</th>
              <th scope="col" role="columnheader">Actor</th>
              <th scope="col" role="columnheader">Fecha y hora</th>
              <th scope="col" role="columnheader">Resultado</th>
              <th scope="col" role="columnheader">Detalle</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {visible.map((event) => {
              const date = new Date(event.timestamp)
              return (
                <tr key={event.id} role="row">
                  <th className="pau-action" scope="row" role="rowheader">
                    <strong>{actions[event.action]}</strong>
                    <small>{event.description}</small>
                  </th>
                  <td role="cell">
                    <span className="pau-mobile-label" aria-hidden="true">Institución o recurso</span>
                    <strong>{event.resource || '—'}</strong>
                    {event.reference && <small>{event.reference}</small>}
                  </td>
                  <td role="cell">
                    <span className="pau-mobile-label" aria-hidden="true">Actor</span>
                    <strong>{event.actor}</strong>
                    <small>{event.actorRole}</small>
                  </td>
                  <td role="cell">
                    <span className="pau-mobile-label" aria-hidden="true">Fecha y hora</span>
                    <time dateTime={event.timestamp}>
                      {dateFormat.format(date)}<small>{timeFormat.format(date)}</small>
                    </time>
                  </td>
                  <td role="cell">
                    <span className="pau-mobile-label" aria-hidden="true">Resultado</span>
                    <ResultBadge result={event.result} />
                  </td>
                  <td role="cell">
                    <button type="button" className="pau-detail-button" aria-haspopup="dialog"
                      aria-label={`Ver detalle de ${actions[event.action].toLocaleLowerCase('es')} para ${event.resource}, ${results[event.result]}`}
                      onClick={() => setSelectedEvent(event)}>
                      Ver detalle
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {selectedEvent && <AuditDetail event={selectedEvent} onClose={() => setSelectedEvent(undefined)} />}
    </section>
  )
}
