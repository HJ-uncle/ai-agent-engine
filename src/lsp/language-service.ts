/**
 * Session-scoped TypeScript language service used by remote IDE clients.
 *
 * The desktop client already speaks LSP.  Keeping the service on the engine
 * host means a remote editor gets the same project view as a local editor,
 * while the workspace manager remains the only authority for path safety.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { workspaceManager } from '../workspace/index.js'

export interface LanguageRequestContext { tenantId?: string; sessionId: string; workspaceRoot?: string }
interface OpenDocument { text: string; version: number }
interface Project {
  ctx: LanguageRequestContext
  root: string
  opened: Map<string, OpenDocument>
  service: ts.LanguageService
  host: ts.LanguageServiceHost
  files: string[]
}

const projects = new Map<string, Project>()
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.aether'])
const MAX_FILES = 20_000

function key(ctx: LanguageRequestContext): string { return `${ctx.tenantId ?? 'default'}\u0000${ctx.sessionId}` }
function isSource(file: string): boolean { return /\.(?:[cm]?[jt]sx?|json)$/i.test(file) }
function discover(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    if (found.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) break
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name)); continue }
      const file = path.join(dir, entry.name)
      if (entry.isFile() && isSource(file)) found.push(file)
    }
  }
  walk(root)
  return found
}
function canonical(file: string): string { return path.normalize(path.resolve(file)) }
function safeFile(project: Project, value: string): string {
  let candidate = value
  try { if (candidate.startsWith('file:')) candidate = fileURLToPath(candidate) } catch { throw new Error('无效的文件 URI') }
  if (!path.isAbsolute(candidate)) candidate = path.join(project.root, candidate)
  const resolved = canonical(candidate)
  const relative = path.relative(project.root, resolved)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('文件路径不在当前工作区内')
  return resolved
}
function uri(file: string): string { return pathToFileURL(file).toString() }
function ensureProject(ctx: LanguageRequestContext): Project {
  const workspaceCtx = { ...ctx, tenantId: ctx.tenantId ?? 'default' }
  const actualRoot = ctx.workspaceRoot ? workspaceManager.bind(workspaceCtx, ctx.workspaceRoot) : workspaceManager.getWorkingDirectory(workspaceCtx)
  const root = canonical(actualRoot)
  const id = key(ctx)
  const previous = projects.get(id)
  if (previous && previous.root === root) return previous
  previous?.service.dispose()
  const opened = new Map<string, OpenDocument>()
  const files = discover(root)
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true, allowNonTsExtensions: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs, allowSyntheticDefaultImports: true,
    esModuleInterop: true, skipLibCheck: true, noEmit: true,
  }
  const config = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
  if (config) {
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(config, compilerOptions, {
        ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined,
      })
      if (parsed) Object.assign(compilerOptions, parsed.options)
    } catch { /* malformed project config should not take the remote editor down */ }
  }
  let project!: Project
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => { project.files = [...new Set([...files, ...opened.keys()])]; return project.files },
    getScriptVersion: file => opened.get(canonical(file))?.version.toString() ?? String(Math.max(0, (() => { try { return fs.statSync(file).mtimeMs } catch { return 0 } })())),
    getScriptSnapshot: file => {
      const text = opened.get(canonical(file))?.text ?? (() => { try { return fs.readFileSync(file, 'utf8') } catch { return undefined } })()
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
  }
  project = { ctx, root, opened, service: undefined as unknown as ts.LanguageService, host, files }
  project.service = ts.createLanguageService(host, ts.createDocumentRegistry())
  projects.set(id, project)
  return project
}
function position(params: any): { file: string; offset: number } {
  const file = params?.textDocument?.uri ?? params?.uri ?? params?.filePath
  if (typeof file !== 'string') throw new Error('缺少 textDocument.uri')
  const project = params.__project as Project
  const target = safeFile(project, file)
  const source = project.opened.get(target)?.text ?? fs.readFileSync(target, 'utf8')
  const p = params.position ?? { line: 0, character: 0 }
  const line = Math.max(0, Number(p.line) || 0)
  const character = Math.max(0, Number(p.character) || 0)
  const sourceFile = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true)
  const safeLine = Math.min(line, Math.max(0, sourceFile.getLineStarts().length - 1))
  return { file: target, offset: Math.min(sourceFile.getPositionOfLineAndCharacter(safeLine, character), source.length) }
}
function lspRange(file: string, start: number, end: number, project?: Project): any {
  const text = project?.opened.get(file)?.text ?? fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const a = source.getLineAndCharacterOfPosition(Math.max(0, start)); const b = source.getLineAndCharacterOfPosition(Math.max(0, end))
  return { start: { line: a.line, character: a.character }, end: { line: b.line, character: b.character } }
}
function edit(file: string, start: number, end: number, newText: string, project?: Project): any { return { range: lspRange(file, start, end, project), newText } }
function display(value: ts.SymbolDisplayPart[] | undefined): string | undefined { return value?.map(part => part.text).join('') }
function docs(value: ts.SymbolDisplayPart[] | undefined): string | undefined { return display(value) }
function toLocation(project: Project, value: ts.FileTextChanges): any {
  const file = safeFile(project, value.fileName)
  return { uri: uri(file), edits: value.textChanges.map(change => edit(file, change.span.start, change.span.start + change.span.length, change.newText, project)) }
}
function commandResult(project: Project, method: string, params: any): any {
  if (method === 'initialize') return { capabilities: { completionProvider: { resolveProvider: true, triggerCharacters: ['.', '"', "'", '/', '@', '<'] }, hoverProvider: true, definitionProvider: true, referencesProvider: true, renameProvider: { prepareProvider: true }, documentFormattingProvider: true, documentRangeFormattingProvider: true, documentSymbolProvider: true, documentHighlightProvider: true, signatureHelpProvider: { triggerCharacters: ['(', ',', '<'], retriggerCharacters: [','] }, codeActionProvider: { codeActionKinds: ['quickfix', 'refactor', 'source'], resolveProvider: false } } }
  if (method === 'shutdown' || method === 'exit' || method === 'initialized') return null
  if (method === 'textDocument/didOpen') { const p = params.textDocument; const file = safeFile(project, p.uri); project.opened.set(file, { text: String(p.text ?? ''), version: Number(p.version) || 1 }); return null }
  if (method === 'textDocument/didChange') { const p = params.textDocument; const file = safeFile(project, p.uri); const last = p.contentChanges?.at(-1)?.text; if (typeof last === 'string') project.opened.set(file, { text: last, version: Number(p.version) || (project.opened.get(file)?.version ?? 0) + 1 }); return null }
  if (method === 'textDocument/didClose') { project.opened.delete(safeFile(project, params.textDocument.uri)); return null }
  if (method === 'completionItem/resolve') { const item = params as any; const file = safeFile(project, item.data?.file ?? item.data?.uri ?? item.uri ?? ''); const details = project.service.getCompletionEntryDetails(file, Number(item.data?.offset ?? 0), item.label, undefined, undefined, undefined, undefined); return details ? { ...item, detail: display(details.displayParts), documentation: docs(details.documentation) } : item }
  const loc = position({ ...params, __project: project })
  const lsp = (span: ts.TextSpan): any => edit(loc.file, span.start, span.start + span.length, '', project)
  if (method === 'textDocument/hover') { const info = project.service.getQuickInfoAtPosition(loc.file, loc.offset); if (!info) return null; return { contents: [{ language: 'typescript', value: display(info.displayParts) ?? '' }, ...(info.documentation?.length ? [{ value: docs(info.documentation) }] : [])], range: info.textSpan ? lspRange(loc.file, info.textSpan.start, info.textSpan.start + info.textSpan.length, project) : undefined } }
  if (method === 'textDocument/completion') { const result = project.service.getCompletionsAtPosition(loc.file, loc.offset, { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true }); return result ? { isIncomplete: false, items: result.entries.map(entry => ({ label: entry.name, kind: entry.kind === 'function' ? 3 : entry.kind === 'class' ? 7 : entry.kind === 'module' ? 9 : 6, sortText: entry.sortText, data: { file: loc.file, offset: loc.offset, label: entry.name }, insertText: entry.name })) } : null }
  if (method === 'textDocument/definition') { const defs = project.service.getDefinitionAndBoundSpan(loc.file, loc.offset)?.definitions ?? []; return defs.map(def => { const file = safeFile(project, def.fileName); return { uri: uri(file), range: lspRange(file, def.textSpan.start, def.textSpan.start + def.textSpan.length, project) } }) }
  if (method === 'textDocument/references') { return (project.service.findReferences(loc.file, loc.offset) ?? []).flatMap(group => group.references.map(ref => { const file = safeFile(project, ref.fileName); return { uri: uri(file), range: lspRange(file, ref.textSpan.start, ref.textSpan.start + ref.textSpan.length, project) } })) }
  if (method === 'textDocument/prepareRename') { const info = project.service.getRenameInfo(loc.file, loc.offset, { allowRenameOfImportPath: true }); if (!info.canRename || !info.triggerSpan) return null; return { range: lspRange(loc.file, info.triggerSpan.start, info.triggerSpan.start + info.triggerSpan.length, project), placeholder: info.displayName } }
  if (method === 'textDocument/rename') { const info = project.service.getRenameInfo(loc.file, loc.offset, { allowRenameOfImportPath: true }); if (!info.canRename) return null; const changes: Record<string, any[]> = {}; for (const item of project.service.findRenameLocations(loc.file, loc.offset, false, false, true) ?? []) { const file = safeFile(project, item.fileName); (changes[uri(file)] ??= []).push(edit(file, item.textSpan.start, item.textSpan.start + item.textSpan.length, String(params.newName ?? ''))) }; return { changes } }
  if (method === 'textDocument/formatting' || method === 'textDocument/rangeFormatting') { const options = params.options ?? {}; const range = method.endsWith('rangeFormatting') ? { start: params.range?.start?.line ?? 0, end: params.range?.end?.line ?? Number.MAX_SAFE_INTEGER } : undefined; const changes = range ? project.service.getFormattingEditsForRange(loc.file, 0, Number.MAX_SAFE_INTEGER, options) : project.service.getFormattingEditsForDocument(loc.file, options); return changes.map(change => edit(loc.file, change.span.start, change.span.start + change.span.length, change.newText, project)) }
  if (method === 'textDocument/signatureHelp') { const result = project.service.getSignatureHelpItems(loc.file, loc.offset, undefined); return result ? { signatures: result.items.map(item => ({ label: display(item.prefixDisplayParts) + item.parameters.map(p => display(p.displayParts)).join(display(item.separatorDisplayParts) ?? ', ') + display(item.suffixDisplayParts), documentation: docs(item.documentation), parameters: item.parameters.map(p => ({ label: display(p.displayParts), documentation: docs(p.documentation) })) })), activeSignature: result.selectedItemIndex ?? 0, activeParameter: result.argumentIndex ?? 0 } : null }
  if (method === 'textDocument/documentSymbol') { return project.service.getNavigationTree(loc.file)?.childItems?.map(item => ({ name: item.text, kind: item.kind === 'function' ? 12 : item.kind === 'class' ? 5 : 13, range: lspRange(loc.file, item.spans[0]?.start ?? 0, (item.spans[0]?.start ?? 0) + (item.spans[0]?.length ?? 0), project), selectionRange: lspRange(loc.file, item.spans[0]?.start ?? 0, (item.spans[0]?.start ?? 0) + (item.spans[0]?.length ?? 0), project) })) ?? [] }
  if (method === 'textDocument/documentHighlight') { return (project.service.getDocumentHighlights(loc.file, loc.offset, [loc.file]) ?? []).flatMap(group => group.highlightSpans.map(span => ({ range: lspRange(loc.file, span.textSpan.start, span.textSpan.start + span.textSpan.length, project), kind: span.kind === ts.HighlightSpanKind.writtenReference ? 3 : span.kind === ts.HighlightSpanKind.reference ? 2 : 1 }))) }
  if (method === 'textDocument/codeAction') { const start = params.range?.start ? position({ ...params, position: params.range.start, __project: project }).offset : loc.offset; const end = params.range?.end ? position({ ...params, position: params.range.end, __project: project }).offset : loc.offset; const fixes = project.service.getCodeFixesAtPosition(loc.file, start, end, [], {}, {}); return fixes.map(fix => ({ title: fix.description, kind: 'quickfix', edit: { changes: Object.fromEntries(fix.changes.map(change => [uri(safeFile(project, change.fileName)), change.textChanges.map(c => edit(safeFile(project, change.fileName), c.span.start, c.span.start + c.span.length, c.newText, project))])) } })) }
  return null
}

export function handleLanguageRequest(ctx: LanguageRequestContext, method: string, params: any = {}): any {
  const project = ensureProject(ctx)
  return commandResult(project, method, { ...params, __project: project })
}

export function disposeLanguageProject(ctx: Pick<LanguageRequestContext, 'tenantId' | 'sessionId'>): void {
  const id = key(ctx); projects.get(id)?.service.dispose(); projects.delete(id)
}
