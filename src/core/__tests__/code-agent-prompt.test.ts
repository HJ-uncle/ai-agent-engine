import { describe, expect, it } from 'vitest'
import { CODE_AGENT_EXECUTION_PROMPT } from '../code-agent-prompt.js'
import { FINALIZATION_PROMPT } from '../agent-loop/finalization.js'

describe('Code Agent execution prompt', () => {
  it('defines the task loop and preserves user-only planning mode', () => {
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('UNDERSTAND → EXPLORE → PLAN → IMPLEMENT → VERIFY → HANDOFF')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('用户要求“先给方案”“只读”或“不要改代码”时')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('没有新鲜验证证据时，不得声称“已完成”')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('用户明确要求和适用的项目规则决定任务范围')
    expect(CODE_AGENT_EXECUTION_PROMPT).not.toContain('remember')
    expect(CODE_AGENT_EXECUTION_PROMPT).not.toContain('recall')
  })

  it('keeps exploration, subagent handoff and failure handling explicit', () => {
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('同一种方法不要盲目重试')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('子 Agent 不继承完整会话')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('文件路径、行号、结论、未核实项和下一步')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('只读子 Agent')
  })

  it('requires an evidence-based, structured handoff', () => {
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('结论 → 已完成/已修复 → 支持/使用方式 → 核心文件 → 验证结果 → 未完成与限制')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('已完成 / 部分完成 / 未完成')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('只写实际执行过的检查、测试及通过数')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('计划、建议和预测不计入已完成')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('失败项也必须列出')
    expect(FINALIZATION_PROMPT).toContain('结论：明确写“已完成”“部分完成”或“未完成”')
    expect(FINALIZATION_PROMPT).toContain('没有执行就写“未执行”')
    expect(FINALIZATION_PROMPT).toContain('不要输出整段日志或隐藏思考')
  })
})
