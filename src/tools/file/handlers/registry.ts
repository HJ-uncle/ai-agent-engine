import path from 'node:path'
import type { FileHandler } from './interface.js'
import { TextHandler } from './text-handler.js'
import { JsonHandler } from './json-handler.js'
import { ExcelHandler } from './excel-handler.js'
import { ImageHandler } from './image-handler.js'
import { PdfHandler } from './pdf-handler.js'
import { WordHandler } from './word-handler.js'

export class HandlerRegistry {
  private handlers = new Map<string, FileHandler>()
  private defaultHandler: FileHandler

  constructor() {
    // 实例化处理器
    const textHandler = new TextHandler()
    const jsonHandler = new JsonHandler()
    const excelHandler = new ExcelHandler()
    const imageHandler = new ImageHandler()
    const pdfHandler = new PdfHandler()
    const wordHandler = new WordHandler()

    // 批量注册
    this.register(textHandler)
    this.register(jsonHandler)
    this.register(excelHandler)
    this.register(imageHandler)
    this.register(pdfHandler)
    this.register(wordHandler)
    
    // 设置默认处理器
    this.defaultHandler = textHandler
  }

  private register(handler: FileHandler) {
    for (const ext of handler.extensions) {
      this.handlers.set(ext.toLowerCase(), handler)
    }
  }

  getHandler(filePath: string): FileHandler {
    const ext = path.extname(filePath).toLowerCase()
    return this.handlers.get(ext) || this.defaultHandler
  }
}

export const handlerRegistry = new HandlerRegistry()
