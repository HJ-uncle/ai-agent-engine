import { describe, expect, it } from 'vitest'
import { CODE_AGENT_EXECUTION_PROMPT } from '../code-agent-prompt.js'
import { FINALIZATION_PROMPT } from '../agent-loop/finalization.js'
import { buildExecutionProtocol } from '../execution-protocol.js'

describe('Code Agent execution prompt', () => {
  it('limits automatic delivered-image cards to Work and retains Code Markdown images', () => {
    const tools = { list: () => [{ name: 'deliver_files', description: 'Deliver', parameters: {} }] }
    const work = buildExecutionProtocol(tools, 'general'), code = buildExecutionProtocol(tools, 'code')
    expect(work).toContain('Work displays registered images')
    expect(work).toContain('do not duplicate them in final Markdown')
    expect(code).not.toContain('do not duplicate them in final Markdown')
    expect(code).not.toContain('Work displays')
    expect(code).toContain('Code final prose must embed real final images in Markdown')
    expect(code).toContain('Keep referenced files')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('登记不代替正文插图')
    expect(buildExecutionProtocol({ list: () => [] }, 'general')).not.toContain('Work displays')
  })
  it('defines the task loop and preserves user-only planning mode', () => {
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('UNDERSTAND → EXPLORE → PLAN → IMPLEMENT → VERIFY → HANDOFF')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('用户要求“先给方案”“只读”或“不要改代码”时')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('没有新鲜验证证据时，不得声称“已完成”')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('用户明确要求和适用的项目规则决定任务范围')
    expect(CODE_AGENT_EXECUTION_PROMPT).not.toContain('remember')
    expect(CODE_AGENT_EXECUTION_PROMPT).not.toContain('recall')
  })

  it('keeps exploration, subagent handoff and failure handling explicit', () => {
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('子 Agent 不继承完整会话')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('文件路径、行号、结论、未核实项和下一步')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('只读子 Agent')
  })

  it('retains Code-specific workspace, delegation, browser sharing and verification boundaries', () => {
    for (const rule of ['.ae/plans/', '.ae/tmp/', '.ae/logs/', '.ae/openspec/changes/', '.ae/brainstorm/',
      '用户范围同样约束计划、交接、报告和临时工件', '不搬项目自身 uploads/data/docs',
      'builtinRole=research严格只读', 'executor完成实际修改', 'general处理混合工作', '独立子任务可在同一轮发起',
      '不重派同一探索绕预算', '不重做已验证实现', '新成功 runId',
      '添加到当前会话', '不要重复打开同一地址代替用户现有页面',
      '最小复现', '诊断不支持不等于通过', '脚本语法错误不等于产品缺陷']) {
      expect(CODE_AGENT_EXECUTION_PROMPT).toContain(rule)
    }
  })

  it('keeps cross-tool recovery in the shared protocol; call syntax belongs to tool definitions', () => {
    const common = buildExecutionProtocol({ list: () => ['execute_cmd', 'browser_tabs', 'search_history']
      .map(name => ({ name, description: name, parameters: {} })) })
    for (const marker of ['search_history', 'Do not repeat an action with unknown outcome', 'Use errors/stdout/stderr/exit codes', 'not identical retries']) {
      expect(common).toContain(marker)
    }
    expect(common).toContain('Run services/watchers in supported background jobs')
    expect(common).toContain('editing pages/coordinates')
    expect(CODE_AGENT_EXECUTION_PROMPT).not.toContain('operationPerformed')
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
