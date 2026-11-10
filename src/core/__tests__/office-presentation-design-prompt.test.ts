import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildOfficeExecutionPrompt } from '../office-prompt.js'

describe('PPT visual review capability routing', () => {
  const registry = (...names: string[]) => ({ has: (name: string) => names.includes(name) })

  it('requires actual per-page rendering with a consistent file version when available', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document', 'workbench_render'), [])
    expect(prompt).toContain('workbench_render')
    expect(prompt).toContain('pageCount')
    expect(prompt).toContain('同一expectedHash')
    expect(prompt).toContain('截图成功不等于验收通过')
    expect(prompt).toContain('非视觉模型、客户端未连接或渲染失败')
    expect(prompt).not.toContain('当前未提供幻灯片画面工具')
  })

  it('reports incomplete visual review without advertising an unavailable renderer', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document'), [])
    expect(prompt).not.toContain('workbench_render')
    expect(prompt).toContain('视觉验收需明确标记未完成')
    expect(prompt).toContain('内容或结构通过不能代替逐页实际检查')
  })

  it.each(['general', 'code'])('keeps %s read-only Office routing free of generation instructions', profile => {
    const prompt = buildOfficeExecutionPrompt(profile, registry('office_inspect', 'workbench_render'), [])
    expect(prompt).toContain('office_inspect({path})')
    expect(prompt).not.toContain('Office delivery')
    expect(prompt).not.toContain('office_document')
    expect(prompt).not.toContain('workbench_render')
  })

  it('makes visual expression part of the production review instead of accepting screenshots alone', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document', 'workbench_render'), [])
    expect(prompt).toContain('产品介绍优先利用已有真实画面')
    expect(prompt).toContain('文件清单、命令和测试脚本')
    expect(prompt).toContain('逐页与全篇检查视觉表达')
    expect(prompt).toContain('不能只检查无溢出')
  })

  it('registers the confirmed file directly and copies real bytes only when a move is required', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document', 'write_file', 'deliver_files'), [])
    expect(prompt).toContain('按回执原路径直接deliver_files登记')
    expect(prompt).toContain('无需另建交付目录')
    expect(prompt).toContain('不为改目录/文件名重发presentation、workbook或markdown')
    expect(prompt).toContain('write_file.copyFrom:{path,expectedHash}')
    expect(prompt).toContain('源版本取最新成功回执')
    expect(prompt).toContain('复制真实字节并核对hash')
    const withoutCopyTool = buildOfficeExecutionPrompt('general', registry('office_document'), [])
    expect(withoutCopyTool).not.toContain('write_file.copyFrom')
    expect(withoutCopyTool).not.toContain('直接deliver_files登记')
  })

  it('loads one content-driven design guide with contextual assets and composition review', () => {
    const guide = readFileSync(new URL('../../skills/builtin/aether-office/references/presentations-pdf.md', import.meta.url), 'utf8')
    expect(guide).toContain('不增加固定模板')
    expect(guide).toContain('优先展示具体画面')
    expect(guide).toContain('不强迫每份演示使用图片')
    expect(guide).toContain('不为找配图升级成全项目扫描、测试或启动服务')
    expect(guide).toContain('不能仅因无溢出而通过')
    expect(guide).toContain('用户明确要求的极简留白可以保留')
    expect(guide).toContain('不按填满画面或固定图文比例判定')
    expect(guide).toContain('再连看全篇')
    expect(guide).toContain('可见标题需文本元素')
    expect(guide).toContain('主题字段必须放在 `presentation.theme` 内')
    expect(guide).toContain('辅助标注也须遵守 schema 最低 12pt')
    expect(guide).toContain('正文 18–24pt')
    expect(guide).not.toMatch(/至少\s*\d+\s*[%％].*(?:图片|图表)/)
  })
})
