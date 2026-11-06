import { describe, expect, it } from 'vitest'
import { CODE_AGENT_EXECUTION_PROMPT } from '../code-agent-prompt.js'
import { FINALIZATION_PROMPT } from '../agent-loop/finalization.js'
import { buildExecutionProtocol } from '../execution-protocol.js'

describe('Code Agent execution prompt', () => {
  it('limits automatic delivered-image cards to Work and retains Code Markdown images', () => {
    const tools = { list: () => [{ name: 'deliver_files', description: 'Deliver', parameters: {} }] }
    const work = buildExecutionProtocol(tools, 'general'), code = buildExecutionProtocol(tools, 'code')
    expect(work).toContain('Work 界面自动显示本轮已登记图片')
    expect(work).toContain('最终正文不要再用Markdown重复插图')
    expect(code).not.toContain('最终正文不要再用Markdown重复插图')
    expect(code).not.toContain('Work 界面自动显示')
    expect(code).toContain('Code 最终正文仍用Markdown展示真实成品图片文件')
    expect(code).toContain('正文引用的图片文件须保留')
    expect(CODE_AGENT_EXECUTION_PROMPT).toContain('登记不代替正文插图')
    expect(buildExecutionProtocol({ list: () => [] }, 'general')).not.toContain('界面自动显示')
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
      'access=read-only', 'spec-reviewer', 'code-quality-reviewer', '同一次回复发多个独立 subagent 调用',
      '不重派同一探索绕预算', '不重做已验证实现', '新成功 runId',
      '添加到当前会话', '不要重复打开同一地址代替用户现有页面',
      '最小复现', '诊断不支持不等于通过', '脚本语法错误不等于产品缺陷']) {
      expect(CODE_AGENT_EXECUTION_PROMPT).toContain(rule)
    }
  })

  it('keeps shared recovery rules in the per-request protocol instead of duplicating them in Code', () => {
    const common = buildExecutionProtocol({ list: () => ['execute_cmd', 'command_output', 'cancel_command',
      'edit_file', 'browser_tabs', 'browser_snapshot', 'browser_open', 'search_history']
      .map(name => ({ name, description: name, parameters: {} })) })
    for (const marker of ['command_output', 'cancel_command', 'expectedHash', 'operationPerformed', 'snapshotUnavailable', 'search_history']) {
      expect(CODE_AGENT_EXECUTION_PROMPT).not.toContain(marker)
      expect(common).toContain(marker)
    }
    for (const rule of ['不填整行 shell 命令', '不原样重复失败', '同文件最近真实读写回执',
      '同 URL 不等于同 tabId', 'unknown 可能执行过，先核对状态', 'null/空结果不证明成功']) {
      expect(common).toContain(rule)
    }
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
