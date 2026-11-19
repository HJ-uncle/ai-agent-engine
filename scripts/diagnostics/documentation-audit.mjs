/** Read-only source inventory by default. No engine imports, databases or credentials.
 * --write-catalogue regenerates the HTTP route index and source-derived OpenAPI catalogue.
 * --write-index regenerates the document status inventory; --check-links checks current Markdown.
 * Reports always stay below .e2e-tmp/documentation-refresh/. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontend = path.resolve(process.env.AETHER_FRONTEND_SOURCE_DIR || path.join(root, '../aether-code'))
const output = path.join(root, '.e2e-tmp/documentation-refresh')
fs.mkdirSync(output, { recursive: true })
const slash = value => value.replaceAll('\\', '/')
const tracked = directory => [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean))].sort()
const isDoc = file => (/\.(md|html)$/.test(file) || file === '.env.example' || file === 'docs/docs/openapi.json') && !/(^|\/)(dist|node_modules|bin|out)\//.test(file)
const currentEngine = new Set(['README.md', '.env.example', 'docs/README.md', 'docs/documentation-inventory.md', 'docs/account-login.md', 'docs/account-external-login.md', 'docs/runtime-guide.md', 'docs/context-compression-design.md', 'docs/thinking-mode-config.md', 'docs/multimodal-design.md', 'docs/security-architecture.md', 'docs/session-toolkits.md', 'docs/plugins.md', 'docs/plugin-project-v1.md', 'docs/plugin-ui-contributions.md', 'docs/examples/workbench-extension/README.md', 'docs/docs/getting-started.md', 'docs/docs/overview.md', 'docs/docs/api-spec.md', 'docs/docs/third-party-integration.md', 'docs/docs/system-tools.md', 'docs/docs/bench/performance.md', 'sdk-package/README.md', 'multi-agent-console/README.md'])
const currentDesktop = new Set(['README.md', 'docs/README.md', 'docs/accounts-and-login.md', 'docs/frontend-architecture.md', 'docs/user-guide.md', 'docs/feature-map.md', 'docs/tool-profiles.md', 'docs/browser-workflow-reliability.md', 'docs/editor-code-oss.md', 'docs/project-storage.md', 'docs/work-icon-guidelines.md', 'design-system/aether-code/MASTER.md', 'design-system/aether-code/PAGE-COVERAGE.md'])
const statusNames = { current: '现行指南', contract: '实现契约', operator: '部署/维护流程', generated: '源码生成目录', plugin: '插件 HTML 公开参考/维护', diagnostic: '专项诊断流程（结果按原日期）', history: '历史报告/提案（非当前承诺）', instructions: '运行指令/协作约定（不作为产品手册改写）', asset: '运行页面/示例资产（非说明文档）' }
function documentStatus(repository, file) {
  if (file === 'AGENTS.md' || /(^|\/)(SKILL|AE)\.md$/.test(file) || file.startsWith('.aether/skills/') || file.startsWith('src/skills/')) return 'instructions'
  if (repository === 'desktop' && file.startsWith('docs/plugin-api/')) return 'plugin'
  if ((repository === 'engine' ? currentEngine : currentDesktop).has(file)) return 'current'
  if (file === 'docs/docs/http-routes.md' || file === 'docs/docs/openapi.json') return 'generated'
  if (file.startsWith('openspec/specs/') || file === 'src/tools/model-tool-definitions.contracts.md') return 'contract'
  if (file.startsWith('deploy/') || file.startsWith('docs/operations/') || file.startsWith('scripts/patches/')) return 'operator'
  if (file.startsWith('scripts/')) return 'diagnostic'
  if (file.endsWith('.html')) return 'asset'
  return 'history'
}
const documents = [root, frontend].flatMap(directory => tracked(directory).filter(isDoc).filter(file => fs.existsSync(path.join(directory, file))).map(file => {
  const repository = directory === root ? 'engine' : 'desktop'
  return { repository, file, status: documentStatus(repository, file), bytes: fs.statSync(path.join(directory, file)).size }
}))
const parsed = new Map()
function source(file) {
  if (parsed.has(file)) return parsed.get(file)
  const text = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const constants = new Map(), imports = new Map()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
      const target = path.resolve(path.dirname(file), node.moduleSpecifier.text.replace(/\.js$/, '.ts'))
      const binding = node.importClause?.namedBindings
      if (binding && ts.isNamedImports(binding) && fs.existsSync(target)) for (const entry of binding.elements) imports.set(entry.name.text, [target, entry.propertyName?.text || entry.name.text])
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const result = { text, ast, constants, imports }; parsed.set(file, result); return result
}
const unknown = Symbol('non-literal source expression')
let bindings = new Map()
function literal(node, file, unresolved, depth = 0) {
  if (!node || depth > 20) return unknown
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression, file, unresolved, depth + 1)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isIdentifier(node)) {
    if (bindings.has(node.text)) return bindings.get(node.text)
    const data = source(file), value = data.constants.get(node.text)
    if (value) return literal(value, file, unresolved, depth + 1)
    const imported = data.imports.get(node.text)
    if (imported) return literal(source(imported[0]).constants.get(imported[1]), imported[0], unresolved, depth + 1)
  }
  if (ts.isCallExpression(node) && node.expression.getText() === 'Object.freeze' && node.arguments.length === 1) return literal(node.arguments[0], file, unresolved, depth + 1)
  if (ts.isPropertyAccessExpression(node)) {
    const value = literal(node.expression, file, unresolved, depth + 1)
    if (value && typeof value === 'object' && Object.hasOwn(value, node.name.text)) return value[node.name.text]
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text
    for (const span of node.templateSpans) { const value = literal(span.expression, file, unresolved, depth + 1); if (value === unknown) return unknown; result += String(value) + span.literal.text }
    return result
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = []
    for (const element of node.elements) {
      const value = literal(ts.isSpreadElement(element) ? element.expression : element, file, unresolved, depth + 1)
      if (value === unknown || (ts.isSpreadElement(element) && !Array.isArray(value))) return unknown
      if (ts.isSpreadElement(element)) values.push(...value)
      else values.push(value)
    }
    return values
  }
  if (ts.isBinaryExpression(node)) {
    const left = literal(node.left, file, unresolved, depth + 1), right = literal(node.right, file, unresolved, depth + 1)
    if (left !== unknown && right !== unknown) {
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right
      if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right
    }
  }
  if (ts.isConditionalExpression(node)) {
    const condition = literal(node.condition, file, unresolved, depth + 1)
    if (condition !== unknown) return literal(condition ? node.whenTrue : node.whenFalse, file, unresolved, depth + 1)
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = {}
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) { const value = literal(property.expression, file, unresolved, depth + 1); if (value !== unknown) Object.assign(result, value); else unresolved.push(property.getText()); continue }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
      const name = property.name.getText().replace(/^['"]|['"]$/g, '')
      const value = literal(ts.isPropertyAssignment(property) ? property.initializer : property.name, file, unresolved, depth + 1)
      if (value === unknown) unresolved.push(property.getText()); else result[name] = value
    }
    return result
  }
  return unknown
}
// Read direct HTTP registration prefixes instead of maintaining a second root-route list.
const serverFile = path.join(root, 'src/api/http/server.ts')
const serverSource = source(serverFile), directMounts = new Map()
const isRegister = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(fastify|api)$/.test(node.expression.expression.getText()) && node.expression.name.text === 'register'
function registrationPrefix(node) {
  const missing = []
  const options = node.arguments[1] ? literal(node.arguments[1], serverFile, missing) : {}
  if (options === unknown || missing.some(value => /^(?:prefix\s*:|\.\.\.)/.test(value)) || (options.prefix !== undefined && typeof options.prefix !== 'string')) throw new Error('Unresolved route mount: ' + node.getText())
  return options.prefix || ''
}
const visitMounts = node => {
  if (isRegister(node) && node.arguments[0] && ts.isIdentifier(node.arguments[0])) {
    const imported = serverSource.imports.get(node.arguments[0].text)
    if (imported && slash(path.relative(root, imported[0])).startsWith('src/api/http/routes/')) {
      let prefix = registrationPrefix(node)
      for (let parent = node.parent; parent; parent = parent.parent) if (isRegister(parent) && parent.arguments[0] && (ts.isArrowFunction(parent.arguments[0]) || ts.isFunctionExpression(parent.arguments[0]))) prefix = registrationPrefix(parent) + prefix
      if (directMounts.has(imported[0]) && directMounts.get(imported[0]) !== prefix) throw new Error('Route module mounted at multiple prefixes: ' + imported[0])
      directMounts.set(imported[0], prefix)
    }
  }
  ts.forEachChild(node, visitMounts)
}
visitMounts(serverSource.ast)
if (!directMounts.size) throw new Error('No direct HTTP route registrations found')
// Management pages split HTTP registration from their static assets and storage. Inherit the
// actual mount of the parent route, including helper functions called with its Fastify instance.
const panelRoot = path.join(root, 'src/api/http/routes/admin.ts')
if (directMounts.has(panelRoot)) {
  const parent = source(panelRoot)
  const scan = node => {
    if (ts.isCallExpression(node)) {
      const delegated = ts.isIdentifier(node.expression) && node.arguments[0]?.getText() === 'fastify' ? node.expression :
        isRegister(node) && node.arguments[0] && ts.isIdentifier(node.arguments[0]) ? node.arguments[0] : null
      const target = delegated && parent.imports.get(delegated.text)?.[0]
      if (target && (path.dirname(target) === path.join(root, 'src/api/http/admin') || (path.dirname(target) === path.dirname(panelRoot) && path.basename(target).startsWith('admin-')))) directMounts.set(target,directMounts.get(panelRoot))
    }
    ts.forEachChild(node,scan)
  }
  scan(parent.ast)
}
const routes = [], unresolvedRoutes = []
const routeFiles = tracked(root).filter(file => (file.startsWith('src/api/http/routes/') || (file.startsWith('src/api/http/admin/') && directMounts.has(path.join(root,file))) || file === 'src/workspace/search/routes.ts') && file.endsWith('.ts') && !file.includes('/__tests__/'))
for (const relative of routeFiles) {
  const file = path.join(root, relative), { ast } = source(file)
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(fastify|app|api)$/.test(node.expression.expression.getText())) {
      const method = node.expression.name.text
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'route'].includes(method)) {
        let variants = [new Map()]
        for (let parent = node.parent; parent; parent = parent.parent) if (ts.isForOfStatement(parent) && ts.isVariableDeclarationList(parent.initializer)) {
          const name = parent.initializer.declarations[0].name.getText(), values = literal(parent.expression, file, [])
          if (Array.isArray(values)) variants = variants.flatMap(variant => values.map(value => new Map([...variant, [name, value]])))
        }
        for (const variant of variants) {
        bindings = variant
        const missing = [], route = literal(node.arguments[0], file, missing)
        if (typeof route !== 'string' || !route.startsWith('/')) unresolvedRoutes.push({ file: relative, line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, expression: node.arguments[0]?.getText() })
        else {
          const options = node.arguments.length >= 3 ? literal(node.arguments[1], file, missing) : {}
          // Current nested modules are called by /api/v1 parents. Their caller
          // chain is reviewed with the catalogue; direct mounts come from server.ts.
          const prefix = directMounts.get(file) ?? '/api/v1'
          routes.push({ method: method.toUpperCase(), path: prefix + route, source: relative, line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            schema: options !== unknown ? options.schema || null : null, websocket: options !== unknown && options.websocket === true,
            unresolved: missing.filter(value => !/^(preHandler|handler|config)\s*:/.test(value)) })
        }
        }
        bindings = new Map()
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
const functions = tracked(root).filter(file => /^src\/(core|storage|tools)\/[^/]+\/[^/]+\.ts$/.test(file) && !file.includes('/__tests__/'))
const frontendFeatures = fs.readdirSync(path.join(frontend, 'src/renderer/src/features'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
const report = { generatedAt: new Date().toISOString(), documents, routes, unresolvedRoutes, frontendFeatures, sourceModules: functions }
fs.writeFileSync(path.join(output, 'source-inventory.json'), JSON.stringify(report, null, 2) + '\n')
if (unresolvedRoutes.length) throw new Error('Unresolved route declarations: ' + JSON.stringify(unresolvedRoutes))
const api = { openapi: '3.1.0', info: { title: 'Aether Engine HTTP 路由目录', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  description: '由当前 TypeScript 路由声明生成。地址包含真实前缀；仅静态可解析的 Fastify JSON Schema 被展开。Zod、权限、业务校验及流协议须结合源文件与 api-spec.md；这不是完整请求客户端生成契约。认证同时检查实例令牌（如部署配置）和用户身份，不能用 X-Tenant-ID 切换租户。' },
  servers: [{ url: 'http://127.0.0.1:12323', description: '示例地址；部署时替换为实际 HTTPS 服务' }], paths: {}, 'x-aether-kind': 'source-derived-route-catalogue' }
const routeIdentities = new Set()
for (const route of routes) {
  const identity = route.method + ' ' + route.path.replace(/:[A-Za-z_][\w]*/g, '{}')
  if (routeIdentities.has(identity)) throw new Error('Duplicate normalized HTTP route: ' + identity)
  routeIdentities.add(identity)
  const url = route.path.replace(/:([A-Za-z_][\w]*)/g, '{$1}'), parameters = []
  for (const match of url.matchAll(/\{([^}]+)\}/g)) parameters.push({ name: match[1], in: 'path', required: true, schema: route.schema?.params?.properties?.[match[1]] || { type: 'string' } })
  for (const [name, schema] of Object.entries(route.schema?.querystring?.properties || {})) parameters.push({ name, in: 'query', required: route.schema.querystring.required?.includes(name) || false, schema })
  const operation = { summary: `${route.method} ${route.path}`, tags: [path.basename(route.source, '.ts')],
    description: '参数、权限与响应以链接源码为准。JSON 接口需同时检查 HTTP 状态与业务 code；SSE、WebSocket、下载响应不是统一 JSON。',
    'x-aether-source': `${route.source}:${route.line}`, 'x-aether-schema-status': route.schema ? 'static-fastify-schema' : 'handler-validated-see-source',
    ...(route.websocket ? { 'x-aether-websocket': true } : {}), ...(route.unresolved.length ? { 'x-aether-unresolved-expressions': route.unresolved } : {}),
    ...(parameters.length ? { parameters } : {}), responses: { default: { description: '由对应处理器定义，详情见源码。' } } }
  if (route.schema?.body) operation.requestBody = { content: { 'application/json': { schema: route.schema.body } } }
  api.paths[url] ||= {}; api.paths[url][route.method.toLowerCase()] = operation
}
const catalogue = '# HTTP 路由源码目录\n\n本表覆盖当前 `src/api/http/routes/` 的路由声明，包括主路由调用的协作、浏览器、工作区与 Flow 子模块。由 `node scripts/diagnostics/documentation-audit.mjs --write-catalogue` 生成；不启动引擎、不读取用户数据。根路由与 `/api/v1` 前缀按 [server.ts](../../src/api/http/server.ts) 的挂载关系区分。\n\n权限、流生命周期和请求字段说明见 [API 使用约定](api-spec.md)；机器可读版本为 [OpenAPI 路由目录](openapi.json)。未静态展开的 Zod/业务校验必须读相应处理器，不能把空 schema 理解为接受任意请求。插件开发者使用[公开 HTML 参考](../../../aether-code/docs/plugin-api/dist/index.html)。\n\n| 方法 | 完整路径 | 实现源码 |\n|---|---|---|\n' + routes.map(route => `| ${route.websocket ? 'WS / ' : ''}${route.method} | \`${route.path}\` | [${path.basename(route.source)}:${route.line}](../../${route.source}#L${route.line}) |`).join('\n') + '\n'
const artifacts = new Map([['docs/docs/http-routes.md', catalogue], ['docs/docs/openapi.json', JSON.stringify(api, null, 2) + '\n']])
if (process.argv.includes('--write-catalogue')) for (const [file, text] of artifacts) fs.writeFileSync(path.join(root, file), text)
else if (process.argv.includes('--check-catalogue')) for (const [file, text] of artifacts) if (!fs.existsSync(path.join(root, file)) || fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n') !== text) throw new Error('HTTP catalogue differs from source: ' + file)
console.log(JSON.stringify({ documents: documents.length, routes: routes.length, staticSchemas: routes.filter(route => route.schema).length, desktopFeatures: frontendFeatures.length, report: slash(path.relative(root, output)) + '/source-inventory.json' }))

const indexLink = (repository, file) => slash(path.relative(path.join(root, 'docs'), path.join(repository === 'engine' ? root : frontend, file)))
const guideFor = repository => repository === 'engine' ? 'runtime-guide.md' : indexLink('desktop', 'docs/user-guide.md')
const index = '# 全量文档状态清单\n\n本清单由 `scripts/diagnostics/documentation-audit.mjs --write-index` 从两仓库 Git 文件清单生成，排除依赖、构建产物和忽略的临时资料；包含保留 Web 实现、OpenSpec 变更提案、运行提示词和页面资产，避免把它们误认为现行桌面手册。分类规则与现行文档集合保存在同一脚本中。\n\n本轮源码核对日期：2026-11-17。文档覆盖不是全业务测试通过：清单只列仍存在的资料；保留报告的日期、失败、跳过与测量条件不变；运行指令/Skills 的校对范围见本次刷新记录，工作流与安全约束保留。\n\n当前入口：[文档首页](README.md) · [功能架构与源码](docs/overview.md) · [桌面全部功能](' + indexLink('desktop', 'docs/feature-map.md') + ') · [HTTP 路由](docs/http-routes.md)。\n\n' +
  '| 类型 | 数量 |\n|---|---|\n' + Object.entries(statusNames).map(([key, name]) => `| ${name} | ${documents.filter(doc => doc.status === key).length} |`).join('\n') + '\n\n' +
  ['engine', 'desktop'].map(repository => `## ${repository === 'engine' ? '引擎与保留 Web 仓库' : 'Aether 桌面仓库'}\n\n| 文件 | 状态 | 当前阅读入口 |\n|---|---|---|\n` + documents.filter(doc => doc.repository === repository).map(doc => `| [${doc.file}](<${indexLink(repository, doc.file)}>) | ${statusNames[doc.status]} | ${doc.status === 'history' || doc.status === 'diagnostic' ? `[现行指南](${guideFor(repository)})` : '本文件；相关专题见文档首页'} |`).join('\n')).join('\n\n') + '\n'
const indexPath = path.join(root, 'docs/documentation-inventory.md')
if (process.argv.includes('--write-index')) fs.writeFileSync(indexPath, index)
if (process.argv.includes('--check-index') && (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, 'utf8').replaceAll('\r\n', '\n') !== index)) throw new Error('Document inventory differs: run --write-index and review the status list')

