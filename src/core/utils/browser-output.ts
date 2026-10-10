/**
 * Browser position previews are UI evidence, not implicit model vision input.
 * Keep their pixels on the durable/display path and budget semantic text separately.
 */
const PNG_PREFIX = 'data:image/png;base64,'
const MAX_PNG_BASE64 = Math.ceil(1024 * 1024 / 3) * 4
const MAX_BROWSER_INPUT = 12 * 1024 * 1024
export const MAX_BROWSER_DISPLAY_TEXT = 512 * 1024

type RecordValue = Record<string, unknown>
type Screenshot = { dataUrl: string; width: number; height: number }
export interface BrowserOutputPresentation {
  displayOutput: string
  modelInputContent: string
  imageChars: number
}

const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined

function screenshot(value: unknown): Screenshot | undefined {
  const image = object(value)
  if (!image || typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(PNG_PREFIX) ||
      image.dataUrl.length > PNG_PREFIX.length + MAX_PNG_BASE64 ||
      typeof image.width !== 'number' || !Number.isInteger(image.width) || image.width < 1 || image.width > 1600 ||
      typeof image.height !== 'number' || !Number.isInteger(image.height) || image.height < 1 || image.height > 1600) return undefined
  const data = image.dataUrl.slice(PNG_PREFIX.length)
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  const byteLength = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  if (byteLength > 1024 * 1024) return undefined
  const header = Buffer.from(data.slice(0, 64), 'base64')
  if (header.length < 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      header.toString('ascii', 12, 16) !== 'IHDR' || header.readUInt32BE(16) !== image.width ||
      header.readUInt32BE(20) !== image.height) return undefined
  return { dataUrl: image.dataUrl, width: image.width, height: image.height }
}

// Only known browser schema fields survive the image-size exception. Arbitrary tool
// metadata and extra nested dataUrl fields cannot use it to escape the text budget.
function fields(source: RecordValue | undefined, strings: string[], numbers: string[], maxString: number): RecordValue {
  const result: RecordValue = {}
  if (!source) return result
  for (const key of strings) if (typeof source[key] === 'string') result[key] = source[key].slice(0, maxString)
  for (const key of numbers) if (typeof source[key] === 'number' && Number.isFinite(source[key])) result[key] = source[key]
  return result
}

function snapshotSource(output: unknown): RecordValue | undefined {
  if (typeof output !== 'string' || output.length > MAX_BROWSER_INPUT || !output.includes('"screenshot"')) return undefined
  try {
    const source = object(JSON.parse(output))
    const tab = object(source?.tab)
    if (!source || !tab || typeof tab.title !== 'string' || typeof tab.url !== 'string' || !tab.url.trim() ||
        typeof source.text !== 'string' || !Array.isArray(source.elements) ||
        (!Object.hasOwn(source, 'screenshot') && !Object.hasOwn(object(source.interaction) ?? {}, 'screenshot'))) return undefined
    if (!source.elements.every(item => {
      const element = object(item)
      return element && typeof element.role === 'string' && !!element.role.trim() && typeof element.name === 'string'
    })) return undefined
    return source
  } catch { return undefined }
}

