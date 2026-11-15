import { AlertTriangle, Check, CircleAlert, LoaderCircle } from 'lucide-react'
import type { JobStep, ProvisioningJob } from './api'

// Nombres y colores de los trabajos del worker (infraestructura y respaldos).

export const stepIcons = {
  running: LoaderCircle,
  ok: Check,
  warning: AlertTriangle,
  error: CircleAlert,
} satisfies Record<JobStep['status'], typeof Check>

export const verbs = {
  create: { queued: 'En cola para crear', running: 'Creando infraestructura…', succeeded: 'Infraestructura lista', failed: 'La creación falló' },
  delete: { queued: 'En cola para eliminar', running: 'Eliminando infraestructura…', succeeded: 'Infraestructura eliminada', failed: 'La eliminación falló' },
  suspend: { queued: 'En cola para suspender', running: 'Apagando servidores…', succeeded: 'Suspendida', failed: 'La suspensión falló' },
  resume: { queued: 'En cola para reanudar', running: 'Encendiendo servidores…', succeeded: 'Infraestructura lista', failed: 'La reanudación falló' },
  backup: { queued: 'Respaldo en cola', running: 'Respaldando la base…', succeeded: 'Respaldo guardado', failed: 'El respaldo falló' },
  restore: { queued: 'Restauración en cola', running: 'Restaurando la base…', succeeded: 'Base restaurada', failed: 'La restauración falló' },
  change_plan: { queued: 'Cambio de plan en cola', running: 'Cambiando el plan…', succeeded: 'Plan cambiado', failed: 'El cambio de plan falló' },
  update: { queued: 'Actualización en cola', running: 'Actualizando…', succeeded: 'Actualizada', failed: 'La actualización falló' },
} satisfies Record<ProvisioningJob['action'], Record<ProvisioningJob['status'], string>>

// Actualizar con el tenant ya al día: solo los parches de seguridad.
const patchVerbs = {
  queued: 'Parches en cola', running: 'Instalando parches…', succeeded: 'Parches instalados', failed: 'Los parches fallaron',
} satisfies Record<ProvisioningJob['status'], string>

export function jobLabel(job: ProvisioningJob | null) {
  if (!job) return { text: 'Sin infraestructura', tone: 'idle' }
  const text = job.action === 'update' && job.mode === 'patches' ? patchVerbs[job.status] : verbs[job.action][job.status]
  if (job.status === 'queued' || job.status === 'running') return { text, tone: 'busy' }
  if (job.status === 'failed') return { text, tone: 'error' }
  if (job.action === 'delete') return { text, tone: 'deleted' }
  return { text, tone: job.action === 'suspend' ? 'paused' : 'ok' }
}

