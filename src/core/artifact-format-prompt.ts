/**
 * Keep the default output choice explicit and shared by the execution and
 * Office branches.  The engine cannot reliably infer user intent from a file
 * extension after the model has already chosen a tool, so this policy belongs
 * in the prompt contract that is rebuilt for every request.
 */
export const DEFAULT_MARKDOWN_ARTIFACT_RULE = [
  '输出格式选择：用户未明确指定 Word/DOCX、Excel/XLSX、PPT/PPTX 或 PDF（也未提供必须保留的对应模板）时，普通回答、调研结论和解释直接使用 Markdown；用户明确要求生成/保存/交付文件但没有指定扩展名时，默认用 UTF-8 Markdown 文件（`.md`）。',
  '表格默认使用 Markdown 表格；只有用户明确要求 Excel/XLSX 或电子表格文件时才创建 Excel。不要把“文档/报告/方案/说明”这些词单独当成 Office 格式要求。',
  '只有用户明确指定上述办公格式、给出对应模板，或明确要求打印版/演示文稿/可编辑办公文件时，才加载或调用 office_document；未指定办公格式的任务不要先写办公草稿再转换。用户明确给出的其他扩展名或格式继续按用户要求处理。',
].join('\n')
