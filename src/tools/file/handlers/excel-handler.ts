import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readCsvAsJson, saveAsCsv } from 'jtcsv'
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
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'))
    
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
    const sheet = workbook.addWorksheet(data.sheetName || 'Sheet1')
    
    if (Array.isArray(data.rows)) {
      data.rows.forEach((row: any[]) => {
        sheet.addRow(row)
      })
    } else if (Array.isArray(data)) {
      data.forEach((row: any[]) => {
        sheet.addRow(row)
      })
    }

    await workbook.xlsx.writeFile(filePath)
  }
}
