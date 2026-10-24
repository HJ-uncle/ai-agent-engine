import type { ExternalSkill } from '../skills/external-loader.js'

/** Advertise only capabilities admitted by this request's actual registry. */
export function buildOfficeExecutionPrompt(profile: string, registry: { has(name: string): boolean }, skills: readonly ExternalSkill[]): string {
  if (profile !== 'general' || !registry.has('office_document')) return ''
  const guide = registry.has('get_skill') && skills.some(skill => skill.enabled && skill.name.toLowerCase() === 'aether-office')
    ? 'Word/Excel 创建与编辑先用 get_skill 读取 aether-office；模式细节通过它的 references 资源按需读取。'
    : '按 office_document 的真实参数和校验回执完成 Word/Excel 交付。'
  const environment = registry.has('office_environment')
    ? '\n需要 Python、公式重算或源格式转换时，先用 office_environment({}) 查看受信任的环境和缺项。COM 注册只是候选，不代表转换已验证。禁止全局/--user 安装；依赖只放本任务独立 venv。环境与 COM 探测必须有限 timeoutMs，超时后只取消本任务命令，禁止按名称全局终止 WPS/Office。'
    : ''
  return `\n\n## 办公文件交付\n${guide}${environment}\n已有 read_file 办公读取能力继续可用。办公写入优先 office_document：create 使用 expectedHash="missing"，已有文件先 inspect 并用真实 sha256 版本定点 edit，发生冲突重新检查而非覆盖。多表分批用 append_sheets，每次优先一张新表并复用最新 hash；禁止为补表删除重建或整包重发。追加保留旧公式缓存但未重算，不能拿它当最新结果。用户已要求生成/修改就完成真实文件交付，不额外等待导出确认。不编造缺失信息，不用 Markdown/CSV 改扩展名冒充 Office。成功回执后才提供真实文件链接；结构检查、视觉排版验证与公式计算是不同事实，按实际结果说明 warnings 和未验证项。`
}
