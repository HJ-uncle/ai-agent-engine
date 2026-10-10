/** UI browser backgrounds survive output limits but never become implicit model vision. */
import { describe, expect, it } from 'vitest'
import { browserOutputPresentation } from '../browser-output.js'
import { modelMessageContent, estimateModelMessageTokens } from '../model-context.js'
import { multimodalSummaryText, imageToolPayload } from '../multimodal-context.js'
import { CurrentTurnProjection } from '../../stream-pipeline/stream-projection.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII=', 'base64')
function screenshot(bytes = png.length) {
  return { dataUrl: 'data:image/png;base64,' + Buffer.concat([png, Buffer.alloc(Math.max(0, bytes - png.length))]).toString('base64'), width: 1, height: 1 }
}
function snapshot(image = screenshot()) {
  return {
    tab: { tabId: 'browser-1', title: 'Login', url: 'https://example.test/login', loading: false, navigationId: 3 },
    text: 'Username\nLog in', elements: [{ role: 'button', name: 'Log in', ref: '3:1', bounds: { x: 20, y: 30, width: 80, height: 32 } }],
    truncated: false, viewport: { width: 1280, height: 720, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 },
    screenshot: image,
    interaction: { type: 'click', x: 60, y: 45, navigationId: 2, pageUrl: 'https://example.test/before-click',
      viewport: { width: 1000, height: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 100 }, screenshot: image,
      target: { name: 'Log in', role: 'button', bounds: { x: 20, y: 30, width: 80, height: 32 } } },
  }
}

