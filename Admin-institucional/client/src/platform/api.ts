export interface PlanInstance {
  role: 'frontend' | 'backend' | 'database'
  vcpu: number
  ramGib: number
  systemDiskGb: number
  awsType: string
  azureType: string
}

export interface Plan {
  id: string
  name: string
  description: string
  limitStudents: number
  databaseGb: number
  backup: string
  instances: PlanInstance[]
}

export type InvitationStatus = 'pending' | 'sent' | 'failed' | 'activated' | 'preview'

export interface InstallationStatus {
  appUrl?: string
  invitationStatus?: InvitationStatus
  invitationUpdatedAt?: string
}

export interface TenantInfrastructure {
  state: 'none' | 'ready' | 'suspended' | 'failed'
  deleted: boolean
  activeAction?: 'create' | 'delete' | 'suspend' | 'resume'
  lastAction?: 'create' | 'delete' | 'suspend' | 'resume'
  lastStatus?: 'succeeded' | 'failed'
  lastFinishedAt?: string
}

export interface TenantConfiguration extends InstallationStatus {
  id: string
  slug: string
  region: string
  environment: string
  engine: string
  createdAt: string
  networkNumber?: number
  infrastructure?: TenantInfrastructure
}

export interface TrackedRequest {
  id: string
  institutionName: string
  planId: string
  status: 'pending' | 'registered'
  createdAt: string
  updatedAt: string
  tenant?: InstallationStatus
}

export interface TenantRequest extends TrackedRequest {
  adminName: string
  adminEmail: string
  tenant?: TenantConfiguration
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type StepStatus = 'running' | 'ok' | 'warning' | 'error'

export interface JobStep {
  number: number
  title: string
  status: StepStatus
  summary?: string
}

// Un trabajo del worker: crear o eliminar la infraestructura de una institución.
export interface ProvisioningJob {
  id: string
  action: 'create' | 'delete' | 'suspend' | 'resume'
  status: JobStatus
  steps: JobStep[]
  log: string
  result?: { url?: string; motor?: string; previewUrl?: string; invitationStatus?: InvitationStatus; invitationError?: string }
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export type InfrastructureState = 'none' | 'ready' | 'suspended' | 'failed'

export interface MonitoredServer {
  server: string
  role?: string
  up: boolean
}

export interface MonitoringAlert {
  name: string
  tenant?: string
  server?: string
  severity?: string
}

// Estado de una institución: sus trabajos (base de datos) y sus métricas (Prometheus).
export interface MonitoredTenant {
  slug: string
  institutionName: string
  plan: string
  region: string
  engine: string
  environment: string
  appUrl?: string
  invitationStatus?: InvitationStatus
  state: InfrastructureState
  activeAction?: ProvisioningJob['action']
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
  servers: MonitoredServer[]
  alerts?: number
}

export interface MonitoringSnapshot {
  updatedAt: string
  prometheus: 'ok' | 'error' | 'not-configured'
  prometheusError?: string
  grafanaUrl?: string
  platform: MonitoredServer[]
  alerts: MonitoringAlert[]
  tenants: MonitoredTenant[]
}

export type AuditAction = 'login' | 'logout' | 'request' | 'registration' | 'plan' | 'invitation' | 'activation'
  | 'deployment' | 'deletion' | 'suspension' | 'resumption'
export type AuditResult = 'started' | 'completed' | 'pending' | 'failed'

export interface AuditEvent {
  id: string
  timestamp: string
  action: AuditAction
  result: AuditResult
  actor: string
  actorRole: string
  resource: string
  reference: string
  description: string
  details: Record<string, unknown>
}

export interface PlatformUser {
  name: string
  email: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T

  const isJson = response.headers.get('content-type')?.includes('application/json')
  if (!isJson) {
    throw new ApiError('El servicio de plataforma no está disponible. Inténtalo nuevamente.', response.status)
  }

  const data = await response.json()
  if (!response.ok) {
    throw new ApiError(typeof data.message === 'string' ? data.message : 'No se pudo completar la operación.', response.status)
  }
  return data as T
}

export const formatDate = (value: string) => new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value))

export const formatNumber = (value: number) => new Intl.NumberFormat('es-BO').format(value)

export function webLink(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href
  } catch {
    return undefined
  }
  return undefined
}

export function attendanceLoginLink(origin?: string) {
  const href = webLink(origin)
  return href ? new URL('/login', href).href : undefined
}

export const errorMessage = (error: unknown, fallback: string) => (
  error instanceof ApiError && error.status < 500 ? error.message : fallback
)
