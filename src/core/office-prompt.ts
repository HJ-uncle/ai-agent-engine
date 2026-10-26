import type { ExternalSkill } from '../skills/external-loader.js'

/** Advertise only capabilities admitted by this request's actual registry. */
export function buildOfficeExecutionPrompt(profile: string, registry: { has(name: string): boolean }, skills: readonly ExternalSkill[]): string {
  if (profile !== 'general' || !registry.has('office_document')) return ''
  const guide = registry.has('get_skill') && skills.some(skill => skill.enabled && skill.name.toLowerCase() === 'aether-office')
    ? '办公原格式创建与编辑先用 get_skill 读取 aether-office；模式细节通过它的 references 资源按需读取。'
    : '按 office_document 的真实参数和校验回执完成办公文件交付。'
  const environment = registry.has('office_environment')
    ? '\noffice_environment({}) 可做只读环境诊断，探测到软件不代表有权调用。日常办公必须优先在Aether内完成，不自动启动 WPS、Office COM、LibreOffice 或外部办公程序，也不让用户启动本地服务器。'
    : ''
  return `\n\n## 办公文件交付\n${guide}${environment}\n已有 read_file 办公读取能力继续可用。office_document 原生创建 DOCX/XLSX/PPTX/PDF，无需Python、shell或外部办公应用。Word/PDF用markdown，PPTX用presentation.slides，Excel用workbook。create 使用 expectedHash="missing"，已有文件先 inspect 并用真实 sha256 版本定点 edit，发生冲突重新检查而非覆盖。多表分批用 append_sheets，每次优先一张新表并复用最新 hash；禁止为补表删除重建或整包重发。Excel交付前用recalculate及同文件真实hash执行内置跨表公式计算；不支持的公式会明确失败，不能改成硬编码数字伪装重算。PDF是Aether排版生成，不等于从Word/PPT原样导出；PDF改版新建版本文件，不能假称支持任意PDF文字编辑。原格式在Aether资源预览中查看；没有真实渲染证据不得声称视觉验收。用户已要求生成/修改就完成真实文件交付，不额外等待导出确认。不编造缺失信息，不用Markdown/CSV改扩展名冒充Office。成功回执后才提供真实文件链接；结构检查、视觉排版验证与公式计算是不同事实，按实际结果说明warnings和未验证项。`
}
