import type { ExternalSkill } from '../skills/external-loader.js'

/** Describe only the admitted Office branch; invocation contracts stay in tools. */
export function buildOfficeExecutionPrompt(profile: string, registry: { has(name: string): boolean }, skills: readonly ExternalSkill[]): string {
  if (profile !== 'general' || !registry.has('office_document')) return registry.has('office_inspect')
    ? '\n\n## Office reading\nPrefer office_inspect({path}) for DOCX/XLSX/PPTX/PDF; use it when read_file yields no text, not handwritten ZIP/XML extraction. PPT notes use target=notes; Excel includes saved formula caches. Page by contentPage.hasMore/nextOffset with expectedHash; warnings/documentComplete bound coverage. Partial text is neither full content nor visual verification.'
    : ''
  return '\n\n## Office delivery\n' + [
    registry.has('get_skill') && skills.some(skill => skill.enabled && skill.name.toLowerCase() === 'aether-office')
      ? 'Read aether-office with get_skill first. 只协调者读总览即可；实际生成者按负责格式读取参考，独立参考同批读取。' : 'Use the actual office_document contract and receipts.',
    registry.has('office_environment') ? 'office_environment({}) diagnoses only; do not guess dependency paths or read other apps’ private dependencies. Installation is not successful rendering.' : '',
    'Prefer native Aether DOCX/XLSX/PPTX/PDF creation; no Python/shell/external Office app is needed. Do not automatically launch WPS/COM/LibreOffice or ask users to start local servers. read_file remains available.',
    '已有共享草稿就直接复用，只读自己的分工段落及共同事实；不得另写同内容草稿或重扫项目重新证明已给事实。仅某个成品必需事实缺失/冲突时定点补读。',
    registry.has('write_file') ? '没有草稿的新建任务先在本任务临时目录写一份 Markdown 草稿（draft.md），明确格式、用途、结构、来源与待补数据，只写成品内容。多格式共用此稿；草稿不默认交付，也不另等用户批准；已有文档单点修订可直接精确编辑。' : '',
    '草稿/输入就绪后，独立Word/Excel/PPT创建同轮提交多条office_document；同文件追加/重算/修订等最新hash。多个独立成品用一次office_inspect({files:[{path,expectedHash},…]})检查，按每项warnings/分页核对，不逐文件多轮；必要技能参考也同轮提交。',
    'PPT按受众与内容设计，先读格式参考；产品介绍优先利用已有真实画面，避免把文件清单、命令和测试脚本搬成正文。版式可变不等于设计合格；逐页与全篇检查视觉表达，不能只检查无溢出。保留原生可编辑正文、表格和图表，参数以工具schema为准。',
    '小型多表Excel内容已定且能完整输出时，一次create提交全部表；仅内容过大或新增表时append_sheets，按输出容量每批1–4张，不把少量短表强拆为多轮。',
    registry.has('subagent_start') ? '多格式项目文档默认按独立文件委派：共同事实只提取一次，先稳定共享草稿；执行代理只读所需参考，拥有各自成品，核验后报路径/hash/未验项。可将Word/PPT合一组、Excel一组；不让各代理各扫整个项目。若简短内容一个工具批次即可完成则直接批量生成，避免委派开销。' : '',
    '继承已定格式与交付要求；“做某项目的”指定主题，不重新询问格式。在绑定工作区定点读现有说明；用途/篇幅未指定时做内容完整的简明概览、台账或汇报，缺项标待补，不擅自扩篇。',
    '仅做项目文档时，没有共享材料才先读README，足够即写草稿并生成；无事实缺口不重读资料/技能，不扩成全项目审计、测试或浏览器验收，不为额外字段扫源码。既有测试注明来源与本次未重跑，缺少实测不虚构；未要求的代码行数、逐条测试清单、性能指标不添加。',
    '项目概览聚焦用途、操作、模块、运行方式、来源与限制；不展开未要求的动画时长等实现参数。确需参数须核对生效逻辑，声明不等于使用；未确认就省略/标待核实。',
    '生成后核对实际要求：Excel重算与关键公式，Word/PPT正文、表格和页容量。有同版本可信校验回执就复用；结构检查不等于视觉验收。发现具体错误才修正，修订Excel后按最新hash重算，再复核受影响部分。通过即停止，不整包重建已通过文件或扩展无关验证。',
    registry.has('workbench_render')
      ? 'Office/PDF交付前按格式用workbench_render按pageCount逐区段、逐表或逐页读取同一expectedHash的实际画面，检查裁切、重叠、层级和内容，修正后重验受影响项；截图成功不等于验收通过。非视觉模型、客户端未连接或渲染失败时明确标记视觉验收未完成，不以文本检查替代。'
      : '当前未提供幻灯片画面工具，PPT视觉验收需明确标记未完成；内容或结构通过不能代替逐页实际检查。',
    '生产成品禁止拿来测试工具异常（坏表名、无效参数、故意冲突等）；工具测试需另有任务并用隔离夹具。未要求实现率/验证率等指标不自行添加，确需指标先在草稿固定含义和来源。命名在生成前确定，不为改目录/文件名重发presentation、workbook或markdown。'
      + (registry.has('write_file') ? '确需换位置用write_file.copyFrom:{path,expectedHash}，源版本取最新成功回执，复制真实字节并核对hash，不重新生成。' : ''),
    registry.has('deliver_files') ? '严格按 草稿→生成→必要校验/修正→登记交付→收敛计划→最终答复 的顺序完成。成功文件校验后按回执原路径直接deliver_files登记，无需另建交付目录；登记前不称已交付或输出下载入口。deliver_files成功后只依据证据收尾计划并答复，不再探索或编辑。确有新证据证明成品有误时，先deliver_files({items:[]})撤销登记，再修复、校验并重新登记完整清单。后续用户提出新修订属于新任务。最终只简述交付内容和必要限制，文件由卡片提供，不重复列同文件下载链接。' : '',
    'Preserve editable formats and reread conflicts. Recalculate Excel before delivery; save PDF revisions as new versions. Native-format preview is available; report warnings/unverified work. Authorized creation/editing needs no extra export approval. Do not invent data or rename extensions to fake Office files; links require success receipts.',
  ].filter(Boolean).join('\n')
}
