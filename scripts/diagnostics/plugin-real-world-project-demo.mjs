/** Fixed published Project Impact plugin, read-only demonstration on real engine source. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname, sep, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginService } from '../../dist/plugins/service.js'
import { runPlugin } from '../../dist/plugins/runtime.js'

const engineRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),taskRoot=join(engineRoot,'.e2e-tmp/plugin-real-world-20261112/ai')
const root=resolve(process.argv[2]),revision=Number(process.argv[3])
assert(root.startsWith(taskRoot+sep)&&Number.isSafeInteger(revision),'Pass the owned isolated run and fixed published revision')
function noLinks(path){for(let p=path;p!==dirname(p);p=dirname(p))assert(!lstatSync(p).isSymbolicLink(),'Linked paths are not accepted')}
noLinks(root)
const sourceRoot=join(engineRoot,'src/plugins');noLinks(sourceRoot)
function sourceHashes(){const out={};function visit(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);assert(!lstatSync(path).isSymbolicLink(),'Source link would invalidate read-only comparison');if(entry.isDirectory())visit(path);else if(entry.isFile())out[relative(sourceRoot,path).replaceAll('\\','/')]=createHash('sha256').update(readFileSync(path)).digest('hex')}}visit(sourceRoot);return out}
const before=sourceHashes(),service=new PluginService(join(root,'state/plugins')),plugin=await service.snapshot('default','project-impact',revision)
const results=[],changed=['service.ts']
for(const [tool,args]of [['analyze_project',{root:sourceRoot,changed}],['recommend_tests',{root:sourceRoot,changed}],['inspect_cycles',{root:sourceRoot}]]){
  const output=await runPlugin(plugin,tool,args)
  if(tool==='analyze_project'){assert(output.result.files.includes('service.ts'));assert(output.result.affected.includes('runtime.ts'));assert(output.result.edges.some(edge=>edge.from==='runtime.ts'&&edge.to==='service.ts'))}
  if(tool==='recommend_tests')assert(output.result.recommended.some(path=>path.startsWith('__tests__/')&&path.includes('service')),'Real service change must recommend its actual tests')
  results.push({tool,args,result:output.result,artifactCount:output.artifacts.length,durationMs:output.durationMs,status:'passed'})
}
const after=sourceHashes();assert.deepEqual(after,before,'Read-only plugin demonstration changed source bytes')
const evidence={plugin:'project-impact',revision,hash:plugin.hash,sourceRoot,changed,sourceFiles:Object.keys(before).length,sourceBefore:before,sourceAfter:after,sourceUnchanged:true,results,status:'passed'}
const outputDir=join(root,'project-impact');mkdirSync(outputDir,{recursive:true});const outputPath=join(outputDir,`current-project-demo-r${revision}.json`)
writeFileSync(outputPath,JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify({outputPath,revision,sourceFiles:evidence.sourceFiles,sourceUnchanged:true,tools:results.map(r=>r.tool),status:'passed'}))
