import { describe, expect, it } from 'vitest'
import { isDefaultTool, OPTIONAL_TOOL_EXPOSURES, REMOVED_TOOL_NAMES } from '../tool-exposure.js'

describe('default tool exposure', () => {
  it('keeps the 15 optional tools discoverable with a Chinese explanation', () => {
    const expected = [
      'agent_list', 'agent_get', 'agent_create', 'agent_do_create',
      'agent_update', 'agent_do_update', 'agent_delete', 'agent_do_delete',
      'todo_list', 'todo_create', 'todo_update', 'todo_delete',
      'task_list', 'task_status', 'task_cancel',
    ]
    expect(Object.keys(OPTIONAL_TOOL_EXPOSURES).sort()).toEqual(expected.sort())
    for (const [name, exposure] of Object.entries(OPTIONAL_TOOL_EXPOSURES)) {
      expect(isDefaultTool(name), name).toBe(false)
      expect(exposure.defaultEnabled, name).toBe(false)
      expect(exposure.reason, name).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it.each([
    'plan_update', 'cron_list', 'cron_create', 'cron_update', 'cron_delete', 'cron_preview',
    'read_file', 'execute_cmd', 'subagent_start', 'glob', 'grep',
  ])('keeps %s in the default set', name => {
    expect(isDefaultTool(name)).toBe(true)
  })

  it.each(['custom_skill_tool', 'mcp_custom', 'constructor', 'toString', '__proto__'])('does not hide unlisted tool %s', name => {
    expect(isDefaultTool(name)).toBe(true)
  })

  it.each([...REMOVED_TOOL_NAMES])('never advertises removed name %s', name => {
    expect(isDefaultTool(name)).toBe(false)
    expect(Object.hasOwn(OPTIONAL_TOOL_EXPOSURES, name)).toBe(false)
  })
})
