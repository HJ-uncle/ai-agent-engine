import type { ZodIssue } from 'zod'
import { presentationSchema } from './pptx-schema.js'

/** Keep strict validation, but make a failed large deck repairable without guessing. */
export function formatOfficeArgumentIssues(issues: readonly ZodIssue[]): string {
  return issues.slice(0, 5).map(issue => {
    const location = issue.path.join('.') || 'arguments'
    const message = `${location}: ${issue.message}`
    if (issue.code !== 'unrecognized_keys' || issue.path[0] !== 'presentation'
      || issue.path[1] !== 'slides' || typeof issue.path[2] !== 'number' || issue.path.at(-1) !== 'table') return message
    const allowed = Object.keys(presentationSchema.shape.slides.element.shape.table.unwrap().shape).join(', ')
    return `${message}. 表格仅支持 ${allowed}；移除未定义字段。补充说明写在 presentation.slides.${issue.path[2]}.notes；其余内容保持不变。`
  }).join('; ')
}
