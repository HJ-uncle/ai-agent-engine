import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { readCsvAsJson, saveAsCsv } = require('jtcsv')
import type { AgentContext } from '../../../core/agent-context/index.js'
import type { FileHandler, ReadOptions, ReadResult } from './interface.js'
import { cellValueToString } from '../utils.js'

export class ExcelHandler implements FileHandler {
  extensions = ['.xlsx', '.xls', '.csv']

  async read(filePath: string, _ctx: AgentContext, options?: ReadOptions): Promise<ReadResult> {
    const mode = options?.mode || 'auto'
    const ext = path.extname(filePath).toLowerCase()
    const stat = await fs.stat(filePath)
    
    // --- 1. CSV 处理 (使用 jtcsv) ---
    // 对于超大 CSV 文件 (>5MB)，强制走 jtcsv 的高性能流式解析逻辑
    if (ext === '.csv') {
      try {
        const csvData = await readCsvAsJson(filePath, {
          maxRows: mode === 'full' ? undefined : (options?.endLine || 300),
          hasHeaders: true
        })
        return {
          type: 'csv',
          data: csvData,
          content: `[CSV 文件: ${path.basename(filePath)}]\n${JSON.stringify(csvData)}`
        }
      } catch (err: any) {
        if (stat.size > 5 * 1024 * 1024) throw err // 超大文件解析失败直接报错
        _ctx.logger.warn(`jtcsv failed to read CSV, falling back to ExcelJS: ${err.message}`)
      }
    }

    // --- 2. 尝试使用 xlsx (SheetJS) 读取 ---
    // xlsx 库对 .xls (BIFF8) 兼容性最好，同时也支持 .xlsx 和 .csv
    try {
      const fileBuffer = await fs.readFile(filePath)
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' })
      const firstSheetName = workbook.SheetNames[0]
      
      if (firstSheetName) {
        const worksheet = workbook.Sheets[firstSheetName]
        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][]
        
        // 如果是 .xls 或者 ExcelJS 可能解析失败的情况，直接使用 xlsx 的结果
        if (ext === '.xls' || rawData.length > 0) {
          const totalRows = rawData.length
          let startRow = options?.startLine ?? 1
          let endRow = options?.endLine ?? (options?.startLine ? startRow + 299 : 50)
          
          if (mode === 'full') {
            startRow = 1
            endRow = totalRows
          }
          
          startRow = Math.max(1, startRow)
          endRow = Math.min(totalRows, endRow)
          
          const slice = rawData.slice(startRow - 1, endRow)
          const displayRows = slice.map((row: any, i: number) => {
            const rowNum = startRow + i
            const rowData = Array.isArray(row) ? row.map(v => cellValueToString(v)).join(',') : String(row)
            return `${rowNum.toString().padStart(4, ' ')} | ${rowData}`
          })
          
          const note = totalRows > (endRow - startRow + 1)
            ? `\n\n[第 ${startRow}-${endRow} 行，共 ${totalRows} 行。使用 start_line 和 end_line 读取更多内容]` 
            : ''
            
          return {
            type: 'spreadsheet',
            data: { sheetName: firstSheetName, rowCount: totalRows, rows: rawData },
            content: `[Excel(${ext}) Sheet:${firstSheetName},Rows:${totalRows}]\n${displayRows.join('\n')}${note}`
          }
        }
      }
    } catch (err: any) {
      _ctx.logger.error(`xlsx library failed to read ${ext}: ${err.message}`)
    }

    // --- 3. 最后的兜底：使用 ExcelJS (仅限 .xlsx) ---
    if (ext === '.xlsx') {
      try {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.readFile(filePath)
        const worksheet = workbook.worksheets[0]
        if (worksheet) {
          const firstSheet = worksheet.name
          const totalRows = worksheet.rowCount
          let startRow = options?.startLine ?? 1
          let endRow = options?.endLine ?? (options?.startLine ? startRow + 299 : 50)
          if (mode === 'full') { startRow = 1; endRow = totalRows }
          startRow = Math.max(1, startRow); endRow = Math.min(totalRows, endRow)

          const rows: any[][] = []
          const displayRows: string[] = []
          worksheet.eachRow((row, rowNumber) => {
            const vals = Array.isArray(row.values) ? row.values.slice(1) : []
            rows.push(vals)
            if (rowNumber >= startRow && rowNumber <= endRow) {
              const strs = vals.map(v => cellValueToString(v))
              displayRows.push(`${rowNumber.toString().padStart(4, ' ')} | ${strs.join(',')}`)
            }
          })

          return {
            type: 'spreadsheet',
            data: { sheetName: firstSheet, rowCount: totalRows, rows },
            content: `[ExcelJS Sheet:${firstSheet},Rows:${totalRows}]\n${displayRows.join('\n')}`
          }
        }
      } catch (err: any) {
        throw new Error(`所有解析引擎均失败: ${err.message}`)
      }
    }

