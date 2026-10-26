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

  // Models frequently emit native Windows paths as `D:\\dev\\...` in a
  // tool argument that is otherwise JSON. A single `\\d` (or `\\a`, `\\p`,
  // etc.) is not a JSON escape and makes the entire batch fail before the
  // tool can report a useful validation error. Escape only invalid escapes
  // while inside quoted strings; valid JSON escapes and structural content
  // remain byte-for-byte unchanged.
  repaired = escapeInvalidStringEscapes(repaired)
  try { JSON.parse(repaired); return repaired } catch (e) {}

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

function escapeInvalidStringEscapes(value: string): string {
  let output = '', inString = false, stringContent = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (!inString) {
      output += character
      if (character === '"') { inString = true; stringContent = '' }
      continue
    }
    if (character === '"') {
      output += character
      // A quote closes a JSON string here. The existing quote-repair pass
      // below handles prose quotes that are not followed by JSON structure.
      inString = false; stringContent = ''
      continue
    }
    if (character === '\\') {
      const next = value[index + 1]
      // Once a string has the shape of a Windows path, sequences such as
      // `\\r` in `\\report` are path separators, not JSON carriage returns.
      // Keep the two standard escaped path forms (`\\\\` and `\\"`) intact.
      const windowsPath = /^[A-Za-z]:\\?$/.test(stringContent) || /^[A-Za-z]:\\/.test(stringContent)
      if (windowsPath && next && next !== '"' && next !== '\\') {
        output += '\\\\'; stringContent += '\\'; continue
      }
      if (next === '"' || next === '\\' || next === '/' || next === 'b' || next === 'f'
        || next === 'n' || next === 'r' || next === 't') {
        output += character + next
        stringContent += character + next
        index++
        continue
      }
      if (next === 'u' && /^[0-9a-f]{4}$/i.test(value.slice(index + 2, index + 6))) {
        output += value.slice(index, index + 6)
        stringContent += value.slice(index, index + 6)
        index += 5
        continue
      }
      output += '\\\\'; stringContent += '\\'
      continue
    }
    if (character === '\n') { output += '\\n'; stringContent += '\\n'; continue }
    if (character === '\r') { output += '\\r'; stringContent += '\\r'; continue }
    output += character; stringContent += character
  }
  return output
}
