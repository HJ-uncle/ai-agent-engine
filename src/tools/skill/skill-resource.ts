import fs from 'node:fs'
import path from 'node:path'
import type { ToolResult } from '../../core/agent-context/index.js'
import type { ExternalSkill } from '../../skills/external-loader.js'

const MAX_REFERENCE_BYTES = 128 * 1024
function denied(message: string): ToolResult { return { success: false, error: 'SKILL_RESOURCE_UNAVAILABLE', output: message } }
function contained(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}

/** The selected registry skill, rather than a model-supplied filesystem root,
 * grants a bounded read of its Markdown references. read_file policy is unchanged. */
export function readSkillResource(skills: readonly ExternalSkill[], name: string, resource: string): ToolResult {
  if (!/^references\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(resource) || resource.includes('\\') || resource.split('/').some(part => part === '..' || part === '.')) return denied('Only relative references/*.md resources of the selected skill may be read.')
  const skill = skills.find(candidate => candidate.name.toLowerCase() === name.toLowerCase() ||
    !!candidate.skillMdPath && path.basename(path.dirname(candidate.skillMdPath)).toLowerCase() === name.toLowerCase())
  if (!skill || !skill.skillMdPath || skill.inlineContent !== undefined) return denied('The selected skill has no local reference directory.')
  try {
    const base = fs.realpathSync.native(path.dirname(skill.skillMdPath))
    const requested = path.resolve(base, resource)
    const actual = fs.realpathSync.native(requested)
    if (!contained(base, actual)) return denied('Skill reference leaves the selected skill directory.')
    const fd = fs.openSync(actual, 'r')
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES) return denied('Skill reference must be a regular Markdown file at most 128 KiB.')
      // Do not allocate according to mutable/untrusted metadata or read a file
      // that grows past the advertised limit into an unbounded buffer.
      const bounded = Buffer.alloc(MAX_REFERENCE_BYTES + 1)
      const length = fs.readSync(fd, bounded, 0, bounded.length, 0)
      if (length > MAX_REFERENCE_BYTES || fs.fstatSync(fd).size > MAX_REFERENCE_BYTES) return denied('Skill reference exceeds 128 KiB.')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bounded.subarray(0, length))
      return { success: true, output: content, metadata: { skill: skill.name, resource, sizeBytes: length } }
    } finally { fs.closeSync(fd) }
  } catch (error) { return denied(`Skill reference cannot be read: ${error instanceof Error ? error.message : String(error)}`) }
}
