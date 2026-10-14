export type CronSchedule =
  | { kind: 'interval'; everyMinutes: number; anchorAt: number }
  | { kind: 'calendar'; localTime: string; daysOfWeek?: number[]; timeZone: string }
  | { kind: 'legacy'; expression: string; timeZone: string }
export interface CronConfigurationV2 {
  version: 2
  schedule: CronSchedule
  target: { kind: 'session'; sessionId: string } | { kind: 'standalone' } | { kind: 'workspace'; sourceSessionId: string }
  notificationPolicy: 'all_runs' | 'silent'
  toolProfile: 'general' | 'code'
}
export interface CronPreviewResponse { schedule: CronSchedule; summary: string; nextRunAt: number | null; occurrences: number[] }
export class CronValidationError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'CRON_CONFIGURATION_INVALID') { super(message); this.name = 'CronValidationError' }
}
const minute = 60_000, maximumDate = 8_640_000_000_000_000
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function supportedFields(value: Record<string,unknown>, fields: string[]):void {
  if(Object.keys(value).some(key=>!fields.includes(key)))throw new CronValidationError('Unsupported configuration field')
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CronValidationError(field + ' must be a non-empty string')
  return value.trim()
}
export function localCronTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone }
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone)
  if (!result) {
    try { result = new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
    catch { throw new CronValidationError('timeZone must be a supported IANA time zone') }
    formatters.set(timeZone, result)
    if (formatters.size > 64) formatters.delete(formatters.keys().next().value!)
  }
  return result
}
function validTimeZone(value: unknown): string { const zone = text(value, 'timeZone'); if(/^[+-]/.test(zone))throw new CronValidationError('timeZone must be an IANA zone'); formatter(zone); return zone }
interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }
function localParts(at: number, zone: string): LocalParts {
  const parts = Object.fromEntries(formatter(zone).formatToParts(at).map(part => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) }
}
function dateNumber(value: LocalParts): number { return Date.UTC(value.year, value.month - 1, value.day) }
function sameLocal(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute
}
/** Enumerate nearby zone offsets; absent local times have no candidate, repeated times keep the earliest. */
function earliestLocalInstant(local: LocalParts, zone: string): number | null {
  const nominal = dateNumber(local) + (local.hour * 60 + local.minute) * minute
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = nominal + hours * 3_600_000
    if (probe < 0 || probe > maximumDate) continue
    const actual = localParts(probe, zone)
    offsets.add(dateNumber(actual) + (actual.hour * 60 + actual.minute) * minute - Math.floor(probe / minute) * minute)
  }
  const candidates = [...offsets].map(offset => nominal - offset)
    .filter(at => at >= 0 && at <= maximumDate && sameLocal(localParts(at, zone), local)).sort((a,b) => a-b)
  return candidates[0] ?? null
}