    throw new Error(`无法识别或解析该表格文件 (${ext})，请确认文件格式是否正确。`)
  }

  async write(filePath: string, data: any, _ctx: AgentContext): Promise<void> {
    const ext = path.extname(filePath).toLowerCase()
    
    if (ext === '.csv') {
      let rows = data
      if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.rows)) {
        rows = data.rows
      }
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
        await saveAsCsv(rows, filePath)
        return
      }
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Sheet1')
      if (Array.isArray(rows)) {
        rows.forEach((row: any) => sheet.addRow(row))
      }
      await workbook.csv.writeFile(filePath)
      return
    }

    const workbook = new ExcelJS.Workbook()
    
    // 支持多 Sheet 写入
    const sheetsData = data.sheets || (Array.isArray(data) ? [{ rows: data }] : [data])
    
    for (const sheetData of sheetsData) {
      const sheet = workbook.addWorksheet(sheetData.name || sheetData.sheetName || `Sheet${workbook.worksheets.length + 1}`)
      
      // 样式配置：AI 显式传入 > 预设 theme > 默认
      const config = {
        headerBg: sheetData.headerBg || data.headerBg || (sheetData.theme === 'business' || data.theme === 'business' ? '1E3A8A' : undefined),
        headerColor: sheetData.headerColor || data.headerColor || (sheetData.theme === 'business' || data.theme === 'business' ? 'FFFFFF' : '000000'),
        rowAlternateBg: sheetData.rowAlternateBg || data.rowAlternateBg || (sheetData.theme === 'business' || data.theme === 'business' ? 'F9FAFB' : undefined),
        defaultHeight: sheetData.defaultHeight || data.defaultHeight || (sheetData.theme === 'business' || data.theme === 'business' ? 25 : undefined),
        autoWidth: sheetData.autoWidth || data.autoWidth || false
      }
      
      // 设置列信息 (支持 width)
      if (Array.isArray(sheetData.columns)) {
        sheet.columns = sheetData.columns.map((col: any) => ({
          header: col.header,
          key: col.key,
          width: col.width || (config.headerBg ? 15 : undefined),
          style: col.style
        }))
      }

      // 写入行数据
      const rows = sheetData.rows || (Array.isArray(sheetData) ? sheetData : [])
      if (Array.isArray(rows)) {
        rows.forEach((row: any, index: number) => {
          const addedRow = sheet.addRow(row)
          // 设置行高
          if (row && typeof row === 'object' && !Array.isArray(row) && row._height) {
            addedRow.height = row._height
          } else if (config.defaultHeight) {
            addedRow.height = config.defaultHeight
          }

          // 自动应用斑马纹和基本对齐 (如果有配置)
          addedRow.eachCell((cell) => {
            cell.alignment = cell.alignment || { vertical: 'middle', horizontal: 'center' }
            if (config.rowAlternateBg && index % 2 === 1) {
              cell.fill = cell.fill || { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + config.rowAlternateBg.replace('#', '') } }
            }
          })

          // 如果行数据中有样式定义 (优先级最高)
          if (row && typeof row === 'object' && !Array.isArray(row) && row._styles) {
            Object.keys(row._styles).forEach(cellKey => {
              const cell = addedRow.getCell(cellKey)
              Object.assign(cell, row._styles[cellKey])
            })
          }
        })
      }

      // 美化表头 (如果有配置)
      if (config.headerBg) {
        const headerRow = sheet.getRow(1)
        headerRow.height = headerRow.height || 30
        headerRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FF' + config.headerColor.replace('#', '') }, size: 12 }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + config.headerBg.replace('#', '') } }
          cell.alignment = { vertical: 'middle', horizontal: 'center' }
        })
      }

      // 自动列宽
      if (config.autoWidth) {
        sheet.columns.forEach(column => {
          let maxColumnLength = 0
          if (column.header) maxColumnLength = column.header.toString().length
          sheet.eachRow({ includeEmpty: true }, (row) => {
            const cellValue = row.getCell(column.key!).value
            if (cellValue) {
              const cellLength = cellValue.toString().length
              if (cellLength > maxColumnLength) maxColumnLength = cellLength
            }
          })
          column.width = Math.min(50, maxColumnLength + 5)
        })
      }

      // 插入图片支持
      const images = sheetData.images || data.images
      if (Array.isArray(images)) {
        for (const img of images) {
          try {
            const imageId = workbook.addImage({
              filename: img.path,
              extension: path.extname(img.path).slice(1) as any,
            })
            sheet.addImage(imageId, img.range || 'A1:C5')
          } catch (e) {
            _ctx.logger.error(`Failed to add image to Excel: ${e}`)
          }
        }
      }

      // 合并单元格支持
      if (Array.isArray(sheetData.merges)) {
        sheetData.merges.forEach((merge: string | [string, string]) => {
          if (typeof merge === 'string') {
            sheet.mergeCells(merge)
          } else if (Array.isArray(merge) && merge.length === 2) {
            sheet.mergeCells(merge[0], merge[1])
          }
        })
      }

      // 批量样式设置
      if (Array.isArray(sheetData.styles)) {
        sheetData.styles.forEach((styleDef: any) => {
          if (styleDef.cell || styleDef.range) {
            const target = sheet.getCell(styleDef.cell || styleDef.range)
            if (styleDef.font) target.font = styleDef.font
            if (styleDef.fill) target.fill = styleDef.fill
            if (styleDef.alignment) target.alignment = styleDef.alignment
            if (styleDef.border) target.border = styleDef.border
            if (styleDef.numFmt) target.numFmt = styleDef.numFmt
          }
        })
      }
    }

    await workbook.xlsx.writeFile(filePath)
  }
}