if (process.argv.includes('--check-links')) {
  const errors = [], checked = []
  for (const doc of documents.filter(doc => ['current', 'contract', 'operator', 'generated'].includes(doc.status) && doc.file.endsWith('.md'))) {
    const file = path.join(doc.repository === 'engine' ? root : frontend, doc.file)
    const body = fs.readFileSync(file, 'utf8').replace(/^```[^\r\n]*\r?\n[\s\S]*?^```\s*$/gm, '')
    for (const match of body.matchAll(/\[[^\]\r\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const raw = match[1].replace(/^<|>$/g, '')
      if (/^(https?:|mailto:|data:|codex:)/i.test(raw)) continue
      const [relative, fragment] = raw.split('#')
      const target = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file
      checked.push({ source: doc.repository + '/' + doc.file, target: raw })
      if (!fs.existsSync(target)) errors.push({ source: doc.repository + '/' + doc.file, target: raw, reason: 'missing local target' })
      else if (fragment && /^L\d+$/.test(fragment) && fs.statSync(target).isFile() && Number(fragment.slice(1)) > fs.readFileSync(target, 'utf8').split('\n').length) errors.push({ source: doc.repository + '/' + doc.file, target: raw, reason: 'source line outside file' })
    }
  }
  fs.writeFileSync(path.join(output, 'current-links.json'), JSON.stringify({ checked: checked.length, errors }, null, 2) + '\n')
  console.log(JSON.stringify({ currentLocalLinks: checked.length, errors }))
  if (errors.length) process.exitCode = 1
}
