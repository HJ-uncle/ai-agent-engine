import type { ExternalSkill } from '../skills/external-loader.js'

/** Advertise only capabilities admitted by this request's actual registry. */
export function buildOfficeExecutionPrompt(profile: string, registry: { has(name: string): boolean }, skills: readonly ExternalSkill[]): string {
  if (profile !== 'general' || !registry.has('office_document')) return ''
  const guide = registry.has('get_skill') && skills.some(skill => skill.enabled && skill.name.toLowerCase() === 'aether-office')
    ? 'Word/Excel 创建与编辑先用 get_skill 读取 aether-office；模式细节通过它的 references 资源按需读取。'
    : '按 office_document 的真实参数和校验回执完成 Word/Excel 交付。'
  return `\n\n## 办公文件交付\n${guide}\n已有 read_file 办公读取能力继续可用。办公写入优先 office_document：create 使用 expectedHash="missing"，已有文件先 inspect 并用真实 sha256 版本定点 edit，发生冲突重新检查而非覆盖。用户已要求生成/修改就完成真实文件交付，不额外等待导出确认。不编造缺失信息，不用 Markdown/CSV 改扩展名冒充 Office。成功回执后才提供真实文件链接；结构检查、视觉排版验证与公式计算是不同事实，按实际结果说明 warnings 和未验证项。`
}
