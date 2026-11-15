import { useState, type FormEvent } from 'react'
import { ArrowRight, CircleAlert, Layers3, X } from 'lucide-react'
import { ApiError, api, errorMessage, formatNumber, type Plan, type ProvisioningJob, type TenantConfiguration } from './api'
import './change-plan.css'

// RF-06: cambiar el plan de una institución mostrando antes qué recursos se modifican.
// El worker vuelve a aplicar el motor con el plan nuevo: solo cambia lo necesario.

const PROVISIONABLE = ['basico', 'estandar', 'avanzado']
const roles = { frontend: 'Frontend', backend: 'Backend (API)', database: 'Base de datos' } as const

export default function ChangePlan({ requestId, tenant, plans, currentPlanId, onStarted, onCancel, onSessionExpired }: {
  requestId: string
  tenant: TenantConfiguration
  plans: Plan[]
  currentPlanId: string
  onStarted: (job: ProvisioningJob) => void
  onCancel: () => void
  onSessionExpired: () => void
}) {
  const choices = plans.filter(plan => PROVISIONABLE.includes(plan.id) && plan.id !== currentPlanId)
  const [planId, setPlanId] = useState(choices[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = plans.find(plan => plan.id === currentPlanId)
  const next = plans.find(plan => plan.id === planId)

  const currentDisk = tenant.diskGb ?? current?.instances.find(item => item.role === 'database')?.systemDiskGb ?? 0
  const planDisk = next?.instances.find(item => item.role === 'database')?.systemDiskGb ?? currentDisk
  const cloudformation = tenant.engine === 'cloudformation'
  const newDisk = cloudformation ? currentDisk : Math.max(currentDisk, planDisk)

  const rows = (['frontend', 'backend', 'database'] as const).map(role => {
    const from = current?.instances.find(item => item.role === role)
    const to = next?.instances.find(item => item.role === role)
    return { role, from, to, typeChanges: Boolean(from && to && from.awsType !== to.awsType) }
  })
  const restarts = rows.filter(row => row.typeChanges).length

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await api<{ job: ProvisioningJob }>(`/api/platform/requests/${encodeURIComponent(requestId)}/plan`, {
        method: 'POST', body: JSON.stringify({ planId }),
      })
      onStarted(result.job)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
      else setError(errorMessage(cause, 'No se pudo iniciar el cambio de plan.'))
    } finally {
      setBusy(false)
    }
  }

  return <form className="cp" onSubmit={event => void submit(event)} aria-labelledby="cp-title">
    <h4 id="cp-title"><Layers3 size={16} aria-hidden="true" /> Cambiar el plan de {current?.name ?? currentPlanId}</h4>
    {choices.length === 0 ? <p className="pv-note">No hay otros planes con infraestructura definida.</p> : <>
      <label className="cp-field">
        <span>Plan nuevo</span>
        <select value={planId} onChange={event => setPlanId(event.target.value)}>
          {choices.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
        </select>
      </label>

      {next && <>
        <table className="cp-table">
          <caption>Qué recursos se modifican</caption>
          <thead><tr><th scope="col">Servidor</th><th scope="col">Ahora</th><th scope="col">Con {next.name}</th></tr></thead>
          <tbody>
            {rows.map(({ role, from, to, typeChanges }) => <tr key={role} className={typeChanges ? 'cp-changed' : undefined}>
              <th scope="row">{roles[role]}</th>
              <td>{from ? `${from.awsType} · ${from.ramGib} GB RAM` : '—'}</td>
              <td>{to ? <>{to.awsType} · {to.ramGib} GB RAM{typeChanges ? <span className="cp-tag">cambia</span> : null}</> : '—'}</td>
            </tr>)}
            <tr className={newDisk !== currentDisk ? 'cp-changed' : undefined}>
              <th scope="row">Disco de cada servidor</th>
              <td>{currentDisk} GB</td>
              <td>{newDisk} GB{newDisk !== currentDisk ? <span className="cp-tag">crece</span> : null}</td>
            </tr>
            <tr className={current?.limitStudents !== next.limitStudents ? 'cp-changed' : undefined}>
              <th scope="row">Límite de estudiantes</th>
              <td>{formatNumber(current?.limitStudents ?? 0)}</td>
              <td>{formatNumber(next.limitStudents)}</td>
            </tr>
            <tr className={current?.backup !== next.backup ? 'cp-changed' : undefined}>
              <th scope="row">Respaldo automático</th>
              <td>{current?.backup}</td>
              <td>{next.backup}</td>
            </tr>
          </tbody>
        </table>

        <ul className="cp-effects">
          <li>{restarts > 0
            ? <><strong>{restarts} servidor{restarts > 1 ? 'es se apagan' : ' se apaga'} y {restarts > 1 ? 'encienden' : 'enciende'}</strong> para cambiar de tipo: la aplicación no responde durante unos minutos.</>
            : 'Ningún servidor cambia de tipo: no hay corte de servicio.'}</li>
          <li>Los datos se conservan: los servidores no se reemplazan (las políticas del equipo rechazan cualquier reemplazo).</li>
          {cloudformation
            ? <li>Con CloudFormation el disco <strong>no cambia</strong>: cambiarlo reemplazaría el servidor.</li>
            : planDisk < currentDisk ? <li>El disco <strong>no se achica</strong> (AWS no lo permite): queda en {currentDisk} GB.</li> : null}
          <li>Después, Ansible vuelve a aplicar la configuración (por ejemplo, el nuevo límite de estudiantes). Se recomienda respaldar antes.</li>
        </ul>
      </>}

      {error && <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
      <div className="pa-invite-actions">
        <button type="submit" className="pa-primary" disabled={busy || !next}><ArrowRight size={15} /> Cambiar a {next?.name ?? 'otro plan'}</button>
        <button type="button" className="pa-secondary" disabled={busy} onClick={onCancel}><X size={15} /> Cancelar</button>
      </div>
    </>}
  </form>
}
