import { randomUUID } from 'node:crypto'
import type { Row, Transaction } from '@libsql/client'
import type { AdminMonitorSnapshot } from './monitor.js'
import { AdminHttpError } from './rbac-storage.js'

export const MAX_RULES = 100
export const ruleSchema = [`CREATE TABLE IF NOT EXISTS admin_monitor_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, metric TEXT NOT NULL,
  threshold REAL NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL DEFAULT 1)`]
export const ruleMetrics = {
  hostCpu: { label: '主机 CPU 使用率', unit: '%', max: 100 },
  hostMemory: { label: '主机内存使用率', unit: '%', max: 100 },
  dataVolume: { label: '数据卷空间使用率', unit: '%', max: 100 },
  engineRss: { label: '引擎进程驻留内存', unit: 'MiB', max: 1073741824 },
  queuePending: { label: '待执行任务数', unit: '项', max: 1000000 },
} as const
export type RuleMetric = keyof typeof ruleMetrics
export interface RuleInput { name: string; metric: RuleMetric; threshold: number; enabled: boolean }
export interface AdminRule extends RuleInput { id: string; revision: number }
export type ArchivedRule = RuleInput & { id: string }
export interface RuleArchive { format: 'aether.monitor-rules'; version: 1; rules: ArchivedRule[] }
const invalid = (message: string): never => { throw new AdminHttpError(400, message, 'invalid_rule') }
const conflict = (message: string): never => { throw new AdminHttpError(409, message, 'rule_conflict') }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every(k => allowed.includes(k))) return invalid('规则格式或字段无效。')
  return value as Record<string, unknown>
}
export function ruleId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) return invalid('规则 ID 无效。')
  return value
}
export function ruleRevision(value: unknown): number {
  const n = typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return invalid('需要有效的规则版本。请刷新后再试。')
  return n
}
function input(body: unknown): RuleInput {
  const f = fields(body, ['name','metric','threshold','enabled'])
  if (typeof f.name !== 'string' || !f.name.trim() || f.name.trim().length > 72 || /[\x00-\x1f\x7f]/.test(f.name)) return invalid('规则名称应为 1–72 个字符。')
  if (typeof f.metric !== 'string' || !Object.hasOwn(ruleMetrics, f.metric)) return invalid('请选择支持的监控指标。')
  const metric = f.metric as RuleMetric
  if (typeof f.threshold !== 'number' || !Number.isFinite(f.threshold) || f.threshold <= 0 || f.threshold > ruleMetrics[metric].max ||
    (metric === 'queuePending' && !Number.isSafeInteger(f.threshold))) return invalid('阈值超出指标范围。')
  if (typeof f.enabled !== 'boolean') return invalid('请选择是否启用规则。')
  return { name: f.name.trim(), metric, threshold: f.threshold, enabled: f.enabled }
}
const toRule = (r: Row): AdminRule => ({ id: String(r.id), name: String(r.name), metric: r.metric as RuleMetric, threshold: Number(r.threshold), enabled: Number(r.enabled) === 1, revision: Number(r.revision) })
export async function listRules(tx: Transaction): Promise<AdminRule[]> {
  return (await tx.execute('SELECT id,name,metric,threshold,enabled,revision FROM admin_monitor_rules ORDER BY name COLLATE NOCASE,id LIMIT 101')).rows.map(toRule)
}
export async function readRule(tx: Transaction, id: string): Promise<AdminRule> {
  const r = (await tx.execute({ sql: 'SELECT * FROM admin_monitor_rules WHERE id=?', args: [ruleId(id)] })).rows[0]
  if (!r) throw new AdminHttpError(404, '规则已删除或不存在。', 'rule_missing')
  return toRule(r)
}
async function room(tx: Transaction, count: number) {
  const n = Number((await tx.execute('SELECT COUNT(*) AS n FROM admin_monitor_rules')).rows[0].n)
  if (n + count > MAX_RULES) conflict('每个实例最多保存 100 条监控规则。')
}
async function unique(tx: Transaction, name: string, id: string) {
  if ((await tx.execute({ sql: 'SELECT 1 FROM admin_monitor_rules WHERE name=? COLLATE NOCASE AND id<>? LIMIT 1', args: [name,id] })).rows.length) conflict('已有同名规则。')
}
async function insert(tx: Transaction, id: string, v: RuleInput): Promise<AdminRule> {
  await unique(tx, v.name, id)
  await tx.execute({ sql: 'INSERT INTO admin_monitor_rules(id,name,metric,threshold,enabled) VALUES (?,?,?,?,?)', args: [id,v.name,v.metric,v.threshold,Number(v.enabled)] })
  return { ...v, id, revision: 1 }
}
export async function newRule(tx: Transaction, body: unknown, id = randomUUID()): Promise<AdminRule> {
  const v = input(body); await room(tx, 1); return insert(tx, id, v)
}
export async function updateRule(tx: Transaction, id: string, body: unknown): Promise<AdminRule> {
  const f = fields(body, ['name','metric','threshold','enabled','revision']), { revision: expected, ...values } = f
  const old = await readRule(tx, id); if (ruleRevision(expected) !== old.revision) conflict('规则已被其他管理员修改，请刷新后再试。')
  if (!Object.keys(values).length) return invalid('没有要更新的字段。')
  const { id: _id, revision: _r, ...original } = old, v = input({ ...original, ...values }); await unique(tx, v.name, id)
  await tx.execute({ sql: 'UPDATE admin_monitor_rules SET name=?,metric=?,threshold=?,enabled=?,revision=revision+1 WHERE id=?', args: [v.name,v.metric,v.threshold,Number(v.enabled),id] })
  return { id,...v,revision: old.revision + 1 }
}
export async function deleteRule(tx: Transaction, id: string, revision: unknown) {
  const old = await readRule(tx, id); if (ruleRevision(revision) !== old.revision) conflict('规则已被其他管理员修改，请刷新后再试。')
  await tx.execute({ sql: 'DELETE FROM admin_monitor_rules WHERE id=?', args: [id] }); return { deleted: true }
}
export function ruleArchive(rules: AdminRule[]): RuleArchive {
  return { format:'aether.monitor-rules', version:1, rules: rules.map(({revision: _r,...rest}) => rest) }
}
export async function restoreRules(tx: Transaction, body: unknown): Promise<{ added: number; unchanged: number }> {
  const f = fields(body, ['format','version','rules']); if (f.format !== 'aether.monitor-rules' || f.version !== 1 || !Array.isArray(f.rules) || f.rules.length > MAX_RULES) return invalid('请选择有效的 Aether 监控规则备份，最多 100 条。')
  const seen = new Set<string>(), rows = new Map((await listRules(tx)).map(x => [x.id,x])), todo: ArchivedRule[] = []
  for (const item of f.rules) {
    const {id: saved,...data} = fields(item,['id','name','metric','threshold','enabled']), id = ruleId(saved), v = input(data)
    if (seen.has(id)) return invalid('备份内含有重复的规则 ID。'); seen.add(id)
    const old = rows.get(id); if (!old) todo.push({id,...v})
    else if (old.name !== v.name || old.metric !== v.metric || old.threshold !== v.threshold || old.enabled !== v.enabled) conflict('备份中的规则与当前版本冲突。没有导入任何规则。')
  }
  await room(tx, todo.length); for (const v of todo) await insert(tx, v.id, v)
  return { added: todo.length, unchanged: seen.size - todo.length }
}
export function evaluateRules(rules: AdminRule[], sample: AdminMonitorSnapshot) {
  const used = (total: number | null, free: number | null): number | null => total !== null && free !== null && total > 0 && free >= 0 && free <= total ? (1-free/total)*100 : null
  const values: Record<RuleMetric,number | null> = { hostCpu: sample.host.cpuPercent, hostMemory: used(sample.host.memoryTotalBytes,sample.host.memoryFreeBytes), dataVolume: sample.dataVolume ? used(sample.dataVolume.totalBytes,sample.dataVolume.availableBytes) : null, engineRss: sample.engine.rssBytes === null ? null : sample.engine.rssBytes/1048576, queuePending: sample.resources.queuePending }
  return { sampledAt: sample.sampledAt, items: rules.map(r => { const value = values[r.metric]; return { id:r.id, revision:r.revision, value: r.enabled ? value : null, state: !r.enabled ? 'disabled' : value === null ? 'unavailable' : value >= r.threshold ? 'triggered' : 'normal' } }) }
}