describe('browser screenshot presentation boundary', () => {
  it('preserves page and pre-click pixels in display with readable metadata in model input', () => {
    const input = snapshot()
    const result = browserOutputPresentation(JSON.stringify(input), 4000)!
    const display = JSON.parse(result.displayOutput)
    const model = JSON.parse(result.modelInputContent)
    expect(display.screenshot).toEqual(input.screenshot)
    expect(display.interaction).toEqual(input.interaction)
    expect(model.screenshot).toEqual({ width: 1, height: 1, retainedForDisplay: true })
    expect(model.interaction.screenshot).toEqual(model.screenshot)
    expect(model.elements).toEqual(input.elements)
    expect(result.modelInputContent).not.toContain('data:image')
    expect(result.imageChars).toBe(input.screenshot.dataUrl.length * 2)
  })

  it('keeps structured output under the text cap even when page text and element names are huge', () => {
    const input = { ...snapshot(), text: 'x'.repeat(200_000), extra: 'y'.repeat(200_000),
      elements: Array.from({ length: 100 }, () => ({ role: 'button', name: 'z'.repeat(20_000), ref: '3:1' })) }
    const result = browserOutputPresentation(JSON.stringify(input), 4000)!
    expect(result.modelInputContent.length).toBeLessThanOrEqual(4000)
    const model = JSON.parse(result.modelInputContent)
    expect(model.truncated).toBe(true)
    expect(Array.isArray(model.elements)).toBe(true)
    expect(model.extra).toBeUndefined()
    expect(JSON.parse(result.displayOutput).screenshot).toEqual(input.screenshot)
  })

  it.each([
    ['remote source', { ...screenshot(), dataUrl: 'https://outside.invalid/track.png' }],
    ['SVG', { ...screenshot(), dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }],
    ['wrong dimensions', { ...screenshot(), width: 2 }],
    ['oversized dimensions', { ...screenshot(), width: 1601 }],
    ['oversized bytes', screenshot(1024 * 1024 + 3)],
    ['array', [screenshot()]],
  ])('removes invalid screenshot %s without breaking the page result', (_name, invalid) => {
    const input = { ...snapshot(), screenshot: invalid, interaction: { ...snapshot().interaction, screenshot: invalid } }
    const result = browserOutputPresentation(JSON.stringify(input), 4000)!
    expect(result.imageChars).toBe(0)
    expect(result.displayOutput).not.toContain('data:')
    expect(result.displayOutput).not.toContain('outside.invalid')
    expect(JSON.parse(result.displayOutput).elements).toEqual(input.elements)
  })

  it('does not treat ordinary or explicit native-image results as browser backgrounds', () => {
    for (const input of ['normal log', JSON.stringify({ dataUrl: screenshot().dataUrl }), JSON.stringify({ screenshot: screenshot(), text: 'not a snapshot' })]) {
      expect(browserOutputPresentation(input)).toBeUndefined()
    }
    expect(imageToolPayload(JSON.stringify({ dataUrl: screenshot().dataUrl }))).toBeDefined()
  })

  it('projects legacy history and compaction without base64 while preserving the display message', () => {
    const input = JSON.stringify(snapshot(screenshot(600_000)))
    const message = { role: 'tool' as const, toolCallId: 'browser-read', content: input }
    expect(modelMessageContent(message)).not.toContain('data:image')
    expect(multimodalSummaryText(input, true)).not.toContain('data:image')
    expect(estimateModelMessageTokens(message)).toBeLessThan(4000)
    expect(message.content).toBe(input)
    expect(modelMessageContent({ ...message, modelInputContent: 'explicit compacted input' })).toBe('explicit compacted input')
  })

  it('preserves large screenshot JSON through live snapshot/reconnect projection', () => {
    const input = JSON.stringify(snapshot(screenshot(600_000)))
    const projection = new CurrentTurnProjection()
    const result = { toolCallId: 'browser-read', name: 'browser_snapshot', output: input, outputPreview: input, status: 'succeeded' }
    projection.apply({ toolEnd: result })
    projection.apply({ toolResult: result })
    const output = projection.snapshot()[0].toolResult as Record<string, string>
    expect(JSON.parse(output.output).screenshot.dataUrl).toBe(snapshot(screenshot(600_000)).screenshot.dataUrl)
    expect(JSON.parse(output.outputPreview).interaction.screenshot).toEqual(JSON.parse(output.output).interaction.screenshot)
    expect(projection.truncated).toBe(false)
    const restored = new CurrentTurnProjection(projection.snapshot())
    expect(restored.snapshot()).toEqual(projection.snapshot())
  })

  it('retains ordinary stream text limits and rejects image-marker size bypasses', () => {
    const projection = new CurrentTurnProjection()
    projection.apply({ toolResult: { toolCallId: 'text', output: 'a'.repeat(600_000) } })
    projection.apply({ toolResult: { toolCallId: 'pretend-image', output: JSON.stringify({ screenshot: screenshot(600_000), text: 'no browser schema' }) } })
    for (const entry of projection.snapshot()) expect((entry.toolResult as Record<string, string>).output.length).toBeLessThanOrEqual(512 * 1024)
    expect(projection.truncated).toBe(true)
  })

  it('bounds cumulative replay image memory without deleting tool outcomes', () => {
    const input = JSON.stringify(snapshot(screenshot(600_000)))
    const projection = new CurrentTurnProjection()
    for (let i = 0; i < 8; i++) projection.apply({ toolResult: { toolCallId: 'browser-' + i, output: input, outputPreview: input, status: 'succeeded' } })
    const results = projection.snapshot().map(item => item.toolResult as Record<string, string>)
    expect(results).toHaveLength(8)
    expect(results[0].output).not.toContain('data:image')
    expect(results.at(-1)!.output).toContain('data:image')
    expect(results.every(result => JSON.parse(result.output).tab.url === 'https://example.test/login')).toBe(true)
    const encoded = results.reduce((sum, result) => sum + [result.output, result.outputPreview].reduce((n, raw) => {
      const page = JSON.parse(raw)
      return n + (page.screenshot?.dataUrl?.length ?? 0) + (page.interaction?.screenshot?.dataUrl?.length ?? 0)
    }, 0), 0)
    expect(encoded).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(projection.truncated).toBe(true)
  })
})

it('preserves post-action snapshot failure evidence without inventing post-navigation viewport data', () => {
  const reason = '点击已执行，但页面正在跳转，暂时无法读取操作后的快照。请稍后重新读取页面，不要重复点击。'
  const previous = snapshot(screenshot(100_000))
  const input = {
    tab: previous.tab, text: '', elements: [], truncated: false, snapshotUnavailable: reason,
    interaction: previous.interaction,
  }
  const result = browserOutputPresentation(JSON.stringify(input), 4000)!
  const display = JSON.parse(result.displayOutput)
  const model = JSON.parse(result.modelInputContent)
  expect(display.snapshotUnavailable).toBe(reason)
  expect(model.snapshotUnavailable).toBe(reason)
  expect(model).not.toHaveProperty('viewport')
  expect(display).not.toHaveProperty('screenshot')
  expect(display.interaction.screenshot).toEqual(previous.interaction.screenshot)
  expect(model.interaction.screenshot).toEqual({ width: 1, height: 1, retainedForDisplay: true })
  expect(result.modelInputContent).not.toContain('data:image')
  expect(modelMessageContent({ role: 'tool', content: JSON.stringify(input) })).toContain(reason)

  const { interaction: _interaction, ...withoutClickImage } = input
  expect(modelMessageContent({ role: 'tool', content: JSON.stringify(withoutClickImage) })).toContain(reason)
})
