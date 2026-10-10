import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const engineRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const stage=fs.realpathSync(path.resolve(process.argv[2]??'')),output=path.resolve(process.argv[3]??'')
const relative=path.relative(path.join(engineRoot,'.tmp'),output)
if(!process.argv[2]||!process.argv[3]||relative.startsWith('..')||path.isAbsolute(relative)||!output.endsWith('.tgz')||fs.existsSync(output))throw new Error('New contained .tmp test package required')
const manifest=JSON.parse(fs.readFileSync(path.join(stage,'dist/runtime/build-manifest.json'),'utf8'))
for(const file of ['dist/main.js','runtime/node.exe','node_modules/@libsql/client/package.json','node_modules/node-pty/.aether-node-pty-patch.json'])if(!fs.statSync(path.join(stage,file)).isFile())throw new Error('Incomplete stage: '+file)
fs.mkdirSync(path.dirname(output),{recursive:true})
const startedAt=new Date().toISOString()
const require=createRequire(path.join(engineRoot,'sdk-package/package.json'))
const {createTgzSync}=require(path.join(engineRoot,'sdk-package/scripts/tar-helper.js'))
createTgzSync(stage,output,'package')
const receipt={startedAt,finishedAt:new Date().toISOString(),stage,output,buildId:manifest.buildId,bytes:fs.statSync(output).size,sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex'),scope:'Exact isolated production stage archived through the existing SDK tar writer; no install or shared build mutation'}
fs.writeFileSync(output+'.receipt.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(receipt))
