/**
 * 尝试修复 LLM 生成的破损 JSON（如字符串内部未转义的双引号、尾随逗号、换行符等）
 * 同时也处理 Markdown 代码块包裹的情况。
 */
export function repairJson(str: string): string {
  if (!str || str.trim() === '') return '{}'

  let repaired = str.trim()

  // 1. 处理 Markdown 代码块包裹 (如 ```json ... ``` 或 ``` ... ```)
  if (repaired.startsWith('```')) {
    const lines = repaired.split('\n')
    if (lines[0].startsWith('```')) {
      // 移除第一行 (```json 或 ```)
      lines.shift()
    }
    if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) {
      // 移除最后一行 (```)
      lines.pop()
    }
    repaired = lines.join('\n').trim()
  }

  // 如果已经能解析，直接返回
  try {
    JSON.parse(repaired)
    return repaired
  } catch (e) {}

  // 2. 修复中文字符/常规字符之间的未转义双引号 (例如: "description": "能"看见"死灵")
  // 匹配前后都不是 JSON 结构字符(如 { } [ ] : , 和空白符)的双引号。
  // 关键：排除已经被反斜杠转义的引号（前一个字符是 \），否则 `\"` 会被二次转义成 `\\"`，
  // 直接破坏 JSON 结构导致解析失败（曾导致长文本 write_file 工具调用崩溃）。
  repaired = repaired.replace(/(?<![\\\{\}\[\]:, \n\r\t])"(?![\\\{\}\[\]:, \n\r\t])/g, '\\"')
  try { JSON.parse(repaired); return repaired } catch (e) {}

  // 3. 移除对象或数组末尾的多余逗号
  repaired = repaired.replace(/,\s*([}\]])/g, '$1')
  try { JSON.parse(repaired); return repaired } catch (e) {}

  // 4. 转义未转义的换行符
  repaired = repaired.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  try { JSON.parse(repaired); return repaired } catch (e) {}

  return repaired // 如果实在修不好，返回尽可能清理过的字符串
}
