const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(process.argv[2]).toString('latin1');
const anchor = source.indexOf('name:"voice"');
if (anchor < 0) throw new Error('Command registry anchor not found');
const start = source.lastIndexOf('\0', anchor) + 1;
const end = source.indexOf('\0', anchor);
const chunk = source.slice(start, end < 0 ? undefined : end);
const ast = ts.createSourceFile('embedded-command-registry.js', chunk, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const commands=[];
function walk(node) {
  if(ts.isObjectLiteralExpression(node)) {
    const props=new Map(node.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(ast),p.initializer]));
    const name=props.get('name'); const type=props.get('type');
    if(name&&type&&ts.isStringLiteral(name)&&ts.isStringLiteral(type)&&['local','local-jsx','prompt'].includes(type.text)) {
      const field=k=>props.get(k)?.getText(ast);
      commands.push({name:name.text,type:type.text,byteOffset:start+node.getStart(ast),description:field('description'),
        aliases:field('aliases'),argumentHint:field('argumentHint'),availability:field('availability'),
        enabledExpression:field('isEnabled'),hiddenExpression:field('isHidden'),supportsNonInteractive:field('supportsNonInteractive'),
        dynamicGetters:node.properties.filter(ts.isGetAccessorDeclaration).map(p=>p.name.getText(ast)),
        evidenceClass:'Static command definition; registration, gating, account entitlement and execution not verified'});
    }
  }
  ts.forEachChild(node,walk);
}
walk(ast);
fs.writeFileSync('docs/research/claude-2.1.266-evidence/embedded-command-index.json',JSON.stringify({chunkStart:start,chunkSize:chunk.length,commands},null,2));
console.log(JSON.stringify({chunkStart:start,chunkSize:chunk.length,definitions:commands.length,uniqueNames:[...new Set(commands.map(x=>x.name))].sort()},null,2));
