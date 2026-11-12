/** Read-only full example diagnostics against a fixed isolated published revision. */
import assert from 'node:assert/strict'
import { resolve, join, sep } from 'node:path'
import { lstatSync, existsSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { PluginService } from '../../dist/plugins/service.js'
import { runPlugin } from '../../dist/plugins/runtime.js'

const root=resolve(process.argv[2]),id=process.argv[3]
const taskRoot=resolve('.e2e-tmp/plugin-real-world-20261112/ai')
assert(root.startsWith(taskRoot+sep)&&/^[a-z][a-z0-9-]+$/.test(id),'Only an explicit isolated task plugin may be reviewed')
for(let p=root;p!==resolve(p,'..');p=resolve(p,'..'))if(existsSync(p))assert(!lstatSync(p).isSymbolicLink(),'No linked review roots')
const service=new PluginService(join(root,'state/plugins')),record=await service.get('default',id),plugin=await service.snapshot('default',id,record.publishedRevision)
const examples=JSON.parse(plugin.files['examples/cases.json']).cases,results=[]
for(const example of examples){
  try{const output=await runPlugin(plugin,example.tool,example.args);results.push({name:example.name,tool:example.tool,args:example.args,status:isDeepStrictEqual(output.result,example.expected)?'passed':'mismatch',expected:example.expected,actual:output.result})}
  catch(error){results.push({name:example.name,tool:example.tool,args:example.args,status:'failed',error:error.message})}
}
const evidence={id,revision:plugin.revision,hash:plugin.hash,layer:'direct runtime diagnostic; final acceptance still uses HTTP host examples',results}
const path=join(root,id,`example-review-r${plugin.revision}.json`)
writeFileSync(path,JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify({path,id,revision:plugin.revision,total:results.length,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status!=='passed').map(r=>r.name)}))