interface LegacyFields { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number> }
const legacyCache = new Map<string, LegacyFields>()
function fieldValues(field: string, minimum: number, maximum: number): Set<number> {
  for (const segment of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(segment)
    if (!match) throw new CronValidationError('Unsupported legacy cron field: ' + field)
    const step = match[2] === undefined ? 1 : Number(match[2])
    if (!Number.isSafeInteger(step) || step < 1) throw new CronValidationError('Invalid cron step: ' + field)
    const bounds = match[1] === '*' ? [minimum, maximum] : match[1].split('-').map(Number)
    const start = bounds[0], end = bounds[1] ?? bounds[0]
    if (start < minimum || end > maximum || start > end) throw new CronValidationError('Cron field outside supported range: ' + field)
  }
  const values = new Set<number>()
  // Preserve the existing matcher's branch priority and slash semantics;
  // legacy expressions are not silently converted into a different cron dialect.
  const step = field.includes('/') ? Number.parseInt(field.split('/')[1],10) : undefined
  for (let value=minimum;value<=maximum;value++) {
    const bounds = field.split('-').map(Number)
    if (field==='*' || (step!==undefined ? value%step===0
      :field.includes(',') ? field.split(',').map(Number).includes(value)
      :field.includes('-') ? value>=bounds[0]&&value<=bounds[1]
      :Number.parseInt(field,10)===value)) values.add(value)
  }
  if (!values.size) throw new CronValidationError('Cron field selects no valid values')
  return values
}
function legacyFields(expression: string): LegacyFields {
  const cached = legacyCache.get(expression)
  if (cached) return cached
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new CronValidationError('legacy expression must have five cron fields')
  const result = { minute: fieldValues(fields[0],0,59), hour: fieldValues(fields[1],0,23), day: fieldValues(fields[2],1,31),
    month: fieldValues(fields[3],1,12), weekday: fieldValues(fields[4],0,6) }
  legacyCache.set(expression,result)
  if (legacyCache.size > 128) legacyCache.delete(legacyCache.keys().next().value!)
  return result
}
function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximumDate) throw new CronValidationError(field + ' must be a valid epoch-millisecond integer')
  return value
}
export function normalizeCronSchedule(value: unknown, options: { allowInvalidLegacy?: boolean } = {}): CronSchedule {
  if (!object(value)) throw new CronValidationError('schedule is required')
  if (value.kind === 'interval') {
    supportedFields(value,['kind','everyMinutes','anchorAt'])
    if (typeof value.everyMinutes !== 'number' || !Number.isSafeInteger(value.everyMinutes) || value.everyMinutes <= 0 || value.everyMinutes > Math.floor(Number.MAX_SAFE_INTEGER / minute))
      throw new CronValidationError('everyMinutes must be a positive safe whole number of minutes')
    return { kind: 'interval', everyMinutes: value.everyMinutes, anchorAt: Math.floor(timestamp(value.anchorAt,'anchorAt') / minute) * minute }
  }
  if (value.kind === 'calendar') {
    supportedFields(value,['kind','localTime','daysOfWeek','timeZone'])
    const localTime = text(value.localTime,'localTime')
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new CronValidationError('localTime must use HH:mm')
    let daysOfWeek: number[] | undefined
    if (value.daysOfWeek !== undefined) {
      if (!Array.isArray(value.daysOfWeek) || !value.daysOfWeek.length || value.daysOfWeek.some(day => !Number.isInteger(day) || day < 0 || day > 6))
        throw new CronValidationError('daysOfWeek must select weekdays from 0 to 6')
      daysOfWeek = [...new Set<number>(value.daysOfWeek)].sort((a,b)=>a-b)
    }
    return { kind: 'calendar', localTime, timeZone: validTimeZone(value.timeZone), ...(daysOfWeek ? { daysOfWeek } : {}) }
  }
  if (value.kind === 'legacy') {
    supportedFields(value,['kind','expression','timeZone'])
    const expression = text(value.expression,'expression')
    if (!options.allowInvalidLegacy) legacyFields(expression)
    return { kind: 'legacy', expression, timeZone: validTimeZone(value.timeZone) }
  }
  throw new CronValidationError('Unsupported schedule kind')
}
export function normalizeCronConfiguration(value: unknown, options: { allowInvalidLegacy?: boolean } = {}): CronConfigurationV2 {
  if (!object(value) || value.version !== 2 || !object(value.target)) throw new CronValidationError('configuration.version must be 2 and target is required')
  supportedFields(value,['version','schedule','target','notificationPolicy','toolProfile'])
  supportedFields(value.target,value.target.kind==='session'?['kind','sessionId']:value.target.kind==='workspace'?['kind','sourceSessionId']:['kind'])
  let target: CronConfigurationV2['target']
  if (value.target.kind === 'session') target = { kind: 'session', sessionId: text(value.target.sessionId,'target.sessionId') }
  else if (value.target.kind === 'standalone') target = { kind: 'standalone' }
  else if (value.target.kind === 'workspace') target = { kind: 'workspace', sourceSessionId: text(value.target.sourceSessionId,'target.sourceSessionId') }
  else throw new CronValidationError('Unsupported target kind')
  if (value.notificationPolicy !== 'all_runs' && value.notificationPolicy !== 'silent') throw new CronValidationError('Unsupported notificationPolicy')
  if (value.toolProfile !== 'general' && value.toolProfile !== 'code') throw new CronValidationError('Unsupported toolProfile')
  return { version:2, schedule:normalizeCronSchedule(value.schedule,options), target,
    notificationPolicy:value.notificationPolicy,toolProfile:value.toolProfile }
}

