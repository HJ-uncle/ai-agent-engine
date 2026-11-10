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
    'PPT先确定每页目的，再按内容组织版式；统一字体、色彩和层级，避免连续页面都成要点列表。保留原生可编辑正文、表格和图表，具体能力与参数以工具schema为准。',
    '小型多表Excel内容已定且能完整输出时，一次create提交全部表；仅内容过大或新增表时append_sheets，按输出容量每批1–4张，不把少量短表强拆为多轮。',
    registry.has('subagent_start') ? '多格式项目文档默认按独立文件委派：共同事实只提取一次，先稳定共享草稿；执行代理只读所需参考，拥有各自成品，核验后报路径/hash/未验项。可将Word/PPT合一组、Excel一组；不让各代理各扫整个项目。若简短内容一个工具批次即可完成则直接批量生成，避免委派开销。' : '',
    '继承前文已定的格式与交付要求：用户补充“做某项目的”是在指定主题，不是重新选择做代码还是做文档。先在已绑定工作区定位同名项目和现有说明；用途/篇幅未指定时采用项目概览、台账、汇报的简明默认结构，非必要细节标待补，不重复询问已确定的需求。',
    '把文档任务控制在用户要求的范围：读取现成说明及必要依据即可；没有新的事实缺口不要重复读同一文件/技能。用户只要项目文档时，不自动变成全项目审计、全量测试或浏览器验收；缺少实测就标注来源和未实测，不虚构。未指定篇幅时先做内容完整的简明版，不擅自扩成大量章节、工作表或幻灯片。',
    '仅做项目文档且没有共享材料时，先读README等现有说明，足够就写草稿并生成分工要求的成品。不要主动增加代码行数、逐条测试清单、性能指标等未要求字段，不为额外字段扫全源码或执行脚本。既有测试引用来源并标注本次未重跑；共享材料已给出的事实无需逐项重新证明。',
    '项目概览保留用途、操作、模块、运行方式、资料来源与已知限制即可，不主动展开动画毫秒数、内部阈值等未要求的实现参数。确须写具体参数时核对实际生效逻辑；变量名或常量声明不证明它正在使用，未确认就省略或标明待核实，不写成确定事实。',
    '生成后核对实际要求：Excel重算与关键公式，Word/PPT正文、表格和页容量。有同版本可信校验回执就复用；结构检查不等于视觉验收。发现具体错误才修正，修订Excel后按最新hash重算，再复核受影响部分。通过即停止，不整包重建已通过文件或扩展无关验证；ZIP体积变化本身不证明内容丢失。',
    registry.has('workbench_render')
      ? 'PPT交付前用workbench_render按pageCount逐页读取同一expectedHash的实际画面，检查裁切、重叠、层级和内容，修正后重验受影响页；截图成功不等于验收通过。非视觉模型、客户端未连接或渲染失败时明确标记视觉验收未完成，不以文本检查替代。'
      : '当前未提供幻灯片画面工具，PPT视觉验收需明确标记未完成；内容或结构通过不能代替逐页实际检查。',
    '生产成品禁止拿来测试工具异常（坏表名、无效参数、故意冲突等）；工具测试需另有任务并用隔离夹具。未要求实现率/验证率等指标不自行添加，确需指标先在草稿固定含义和来源。命名在生成前确定，不为改文件名重复生成同一正文。',
    registry.has('deliver_files') ? '严格按 草稿→生成→必要校验/修正→登记交付→收敛计划→最终答复 的顺序完成。生成成功只是候选，不提前称已交付或输出成品下载入口。deliver_files成功后只依据证据收尾计划并答复，不再探索或编辑。确有新证据证明成品有误时，先deliver_files({items:[]})撤销登记，再修复、校验并重新登记完整清单。后续用户提出新修订属于新任务。最终只简述交付内容和必要限制，文件由卡片提供，不重复列同文件下载链接。' : '',
    'Preserve editable formats and reread conflicts. Recalculate Excel before delivery; save PDF revisions as new versions. Native-format preview is available; report warnings/unverified work. Authorized creation/editing needs no extra export approval. Do not invent data or rename extensions to fake Office files; links require success receipts.',
  ].filter(Boolean).join('\n')
}
