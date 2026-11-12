// Read-only source inventory. Parses TypeScript AST; never executes Harness code.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('D:/dev/ai-agent-engine/node_modules/typescript/lib/typescript.js');
const repo = 'D:/dev/deepseek-harness';
const output = 'D:/dev/ai-agent-engine/docs/research';
const catalogPath = 'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts';

function source(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(repo, file), 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function literal(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment)
    .map(p => [p.name.text ?? p.name.getText(), literal(p.initializer)]));
  return undefined;
}
const cat = source(catalogPath);
let slots;
function findCatalog(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(cat) === 'CLIENT_SLOT_API') slots = literal(node.initializer);
  ts.forEachChild(node, findCatalog);
}
findCatalog(cat);
if (!Array.isArray(slots)) throw new Error('Missing CLIENT_SLOT_API array');
const rows = new Map(slots.map(slot => [slot.key, { ...slot, runtimeDeclarations: [], registrations: [], injections: [], consumers: [] }]));
const factories = [];
function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'tests', 'test-support', 'lib', 'dist', '.git'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
for (const absolute of walkFiles(path.join(repo, 'packages'))) {
  const file = path.relative(repo, absolute).replaceAll('\\', '/');
  if (file.includes('catalog.ts')) continue;
  const sf = source(file);
  const pointer = node => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const expr = node => literal(node) ?? (node ? node.getText(sf).slice(0, 180) : undefined);
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name) && rows.has(node.name.text)
      && ts.isObjectLiteralExpression(node.initializer)) {
      const decl = literal(node.initializer);
      if (decl.kind && decl.scope) rows.get(node.name.text).runtimeDeclarations.push(pointer(node));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : callee;
      const first = node.arguments[0];
      const key = literal(first);
      if (typeof key === 'string' && rows.has(key)) {
        if (method === 'inject' && /slots/.test(callee)) rows.get(key).injections.push(pointer(node));
        if (['renderSlot', 'renderSlotChain'].includes(method)) rows.get(key).consumers.push(pointer(node));
      }
      if (method === 'register' && /slots/.test(callee) && first && ts.isObjectLiteralExpression(first)) {
        const props = new Map(first.properties.filter(ts.isPropertyAssignment).map(p => [p.name.text ?? p.name.getText(sf), p.initializer]));
        const name = literal(props.get('name'));
        if (rows.has(name)) rows.get(name).registrations.push({ source: pointer(node), key: expr(props.get('key')), id: expr(props.get('id')), component: expr(node.arguments[1]) });
      }
      if (method === 'registerFactory' && /slots/.test(callee) && first && ts.isObjectLiteralExpression(first)) {
        factories.push({ source: pointer(node), declaration: literal(first), component: expr(node.arguments[1]) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
const result = { researchedAt: '2026-11-12', repository: repo, commit: 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159',
  method: 'Static TypeScript AST: generated compile-time catalog cross-referenced with literal runtime declarations, slots registrations/injections and render calls across packages; excludes tests and generated catalogs. Dynamic indirection can require manual follow-up.',
  slotCount: rows.size, slots: [...rows.values()], factories };
fs.writeFileSync(path.join(output, 'harness-frontend-slot-inventory.json'), JSON.stringify(result, null, 2) + '\n');
const escape = s => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = ['| Slot | kind / scope | runtime 声明 | render 消费 | 占用情况 |', '|---|---|---|---|---|'];
for (const row of rows.values()) {
  const decl = row.runtimeDeclarations.map(p => '`' + p + '`').join('<br>') || '参见目录 declaredBy / 手动核验';
  const consumed = row.consumers.map(p => '`' + p + '`').join('<br>') || '委托或动态调用，需结合 owner';
  table.push(`| \`${row.key}\` | ${row.kind} / ${row.scope} | ${decl} | ${consumed} | ${escape(row.occupants.join('; ') || '无内置贡献')} |`);
}
fs.writeFileSync(path.join(output, 'harness-frontend-slot-matrix.md'), '# Harness 前端 Slot 源码矩阵\n\n由 `harness-frontend-slot-inventory.cjs` 静态生成，完整 owner 契约、生命周期与分类见 `harness-frontend-extension-map.md`；原始数据见同目录 JSON。\n\n' + table.join('\n') + '\n');
console.log(JSON.stringify({ slots: rows.size, factories: factories.length,
  missingRuntimeDeclarations: [...rows.values()].filter(x => !x.runtimeDeclarations.length).map(x => x.key),
  missingDirectConsumers: [...rows.values()].filter(x => !x.consumers.length).map(x => x.key) }, null, 2));