export function nextOccurrence(schedule: CronSchedule, after: number): number | null {
  after = timestamp(after,'after')
  const normalized = normalizeCronSchedule(schedule)
  if (normalized.kind === 'interval') {
    const period = normalized.everyMinutes * minute
    const next = normalized.anchorAt + Math.max(0,Math.floor((after-normalized.anchorAt)/period)+1)*period
    return Number.isSafeInteger(next) && next <= maximumDate ? next : null
  }
  if (normalized.kind === 'calendar') {
    const from = localParts(after,normalized.timeZone), [hour,min] = normalized.localTime.split(':').map(Number)
    for (let day = 0; day < 15; day++) {
      const date = new Date(dateNumber(from)+day*86_400_000)
      if (!Number.isFinite(date.getTime())) return null
      if (normalized.daysOfWeek && !normalized.daysOfWeek.includes(date.getUTCDay())) continue
      const next = earliestLocalInstant({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),hour,minute:min},normalized.timeZone)
      if (next !== null && next > after) return next
    }
    return null
  }
  const fields = legacyFields(normalized.expression), from = localParts(after,normalized.timeZone)
  const hours = [...fields.hour].sort((a,b)=>a-b), minutes = [...fields.minute].sort((a,b)=>a-b)
  // Gregorian dates and weekdays repeat in 400 years, including leap-day/weekday intersections.
  // Filter whole dates first instead of blocking previews on millions of minute probes.
  for (let day=0;day<=146_097;day++) {
    const date=new Date(dateNumber(from)+day*86_400_000)
    if (!Number.isFinite(date.getTime())) return null
    if (!fields.month.has(date.getUTCMonth()+1) || !fields.day.has(date.getUTCDate()) || !fields.weekday.has(date.getUTCDay())) continue
    for (const hour of hours) for (const min of minutes) {
      if (day===0 && hour*60+min<=from.hour*60+from.minute) continue
      const next=earliestLocalInstant({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),hour,minute:min},normalized.timeZone)
      if (next!==null && next>after) return next
    }
  }
  return null
}
export function summarizeCronSchedule(schedule: CronSchedule): string {
  const value=normalizeCronSchedule(schedule)
  if(value.kind==='interval')return '每 '+value.everyMinutes+' 分钟'
  if(value.kind==='legacy')return value.expression+' · '+value.timeZone
  const week=['日','一','二','三','四','五','六']
  const days=value.daysOfWeek?.map(day=>week[day]).join('、')
  return (days?'星期'+days:'每天')+' '+value.localTime+' · '+value.timeZone
}
export function previewCronSchedule(schedule: CronSchedule, after=Date.now(), count=5): CronPreviewResponse {
  if(!Number.isInteger(count)||count<1||count>20)throw new CronValidationError('count must be from 1 to 20')
  const normalized=normalizeCronSchedule(schedule),occurrences:number[]=[]
  let cursor=timestamp(after,'after')
  for(let index=0;index<count;index++) {const next=nextOccurrence(normalized,cursor);if(next===null)break;occurrences.push(next);cursor=next}
  return {schedule:normalized,summary:summarizeCronSchedule(normalized),nextRunAt:occurrences[0]??null,occurrences}
}