function cleanSnapshot(source: RecordValue, textLimit: number, labelLimit: number): RecordValue {
  const originalTab = object(source.tab)!
  const tab = fields(originalTab, ['tabId', 'title', 'url'], ['navigationId', 'zoomFactor'], labelLimit)
  for (const key of ['loading', 'canGoBack', 'canGoForward']) if (typeof originalTab[key] === 'boolean') tab[key] = originalTab[key]
  const originalElements = source.elements as RecordValue[]
  const elements = originalElements.slice(0, 4096).map(element => {
    const clean = fields(element, ['role', 'name', 'value', 'ref'], [], labelLimit)
    if (element.bounds === null) clean.bounds = null
    else if (object(element.bounds)) clean.bounds = fields(object(element.bounds), [], ['x', 'y', 'width', 'height'], 0)
    return clean
  })
  const result: RecordValue = { tab, text: (source.text as string).slice(0, textLimit), elements,
    truncated: source.truncated === true || originalElements.length > elements.length || (source.text as string).length > textLimit }
  if (typeof source.snapshotUnavailable === 'string') result.snapshotUnavailable = source.snapshotUnavailable.slice(0, labelLimit)
  if (object(source.viewport)) result.viewport = fields(object(source.viewport), [], ['width', 'height', 'deviceScaleFactor', 'scrollX', 'scrollY'], 0)
  const interaction = object(source.interaction)
  if (interaction?.type === 'click') {
    const clean = fields(interaction, ['type', 'pageUrl'], ['x', 'y', 'navigationId'], labelLimit)
    clean.viewport = fields(object(interaction.viewport), [], ['width', 'height', 'deviceScaleFactor', 'scrollX', 'scrollY'], 0)
    const target = object(interaction.target)
    if (target) {
      clean.target = fields(target, ['name', 'role', 'ref', 'selector'], [], labelLimit)
      if (object(target.bounds)) (clean.target as RecordValue).bounds = fields(object(target.bounds), [], ['x', 'y', 'width', 'height'], 0)
    }
    result.interaction = clean
  }
  return result
}

function imageMarker(image: Screenshot | undefined, original: unknown): RecordValue {
  if (image) return { width: image.width, height: image.height, retainedForDisplay: true }
  const marker = object(original)
  if (marker?.retainedForDisplay === true && typeof marker.width === 'number' && Number.isInteger(marker.width) &&
      marker.width >= 1 && marker.width <= 1600 && typeof marker.height === 'number' && Number.isInteger(marker.height) &&
      marker.height >= 1 && marker.height <= 1600) return { width: marker.width, height: marker.height, retainedForDisplay: true }
  return { unavailable: true }
}

/** Undefined leaves ordinary results and explicit browser_screenshot native images unchanged. */
export function browserOutputPresentation(output: unknown, maxChars = 64 * 1024): BrowserOutputPresentation | undefined {
  const source = snapshotSource(output)
  if (!source) return undefined
  const image = screenshot(source.screenshot)
  const clickImage = screenshot(object(source.interaction)?.screenshot)
  const limit = Math.max(0, Math.min(MAX_BROWSER_DISPLAY_TEXT, Math.floor(maxChars)))
  const labelLimit = Math.min(1024, Math.max(16, Math.floor(limit / 16)))
  let model = cleanSnapshot(source, limit, labelLimit)
  if (Object.hasOwn(source, 'screenshot')) model.screenshot = imageMarker(image, source.screenshot)
  if (Object.hasOwn(object(source.interaction) ?? {}, 'screenshot') && object(model.interaction)) {
    (model.interaction as RecordValue).screenshot = imageMarker(clickImage, object(source.interaction)?.screenshot)
  }
  let modelText = JSON.stringify(model)
  if (modelText.length > limit) {
    model.truncated = true
    // Shrink page text and element lists together so one cannot consume the
    // entire allowance and silently leave the other representation empty.
    while (modelText.length > limit && ((model.text as string).length || (model.elements as unknown[]).length)) {
      model.text = (model.text as string).slice(0, Math.floor((model.text as string).length * 0.7))
      model.elements = (model.elements as unknown[]).slice(0, Math.floor((model.elements as unknown[]).length * 0.7))
      modelText = JSON.stringify(model)
    }
  }
  if (modelText.length > limit) {
    // An exceptionally small administrator text cap still must not leak image
    // bytes or produce broken JSON. Full pixel evidence remains in displayOutput.
    model = { tab: { title: '', url: (object(source.tab)!.url as string).slice(0, 128) }, text: '', elements: [], truncated: true }
    modelText = JSON.stringify(model)
    if (modelText.length > limit) modelText = limit >= 2 ? '{}' : ''
  }
  const display = { ...model }
  if (image) display.screenshot = image
  if (clickImage && object(display.interaction)) display.interaction = { ...object(display.interaction), screenshot: clickImage }
  return { displayOutput: JSON.stringify(display), modelInputContent: modelText,
    imageChars: (image?.dataUrl.length ?? 0) + (clickImage && object(display.interaction) ? clickImage.dataUrl.length : 0) }
}
