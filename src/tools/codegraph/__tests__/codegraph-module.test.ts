import { describe, expect, it } from 'vitest'
import { resolveCodeGraphModule } from '../codegraph-module.js'

class GraphApi {
  static openSync() {}
  static isInitialized() { return false }
  static init() {}
  static recreate() {}
}

describe('CodeGraph module interop', () => {
  it('accepts an explicit named export', () => {
    expect(resolveCodeGraphModule({ CodeGraph: GraphApi })).toBe(GraphApi)
  })

  it('resolves the CJS re-export namespace used by the installed npm SDK', () => {
    const exports = { CodeGraph: GraphApi, otherExport: {} }
    expect(resolveCodeGraphModule({ default: exports, 'module.exports': exports })).toBe(GraphApi)
  })

  it('uses a valid CJS class even if a synthetic named export is incomplete', () => {
    expect(resolveCodeGraphModule({ CodeGraph: {}, default: { CodeGraph: GraphApi } })).toBe(GraphApi)
  })

  it.each([null, {}, { default: GraphApi }, { CodeGraph: { openSync() {}, isInitialized() {} } }])(
    'rejects incomplete APIs rather than exposing a broken query or index entry', (module) => {
      expect(() => resolveCodeGraphModule(module)).toThrow('代码图组件接口不兼容')
    }
  )
})
