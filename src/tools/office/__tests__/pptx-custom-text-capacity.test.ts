// Fresh coverage for actionable custom text errors: exact field/geometry,
// repair with the measured height, and unchanged native font/canvas checks.
import { describe, expect, it } from 'vitest'
import { createPptx, type PptxInput, type PptxSlide } from '../pptx.js'
import { readOfficeZip } from '../office-zip.js'

type TextElement = Extract<NonNullable<PptxSlide['elements']>[number], { type: 'text' }>

function fixture(element: TextElement): PptxInput {
  return { slides: [
    { title: '已有页面', layout: 'cover' },
    { title: '封面', layout: 'custom', elements: [
      { type: 'shape', shape: 'rect', x: 0.7, y: 0.5, w: 0.6, h: 0.05 },
      { type: 'text', text: '网页小游戏', x: 0.7, y: 0.7, w: 4, h: 0.5, fontSize: 18 },
      element,
    ] },
  ] }
}

describe('custom PPTX text capacity diagnostics', () => {
  it.each([
    { name: 'recorded 2048 cover title', text: '2048', fontSize: 72, w: 5.4, h: 1.1, required: '1.300', nativeSize: 7200 },
    { name: 'wrapped Chinese text with default font', text: '项目封面与真实截图', fontSize: undefined, w: 1.5, h: 0.4, required: '1.192', nativeSize: 2200 },
  ])('locates $name and generates after changing only the suggested height', async ({ text, fontSize, w, h, required, nativeSize }) => {
    const element: TextElement = { type: 'text', text, x: 0.74, y: 1.95, w, h, fontSize }
    const input = fixture(element), original = structuredClone(input)
    const error = await createPptx(input).catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('第 2 页 presentation.slides.1.elements.2.text: 文本超出布局容量')
    expect(message).toContain(`当前 w=${w.toFixed(3)}、h=${h.toFixed(3)} 英寸`)
    expect(message).toContain(`按当前宽度测量需 h=${required}`)
    expect(message).toContain(`presentation.slides.1.elements.2.h 至少设为 ${required}`)
    expect(message).toContain('增高前须核对相邻元素与画布边界')
    expect(input).toEqual(original)

    const suggestedHeight = Number(message.match(/\.elements\.2\.h 至少设为 (\d+\.\d+)/)?.[1])
    element.h = suggestedHeight
    const entries = readOfficeZip(await createPptx(input))
    const xml = Buffer.from(entries['ppt/slides/slide2.xml']).toString('utf8')
    const shape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].find(match => match[0].includes(`<a:t>${text}</a:t>`))?.[0]
    expect(shape).toBeDefined()
    expect(shape).toContain(`sz="${nativeSize}"`)
    expect(shape).toContain(`<a:off x="${Math.round(element.x * 914400)}" y="${Math.round(element.y * 914400)}"/>`)
    expect(shape).toContain(`<a:ext cx="${Math.round(w * 914400)}" cy="${Math.round(suggestedHeight * 914400)}"/>`)
    expect(shape).not.toContain('<a:normAutofit')
    expect(element).toEqual({ ...original.slides[1].elements![2], h: suggestedHeight })
  })

  it('keeps the canvas rejection when the measured height would extend below the slide', async () => {
    const element: TextElement = { type: 'text', text: '2048', x: 0.74, y: 6.3, w: 5.4, h: 1.1, fontSize: 72 }
    const input = fixture(element)
    await expect(createPptx(input)).rejects.toThrow('presentation.slides.1.elements.2.h 至少设为 1.300')
    element.h = 1.3
    await expect(createPptx(input)).rejects.toThrow('超出 13.333 × 7.5 英寸画布')
  })
})
