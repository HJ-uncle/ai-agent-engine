export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id?: string      // auto-generated if not provided
  type: string
  payload: Record<string, unknown>
  tenantId?: string
}

export interface JobRecord {
  id: string
  tenantId: string
  type: string
  payload: Record<string, unknown>
  status: JobStatus
  result?: unknown
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
}

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<unknown>

export interface TaskQueue {
  enqueue(job: Job): Promise<string>
  getStatus(jobId: string, tenantId: string): Promise<JobRecord | null>
  cancel(jobId: string, tenantId: string): Promise<boolean>
  registerHandler(type: string, handler: JobHandler): void
  start(): void
  stop(): Promise<void>
}
