import { useQuery } from '@tanstack/react-query'
import { http } from '../../../core/http/http-client'

// Estado de los servicios de la institución (GET /admin/service-status): lo que comprueba
// la propia API y lo que informa la plataforma (servidores, métricas y alertas).

export interface ServiceAlert {
  id: string
  name: string
  server?: string
  severity?: string
  summary?: string
  status: 'firing' | 'resolved'
  startedAt: string
  resolvedAt?: string
}

export interface ServiceServer {
  server: string
  role?: string
  up: boolean
}

export interface PlatformTenantStatus {
  updatedAt: string
  prometheus: 'ok' | 'error' | 'not-configured'
  tenant: {
    slug: string
    institutionName: string
    plan: string
    region: string
    environment: string
    state: 'none' | 'ready' | 'suspended' | 'failed'
    activeAction?: string
    monitored?: boolean
    api?: boolean
    agentsUp?: number
    agentsTotal?: number
    cpu?: number
    memory?: number
    disk?: number
    requests?: number
    latency?: number
    connections?: number
    errors?: number
    servers: ServiceServer[]
  }
  alerts: ServiceAlert[]
  events: ServiceAlert[]
}

export interface ServiceStatus {
  checkedAt: string
  local: { api: 'ok'; database: 'ok' | 'error'; databaseMs: number }
  platform: PlatformTenantStatus | null
  platformError?: string
}

export function useServiceStatus() {
  return useQuery({
    queryKey: ['service-status'],
    queryFn: async () => (await http.get<ServiceStatus>('/admin/service-status')).data,
    refetchInterval: 30_000,
  })
}
