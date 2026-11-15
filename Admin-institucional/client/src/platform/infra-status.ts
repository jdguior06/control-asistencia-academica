import type { TenantInfrastructure } from './api'

// Estado visible de la infraestructura de una institución: la etiqueta de la lista, el
// filtro por estado (RF-14) y el panel de infraestructura usan los mismos nombres.

export type InfraStatus = 'busy' | 'ready' | 'suspended' | 'failed' | 'deleted' | 'none'

export const infraStatusLabels = {
  busy: 'En curso',
  ready: 'Activa',
  suspended: 'Suspendida',
  failed: 'Con error',
  deleted: 'Infraestructura eliminada',
  none: 'Sin infraestructura',
} satisfies Record<InfraStatus, string>

const busyLabels = {
  create: 'Creando…', delete: 'Eliminando…', suspend: 'Suspendiendo…', resume: 'Reanudando…', backup: 'Respaldando…', restore: 'Restaurando…',
} as const

export function infraStatus(infrastructure?: TenantInfrastructure): InfraStatus {
  if (!infrastructure) return 'none'
  if (infrastructure.activeAction) return 'busy'
  if (infrastructure.state === 'none') return infrastructure.deleted ? 'deleted' : 'none'
  return infrastructure.state
}

export function infraStatusText(infrastructure?: TenantInfrastructure) {
  const status = infraStatus(infrastructure)
  return status === 'busy' && infrastructure?.activeAction ? busyLabels[infrastructure.activeAction] : infraStatusLabels[status]
}
