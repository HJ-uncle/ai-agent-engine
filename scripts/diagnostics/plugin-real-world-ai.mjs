/**
 * Opt-in Aether-model acceptance. The runner supplies business contracts but NO
 * plugin implementation. All plugin code and feature iterations come from the
 * configured model through real chat/approval/tool execution.
 *
 * Requires explicit authorization to read the selected development credential.
 * node scripts/diagnostics/plugin-real-world-ai.mjs --run --source-profile <dev profile>
 * --resume <existing isolated run> resumes completed stages and the same chats.
 * --scenario flow-workbench,project-impact limits work without changing evidence.
 * All outputs remain under .e2e-tmp/plugin-real-world-20261112/ai/.
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeScenarios } from './plugin-real-world-scenarios.mjs'
import { collectToolEvidence, durableArtifactEvidence } from './plugin-real-world-evidence.mjs'
import { Script } from 'node:vm'
import { unzipSync } from 'fflate'
import { PluginService } from '../../dist/plugins/service.js'
import { runPlugin } from '../../dist/plugins/runtime.js'
import { stopCommandProcessTree } from '../../dist/core/command-jobs/process-tree.js'

const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1] }
const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const parent = join(engineRoot, '.e2e-tmp/plugin-real-world-20261112/ai')
const root = resolve(option('--resume') || join(parent, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)))
assert(root.startsWith(parent + sep), 'Run output must remain inside the ignored task directory')
assertNoLinks(root)
const sourceProfile = option('--source-profile') || process.env.PLUGIN_ACCEPTANCE_SOURCE_PROFILE
const modelId = option('--model') || 'deepseek-v4.1-flash-1017'
const electron = resolve(engineRoot, '../aether-code/node_modules/electron/dist/electron.exe')
const workspace = join(root, 'workspace'), token = randomBytes(32).toString('hex'), secrets = [token]
const resume = Boolean(option('--resume')), scenarios = makeScenarios(workspace)
const selected = option('--scenario')?.split(',')
if(selected)assert(selected.length>0&&selected.every(id=>id&&scenarios.some(s=>s.id===id)), '--scenario must contain only known, nonempty plugin IDs')
const reviewPrompt = option('--review') ? readFileSync(resolve(option('--review')), 'utf8') : undefined
const extraRequirements = option('--extra-requirements') ? readFileSync(resolve(option('--extra-requirements')), 'utf8') : ''
const promptMap=flag=>option(flag)?Object.fromEntries(Object.entries(JSON.parse(readFileSync(resolve(option(flag)),'utf8'))).map(([id,path])=>{assert(scenarios.some(s=>s.id===id),'Prompt map has unknown scenario ID');return[id,readFileSync(resolve(path),'utf8')]})):{}
const reviewPrompts=promptMap('--review-map'),extraPrompts=promptMap('--extra-map')
const concurrency=Number(option('--concurrency')??1);assert(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=3,'Concurrency must be 1–3')
const authorOnly=process.argv.includes('--author-only')
const delay = ms => new Promise(r => setTimeout(r, ms))
const controller = new AbortController()
let engine, engineClosed, engineStartedAt, base, managerTools, timer, log = '', config
const runTag = root.split(/[\\/]/).at(-1)
const reportPath = join(root, 'report.json')
const report = resume && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {
  root, modelId, sourceProfile, startedAt: new Date().toISOString(), status:'not-started',
  methodology:'Business-contract-guided Aether model authoring; runner contains no plugin implementation. Independent held-out assertions, real approval resume, isolated Electron-hosted engine, selected-plugin chat invocation.',
  productionPluginWrites:false, scenarios:{}, approvals:[],
}
function redact(value) { let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]'); return text }
function assertNoLinks(path){let current=resolve(path);while(true){if(existsSync(current))assert(!lstatSync(current).isSymbolicLink(),'Test output path must not traverse links or junctions: '+current);const next=dirname(current);if(next===current)break;current=next}}
function save(path, value) { const target = join(root,path);assertNoLinks(target); mkdirSync(dirname(target),{recursive:true});writeFileSync(target,redact(value),'utf8') }
function progress(value) { const display={...value};if(typeof display.error==='string'&&display.error.length>1800)display.error=display.error.slice(0,1800)+'… (full evidence saved in run report)';console.log('[plugin-real-ai] '+redact(display));save('report.json',report) }
function cleanEnv() { return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ENCRYPTION_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^DATA_DIR$|^PORT$|^HOST$|^AETHER_|^WORKSPACE_|^SKILLS_|^MCP_|^LLM_/i.test(key))) }
const signal = ms => AbortSignal.any([controller.signal,AbortSignal.timeout(ms)])
const headers = () => ({'content-type':'application/json','x-aether-tool-profile':'general','x-aether-instance-token':token})
async function api(method,route,body) {
  const response=await fetch(base+route,{method,headers:headers(),signal:signal(180_000),...(body===undefined?{}:{body:JSON.stringify(body)})})
  const value=await response.json()
  if(value.code!==200)throw Object.assign(new Error(redact(`${method} ${route}: ${value.message}`)),{responseCode:value.code})
  return value.data
}
async function childResult(exe,args,options,timeout=60_000) {
  return await new Promise((resolveChild,reject)=>{
    const startedAt=Date.now(),child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});let stdout='',stderr=''
    const limit=setTimeout(()=>{stopCommandProcessTree(child,startedAt).then(()=>reject(new Error('Owned child deadline exceeded')),error=>reject(new Error('Owned child cleanup failed: '+error.message)))},timeout)
    child.stdout.on('data',chunk=>stdout+=chunk.toString());child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-40_000))
    child.once('error',error=>{clearTimeout(limit);reject(error)})
    child.once('close',(code,signal)=>{clearTimeout(limit);resolveChild({code,signal,stdout,stderr})})
  })
}
async function credential() {
  assert(sourceProfile,'Pass --source-profile after explicit user authorization; no profile is guessed')
  const db=new DatabaseSync(join(sourceProfile,'engine/state/agent.db'),{readOnly:true});let row
  try {row=db.prepare('SELECT model_id,provider,api_key,base_url,api_format,capabilities FROM models WHERE model_id=? AND is_enabled=1 AND deleted_at IS NULL').get(modelId)}finally{db.close()}
  assert(row,'Selected enabled development model not found')
  const keyRecord=JSON.parse(readFileSync(join(sourceProfile,'engine/secrets/engine-secrets.json'),'utf8'))
  const local=JSON.parse(readFileSync(join(sourceProfile,'Local State'),'utf8'))
  const profile=join(root,'credential-profile');mkdirSync(profile,{recursive:true})
  if(!existsSync(join(profile,'Local State')))writeFileSync(join(profile,'Local State'),JSON.stringify({os_crypt:local.os_crypt}),{flag:'wx',mode:0o600})
  const testKey=resume?undefined:randomBytes(32).toString('hex')
  const encryptedTestKey=resume?JSON.parse(readFileSync(join(root,'isolated-engine-key.encrypted.json'),'utf8')).encryptionKey:undefined
  secrets.push(row.api_key,testKey)
  const output=await childResult(electron,[join(engineRoot,'scripts/diagnostics/plugin-real-world-credentials.cjs')],{env:{...cleanEnv(),PLUGIN_CREDENTIAL_PROFILE:profile,PLUGIN_CREDENTIAL_INPUT:JSON.stringify({keyRecord,encryptedApiKey:row.api_key,testKey,encryptedTestKey})}},30_000)
  assert.equal(output.code,0,'Read-only credential bridge failed')
  const line=output.stdout.split('\n').find(l=>l.startsWith('PLUGIN_CREDENTIAL_RESULT:'));assert(line,'Credential bridge returned no private result')
  const credentials=JSON.parse(line.slice('PLUGIN_CREDENTIAL_RESULT:'.length));secrets.push(credentials.apiKey,credentials.testKey)
  save('isolated-engine-key.encrypted.json',{encrypted:true,encryptionKey:credentials.encryptedTestKey})
  return {key:credentials.testKey,model:{modelId:row.model_id,provider:row.provider,apiKey:credentials.apiKey,baseUrl:row.base_url,apiFormat:row.api_format,...(row.capabilities?{capabilities:JSON.parse(row.capabilities)}:{})}}
}
function fixtures() {
  const files={'src/core.ts':'export const sum = (a: number, b: number) => a + b\n','src/service.ts':"import { sum } from './core.js'; export const total = sum(1, 2)\n",'src/app.ts':"import { total } from './service.js'; export default total\n",'src/independent.ts':'export const independent = true\n','src/core.test.ts':"import { sum } from './core.js'; if(sum(2,3)!==5)throw Error('sum')\n",'src/app.spec.ts':"import app from './app.js'; if(app!==3)throw Error('app')\n",'src/independent.test.ts':"import { independent } from './independent.js'\n",'src/cycle-a.ts':"import './cycle-b.js';export const a=1\n",'src/cycle-b.ts':"import './cycle-a.js';export const b=2\n",'node_modules/ignored/index.ts':"import '../../src/core.js'\n",'.env':'THIS_IS_AN_ISOLATED_TEST_SENTINEL=not-a-real-key\n','.git/ignored.ts':'export const hidden=true\n'}
  for(const [file,content]of Object.entries(files)){const target=join(workspace,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content)}
  if(!existsSync(workspace+'-junction'))symlinkSync(workspace,workspace+'-junction','junction')
  const budgetRoot=workspace+'-file-budget';assertNoLinks(budgetRoot);mkdirSync(budgetRoot,{recursive:true})
  for(let i=0;i<501;i++)writeFileSync(join(budgetRoot,`f${String(i).padStart(3,'0')}.ts`),`export const value${i}=${i}\n`)
}
async function start() {
  const listener=createServer();await new Promise((resolveListen,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolveListen)})
  const port=listener.address().port;await new Promise(r=>listener.close(r));base=`http://127.0.0.1:${port}/api/v1`
  const entry=join(root,'engine-host.mjs')
  writeFileSync(entry,"process.on('message',m=>{if(m?.command==='shutdown')process.emit('SIGTERM')});\nprocess.send?.({kind:'runtime',runtime:{execPath:process.execPath,electron:process.versions.electron,node:process.versions.node,asNode:process.env.ELECTRON_RUN_AS_NODE}});\nawait import("+JSON.stringify(pathToFileURL(join(engineRoot,'dist/main.js')).href)+");\n")
  engineStartedAt=Date.now();engine=spawn(electron,[entry],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...cleanEnv(),ELECTRON_RUN_AS_NODE:'1',DATA_DIR:join(root,'state/agent.db'),MEMORY_DB_PATH:join(root,'state/memory.db'),WORKSPACE_ROOT:workspace,AETHER_GLOBAL_DIR:join(root,'global'),SKILLS_ROOT:join(root,'skills'),MCP_CONFIG_PATH:join(root,'mcp.json'),ENCRYPTION_KEY:config.key,AUTH_ENABLED:'false',AETHER_INSTANCE_TOKEN:token,AETHER_DESKTOP_OWNED:'1',AETHER_ENGINE_HOST:'127.0.0.1',AETHER_ENGINE_PORT:String(port),DEFAULT_SECURITY_MODE:'standard',HISTORY_BACKEND:'jsonl',OSM_MODE:'off',ENABLE_LONG_TERM_MEMORY:'false',MAX_ITERATIONS:'40',LOG_LEVEL:'warn',QA_LOG_ENABLED:'false',LLM_PRIMARY_MODEL:modelId,LLM_MODEL:modelId,LLM_PROVIDER:config.model.provider,LLM_FALLBACK_MODEL:''}})
  engineClosed=new Promise(r=>engine.once('close',(code,signal)=>r({code,signal})))
  engine.on('message',m=>{if(m?.kind==='runtime')report.engineRuntime=m.runtime})
  engine.on('error',error=>progress({engineError:error.message}))
  for(const stream of [engine.stdout,engine.stderr])stream.on('data',chunk=>{log=(log+redact(chunk.toString())).slice(-600_000);save('engine.log',log)})
  for(let i=0;i<90;i++){if(engine.exitCode!==null||engine.signalCode!==null)throw new Error('Isolated engine exited');try{await api('GET','/plugins');break}catch(e){if(i===89)throw e;await delay(1000)}}
  assert(report.engineRuntime?.electron);assert.equal(report.engineRuntime.asNode,'1')
  if(!resume)assert.equal((await api('GET','/plugins')).plugins.length,0,'Fresh test engine must have no existing plugins')
  managerTools=(await api('GET','/toolkits')).toolkits.find(t=>t.id==='plugin-management')?.toolNames
  assert(managerTools?.includes('plugin_get_template'))
  if(!resume)await api('POST','/models',config.model)
  save('capabilities.json',await api('GET','/plugins/project/templates'))
  report.engineBuild=existsSync(join(engineRoot,'dist/runtime/build-manifest.json'))?JSON.parse(readFileSync(join(engineRoot,'dist/runtime/build-manifest.json'),'utf8')):null
}
const runOf=s=>s.executionRun??s.run??s.runs?.at(-1)
function parsed(x){try{return typeof x==='string'?JSON.parse(x):x}catch{return undefined}}
function traces(snapshot){const history=snapshot.history??[],seen=new Set(),output=[];for(const message of history)for(const call of [message.toolCall,...(message.toolCalls??[])].filter(Boolean)){if(seen.has(call.id))continue;seen.add(call.id);const result=history.filter(m=>m.role==='tool'&&m.toolCallId===call.id).at(-1);output.push({id:call.id,name:call.name,args:call.args,success:result?.metadata?.success===true,status:result?.metadata?.status,output:parsed(result?.content),text:result?.content,...(result?.metadata?.outputTruncated?{toolMetadata:{outputTruncated:true,plugin:result.metadata.plugin,changes:result.metadata.changes}}:{})})}return output}
/** Test-only, read-only access to this runner's isolated approval authority. */
function sealedPending(run,publicPending,sessionId){
  const database=join(root,'state/agent.db');assert(database.startsWith(root+sep));assertNoLinks(database)
  const db=new DatabaseSync(database,{readOnly:true});let row
  try{row=db.prepare('SELECT state FROM root_runs WHERE tenant_id=? AND session_id=? AND run_id=?').get('default',sessionId,run.runId)}finally{db.close()}
  assert(row,'Isolated sealed run not found');const stored=JSON.parse(row.state)
  assert.equal(stored.runId,run.runId);assert.equal(stored.sessionId,sessionId);assert.equal(stored.status,'waiting','Only an actually parked isolated run can be answered')
  const pending=stored.pending.find(p=>p.requestId===publicPending.requestId&&p.toolCallId===publicPending.toolCallId)
  assert(pending,'Exact private pending operation not found');assert.equal(pending.toolName,publicPending.toolName);assert.equal(pending.status,'pending')
  assert(pending.pendingAction?.operation,'Private sealed mutation is unavailable')
  return pending
}
async function chat(sessionId,fields,label,toolkits=['plugin-management'],allowedTools=managerTools){
  progress({event:'chat-start',label,sessionId})
  const response=await fetch(base+'/chat',{method:'POST',headers:headers(),signal:signal(900_000),body:JSON.stringify({sessionId,model:modelId,thinkingMode:false,toolkits,allowedTools,workspacePaths:[workspace],memoryScope:'off',skills:[],mcpServers:[],...fields})})
  const text=await response.text();save(label+'.sse.txt',text);assert(text.includes('data:'),'Chat did not return SSE')
  const snapshot=await api('GET','/chat/snapshot?sessionId='+encodeURIComponent(sessionId));save(label+'.snapshot.json',snapshot)
  progress({event:'chat-return',label,status:runOf(snapshot)?.status,history:snapshot.history?.length})
  const streamErrors=text.split(/\r?\n/).filter(line=>line.startsWith('data: {')).map(line=>parsed(line.slice(6))).filter(event=>typeof event?.error==='string')
  if(streamErrors.length&&runOf(snapshot)?.status!=='succeeded'){const error=streamErrors.at(-1);throw new Error(`Chat stream failed [${error.code??'unknown'}]: ${error.error}`)}
  return snapshot
}
async function author(scenario,prompt,label){
  const state=report.scenarios[scenario.id];const sessionId=state.sessionId
  let snapshot
  const previous=resume?await api('GET','/chat/snapshot?sessionId='+encodeURIComponent(sessionId)):undefined
  const waiting=previous&&runOf(previous),oldPublic=waiting?.status==='waiting'&&waiting.pending?.find(p=>p.status!=='answered')
  if(oldPublic){
    const oldPending=sealedPending(waiting,oldPublic,sessionId)
    const oldTarget=oldPending.pendingAction?.operation?.input?.id??oldPending.pendingAction?.operation?.input?.manifest?.id
    save(label+'-recovered-pending.json',oldPending)
    snapshot=await chat(sessionId,{message:`此前待批准操作已拒绝。该请求目标是 ${oldTarget}，本任务唯一允许修改的插件是 ${scenario.id}。不得修改任何其他插件。请重新读取最新模板协议并继续以下需求：\n${prompt}`,toolResponse:{runId:waiting.runId,requestId:oldPending.requestId,toolCallId:oldPending.toolCallId,name:oldPending.toolName,output:'rejected'}},label+'-reject-recovered-pending')
    report.rejections??=[];report.rejections.push({sessionId,toolCallId:oldPending.toolCallId,target:oldTarget,expected:scenario.id,reason:'Recovered pending operation explicitly rejected before continuing the fixed-scope task'})
    if(runOf(snapshot)?.status!=='waiting')snapshot=await chat(sessionId,{message:`此前待批准操作已经拒绝且未执行。本次仅允许修改 ${scenario.id}，不允许其他插件。请读取最新模板和工具说明后继续：\n${prompt}`},label+'-continue-after-rejection')
  }else snapshot=await chat(sessionId,{message:prompt},label+'-initial')
  for(let i=0;i<60;i++){
    const run=runOf(snapshot)
    if(run?.status!=='waiting'){assert.equal(run?.status,'succeeded',`Authoring ${scenario.id} did not finish`);save(label+'-trace.json',traces(snapshot));return snapshot}
    const publicPending=run.pending?.find(p=>p.status!=='answered');assert(publicPending,'Waiting run has no pending operation')
    const pending=sealedPending(run,publicPending,sessionId)
    assert(['plugin_create','plugin_update','plugin_test','plugin_publish'].includes(pending.toolName),'Unexpected authoring interaction: '+pending.toolName)
    const operation=pending.pendingAction?.operation;assert.equal(operation?.tenantId,'default')
    const target=operation.input?.id??operation.input?.manifest?.id
    if(target!==scenario.id){
      save(label+`-rejected-target-${i}.json`,pending);report.rejections??=[];report.rejections.push({sessionId,toolCallId:pending.toolCallId,target,expected:scenario.id,reason:'Wrong plugin target; operation not executed'})
      assert(report.rejections.filter(r=>r.sessionId===sessionId).length<=3,'Repeated wrong-target requests; refusing further automatic recovery')
      snapshot=await chat(sessionId,{message:`拒绝此操作。你请求修改 ${target}，但当前任务固定插件 ID 是 ${scenario.id}。仅可创建或修改 ${scenario.id}，不可改动其他插件。请回到本会话最初需求；重新读取最新模板协议后创建/测试/发布正确插件。`,toolResponse:{runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId,name:pending.toolName,output:'rejected'}},label+`-reject-target-${i}`)
      if(runOf(snapshot)?.status!=='waiting')snapshot=await chat(sessionId,{message:`刚才对 ${target} 的请求已拒绝且未执行。仅可创建或修改 ${scenario.id}。请按完整需求完成正确插件：\n${prompt}`},label+`-rescope-after-rejection-${i}`)
      continue
    }
    save(label+`-approval-${i}.json`,pending);report.approvals.push({label,index:i,tool:pending.toolName,id:target,runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId})
    progress({event:'approve-isolated-operation',label,tool:pending.toolName,id:target,authority:'read-only isolated database seal'})
    snapshot=await chat(sessionId,{message:'',toolResponse:{runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId,name:pending.toolName,output:'approved'}},label+`-resume-${i}`)
  }
  throw new Error('Approval limit exceeded')
}
async function verify(scenario,index,plugin,label){
  assert(plugin.enabled&&plugin.publishedRevision===plugin.revision,'Latest revision is not published/enabled')
  const {application}=await api('GET',`/plugins/runtime/apps/${scenario.id}?revision=${plugin.revision}`)
  assert.equal(application.revision,plugin.revision);assert(application.execution.allowed)
  assert(plugin.manifest.contributes?.pages.some(p=>p.kind==='webview'),'No embedded custom HTML UI')
  assert(plugin.manifest.contributes?.navigation?.length,'No navigation entry')
  assert(plugin.manifest.contributes?.workspaceTabs?.some(t=>t.scope==='session'),'No session workspace contribution')
  for(const page of plugin.manifest.contributes.pages.filter(p=>p.kind==='webview')){
    const html=plugin.files[page.entry];assert(html.trim().length>=200&&/<html\b/i.test(html)&&/<script\b/i.test(html)&&html.includes('aetherPlugin')&&!html.includes('__UI__')&&!html.includes('PLACEHOLDER_UI'),'Custom HTML must contain a real interactive bridge UI, not a placeholder')
    for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
      if(/type\s*=\s*["']application\/json["']/i.test(script[1]))continue
      try{new Script(script[2],{filename:page.entry})}catch(error){throw new Error(`Inline UI JavaScript syntax error in ${page.entry}: ${error.message}`)}
    }
  }
  const cases=scenario.stages.slice(0,index+1).flatMap(s=>s.cases), results=[]
  for(const item of cases){
    let output,error;try{output=await api('POST',`/plugins/runtime/apps/${scenario.id}/invoke`,{revision:plugin.revision,tool:item.tool,args:item.args})}catch(e){error=e}
    if(item.hostReservedKey){
      try{
        assert(error&&error.responseCode===400&&/Body is not valid JSON/.test(error.message),'HTTP must explicitly reject reserved prototype keys before plugin execution')
        results.push({name:'HTTP拒绝保留原型键（宿主输入策略）',tool:item.tool,args:item.args,status:'passed',boundary:'http',rejection:error.message})
        const isolated=new PluginService(join(root,'state/plugins')),snapshot=await isolated.snapshot('default',scenario.id,plugin.revision)
        assertNoLinks(snapshot.directory);assert(snapshot.directory.startsWith(join(root,'state/plugins')+sep))
        const beforeProto=Object.getOwnPropertyDescriptors(Object.prototype)
        output=await runPlugin(snapshot,item.tool,item.args)
        assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),beforeProto,'Runtime call must not change prototype descriptors')
        error=undefined
      }catch(e){error=e}
    }
    try{if(item.reject){assert(error,'Invalid business input incorrectly succeeded');assert(error.responseCode,'Rejection must come from the host, not a network failure')}else{if(error)throw error;item.check(output)}results.push({name:item.name,tool:item.tool,args:item.args,status:'passed',...(item.reject?{rejection:error.message}:{output})})}catch(e){results.push({name:item.name,tool:item.tool,args:item.args,status:'failed',error:e.message,output})}
  }
  save(label+'-business.json',results)
  const failed=results.filter(r=>r.status==='failed');if(failed.length)throw new Error('Independent business assertions failed: '+JSON.stringify(failed))
  return {revision:plugin.revision,hash:application.hash,caseCount:results.length,results}
}
async function exportProject(scenario,plugin){
  for(const file of ['README.md','package.json','scripts/test.mjs','examples/cases.json'])assert(typeof plugin.files[file]==='string'&&plugin.files[file].trim().length>20&&!/^PLACEHOLDER_[A-Z_]+$/.test(plugin.files[file].trim()),'Incomplete standard project file: '+file)
  const packageJson=JSON.parse(plugin.files['package.json']);assert(typeof packageJson.scripts?.test==='string'&&packageJson.scripts.test.includes('scripts/test.mjs'),'package.json must expose the real standalone test entry')
  const machinePaths=[root,root.replaceAll('\\','/'),root.replaceAll('\\','\\\\')]
  const nonPortable=Object.entries(plugin.files).filter(([,content])=>machinePaths.some(p=>content.includes(p))).map(([file])=>file)
  assert.equal(nonPortable.length,0,'Export contains machine-specific acceptance paths in: '+nonPortable.join(', '))
  const externalTemps=Object.entries(plugin.files).filter(([file,content])=>file.startsWith('scripts/')&&/\btmpdir\s*\(/.test(content)).map(([file])=>file)
  assert.equal(externalTemps.length,0,'Project tests must keep temporary fixtures inside project .e2e-tmp, not OS temp: '+externalTemps.join(', '))
  const examples=JSON.parse(plugin.files['examples/cases.json']??'{}').cases
  assert(Array.isArray(examples)&&examples.length>0&&examples.length<=50,'Export must contain bounded, runnable standard examples')
  const exampleResults=[]
  for(const example of examples){
    assert(!example.expectError&&!example.expectedError,'Client examples must be positive runnable cases; keep negative fixtures in a separate tests file')
    assert(Object.hasOwn(example,'expected'),'Every distributed example requires a complete expected result')
    let output
    try{output=await api('POST',`/plugins/runtime/apps/${scenario.id}/invoke`,{revision:plugin.revision,tool:example.tool,args:example.args});assert.deepEqual(output.result,example.expected,'Distributed example expected must exactly match the host business result')}
    catch(error){exampleResults.push({name:example.name,tool:example.tool,args:example.args,status:'failed',error:error.message,output});continue}
    exampleResults.push({name:example.name,tool:example.tool,args:example.args,status:'passed',output})
  }
  save(scenario.id+`/distributed-examples-r${plugin.revision}-${Date.now()}.json`,exampleResults)
  const failedExamples=exampleResults.filter(item=>item.status==='failed')
  assert.equal(failedExamples.length,0,'Distributed host examples failed: '+JSON.stringify(failedExamples.map(item=>({name:item.name,tool:item.tool,error:item.error,actual:item.output?.result}))))
  const {archive}=await api('GET',`/plugins/project/exports/${scenario.id}?revision=${plugin.revision}`)
  const bytes=Buffer.from(archive.base64,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),archive.sha256)
  const zipPath=join(root,'deliverables',archive.fileName);assertNoLinks(zipPath);mkdirSync(dirname(zipPath),{recursive:true});writeFileSync(zipPath,bytes)
  // A new extraction for every verification prevents obsolete files from an
  // earlier revision from making an incomplete ZIP appear self-contained.
  const project=join(root,'projects',scenario.id,`r${plugin.revision}-${randomUUID().slice(0,8)}`);assertNoLinks(project);mkdirSync(project,{recursive:true})
  const extracted=unzipSync(bytes),archiveFiles=Object.keys(extracted)
  assert(archiveFiles.length<=300,'Export archive contains too many entries')
  assert.deepEqual(archiveFiles.sort(),Object.keys({...plugin.files,'aether-plugin.json':''}).sort(),'Export ZIP must contain exactly the authored standard project files')
  let expandedBytes=0
  for(const [file,content]of Object.entries(extracted)){
    assert(!file.includes('\\')&&!file.split('/').some(part=>!part||part==='.'||part==='..'),'Export entry is not a safe relative file')
    const target=resolve(project,file);assert(target.startsWith(project+sep),'Export path escapes project');assertNoLinks(target)
    expandedBytes+=content.length;assert(content.length<=1024*1024&&expandedBytes<=8*1024*1024,'Export exceeds project byte limits')
    const text=new TextDecoder('utf-8',{fatal:true}).decode(content)
    if(file==='aether-plugin.json')assert.deepEqual(JSON.parse(text),plugin.manifest,'Archived manifest must match published manifest')
    else assert.equal(text,plugin.files[file],'Archive entry differs from authored source: '+file)
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content)
  }
  save(scenario.id+`/archive-verification-r${plugin.revision}.json`,{revision:plugin.revision,sha256:archive.sha256,zipPath,project,expandedBytes,entries:Object.entries(extracted).map(([file,data])=>({file,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')})),sourceCompared:true,manifestCompared:true,freshZipExtraction:true,status:'passed'})
  const standalone=await childResult(process.execPath,['scripts/test.mjs'],{cwd:project,env:cleanEnv()},120_000)
  save(scenario.id+`/standalone-r${plugin.revision}-${Date.now()}.json`,standalone);save(scenario.id+'/standalone-test.json',standalone);assert.equal(standalone.code,0,'Independent exported project npm test failed: '+standalone.stderr+'\n'+standalone.stdout)
  return {zipPath,project,sha256:archive.sha256,revision:archive.revision,standaloneExitCode:standalone.code}
}
async function selectedUse(scenario,plugin){
  const published=await new PluginService(join(root,'state/plugins')).snapshot('default',scenario.id,plugin.revision)
  const local=scenario.use.tool,global='plugin_'+scenario.id.replace(/-/g,'_')+'_'+local
  const pluginTools=plugin.manifest.tools.map(tool=>'plugin_'+scenario.id.replace(/-/g,'_')+'_'+tool.name)
  const useTag=Date.now().toString(36),sessionId='use-'+scenario.id+'-'+runTag+'-'+useTag
  const prompt=`请使用我选择的插件处理这项真实业务，实际调用 ${local}，原样使用以下参数：${JSON.stringify(scenario.use.args)}。把结果产物保存到当前工作区，然后简要说明业务结果，不要创建或更新插件。`
  const invocations=[],seenCalls=new Set(),artifactPaths=new Set()
  for(let round=0;round<2;round++){
    const snapshot=await chat(sessionId,{message:round?`请在当前会话再次实际运行同一个插件，参数完全相同，重新生成一份产物，不复用之前的结果。${prompt}`:prompt},scenario.id+'/selected-use-'+useTag+'-'+round,[`plugin-${scenario.id}--r${plugin.revision}`],pluginTools)
    const run=runOf(snapshot);assert.equal(run?.status,'succeeded','Selected plugin chat did not complete')
    const trace=traces(snapshot),call=trace.findLast(t=>t.name===global&&t.success&&!seenCalls.has(t.id));assert(call,'Model did not successfully invoke selected plugin again')
    for(const item of trace)seenCalls.add(item.id)
    assert.deepEqual(call.args,scenario.use.args,'Selected invocation must use the business inputs')
    const fallback=call.output===undefined&&call.toolMetadata?.outputTruncated?durableArtifactEvidence(call,{workspace,plugin:published}):undefined
    const result=fallback?.result??call.output?.result
    scenario.use.expected(result)
    if(fallback)call.artifactEvidence=fallback
    const receipts=fallback?.artifacts??call.output?.artifacts
    assert(receipts?.length,'Selected invocation returned no artifacts')
    const artifacts=receipts.map(a=>{
      const target=resolve(a.path);assert(target.startsWith(workspace+sep),'Artifact receipt must remain inside isolated workspace');assertNoLinks(target)
      assert(!artifactPaths.has(target),'Repeated invocation must deliver a new artifact path');artifactPaths.add(target)
      const bytes=readFileSync(target),sha256=createHash('sha256').update(bytes).digest('hex')
      assert.equal(bytes.byteLength,a.byteLength);assert.equal(sha256,a.sha256??a.expectedHash?.replace(/^sha256:/,''),'Artifact bytes must match durable write receipt')
      return {path:target,byteLength:bytes.byteLength,sha256,verified:true}
    })
    save(scenario.id+'/selected-use-trace-'+useTag+'-'+round+'.json',trace)
    invocations.push({toolCallId:call.id,args:call.args,result,artifacts,status:'passed',businessEvidenceSource:fallback?'durable-json-artifact':'tool-output',outputTruncated:Boolean(fallback),...(fallback?{artifactPath:fallback.artifactPath}:{})})
  }
  return {sessionId,tool:global,args:invocations[0].args,result:invocations[0].result,artifacts:invocations.flatMap(i=>i.artifacts),invocations,status:'passed'}
}
async function scenarioRun(scenario){
  const state=report.scenarios[scenario.id]??={id:scenario.id,title:scenario.title,sessionId:'author-'+scenario.id+'-'+runTag,stages:[],status:'running'}
  if(process.argv.includes('--verify-only')){
    state.status='verifying';progress({event:'verification-start',id:scenario.id})
    const {plugin}=await api('GET','/plugins/'+scenario.id),tag='verification-'+Date.now().toString(36)
    const verification=await verify(scenario,scenario.stages.length-1,plugin,scenario.id+'/'+tag)
    state.export=await exportProject(scenario,plugin)
    state.previousSelectedUses??=[];if(state.selectedUse)state.previousSelectedUses.push(state.selectedUse)
    state.selectedUse=await selectedUse(scenario,plugin);state.verifications??=[];state.verifications.push({tag,revision:plugin.revision,caseCount:verification.caseCount,status:'passed'})
    state.status='passed';delete state.error;progress({event:'verification-passed',id:scenario.id,export:state.export});return
  }
  const scenarioReview=reviewPrompts[scenario.id]??reviewPrompt
  if(state.status==='passed'&&!scenarioReview)return
  if(scenarioReview){
    state.status='reviewing';progress({event:'review-start',id:scenario.id})
    const reviewTag='review-'+Date.now().toString(36)
    await author(scenario,scenarioReview,scenario.id+'/'+reviewTag)
    const {plugin}=await api('GET','/plugins/'+scenario.id)
    if(authorOnly){state.authoringCheckpoints??=[];state.authoringCheckpoints.push({tag:reviewTag,revision:plugin.revision,prompt:scenarioReview,status:'checkpointed',note:'Authoring-only recovery checkpoint; not a completed acceptance or deliverable'});state.status='checkpointed';progress({event:'authoring-checkpoint',id:scenario.id,revision:plugin.revision});return}
    const verification=await verify(scenario,scenario.stages.length-1,plugin,scenario.id+'/'+reviewTag)
    state.reviews??=[];const reviewRecord={tag:reviewTag,revision:plugin.revision,caseCount:verification.caseCount,prompt:scenarioReview,status:'business-passed'};state.reviews.push(reviewRecord)
    state.export=await exportProject(scenario,plugin)
    state.previousSelectedUses??=[];if(state.selectedUse)state.previousSelectedUses.push(state.selectedUse)
    state.selectedUse=await selectedUse(scenario,plugin);reviewRecord.status='passed';state.status='passed';delete state.error;progress({event:'review-passed',id:scenario.id,export:state.export});return
  }
  state.status='running'
  for(let index=state.stages.filter(s=>s.status==='passed').length;index<scenario.stages.length;index++){
    const previousStage=state.stages[index],label=`${scenario.id}/stage-${index}${previousStage?'-retry-'+Date.now().toString(36):''}`;const stage={index,status:'running',startedAt:new Date().toISOString(),startRevision:index?state.stages[index-1].revision:0,attempts:[],...(previousStage?{previousAttempt:previousStage}:{})};state.stages[index]=stage
    const extra=extraPrompts[scenario.id]??extraRequirements,requirement=scenario.stages[index].prompt+(extra?'\n\n附加客户端验收要求：\n'+extra:'')
    save(label+'-requirement.txt',requirement)
    let snapshot=await author(scenario,requirement,label)
    for(let repair=0;repair<=3;repair++){
      try{
        const calls=collectToolEvidence(join(root,scenario.id)),stageCalls=collectToolEvidence(join(root,scenario.id),f=>f.startsWith(`stage-${index}-`))
        assert(calls.some(c=>c.name==='plugin_get_template'&&c.success),'Persisted authoring evidence contains no successful template discovery');assert(calls.some(c=>c.name==='plugin_create'&&c.success),'Persisted authoring evidence contains no successful plugin creation')
        const {plugin}=await api('GET','/plugins/'+scenario.id)
        assert(plugin.revision>stage.startRevision,'This feature iteration did not advance the plugin revision')
        assert(stageCalls.some(c=>c.name===(index?'plugin_update':'plugin_create')&&c.success),'This stage contains no successful new authoring mutation')
        assert(stageCalls.some(c=>c.name==='plugin_test'&&c.success),'This stage contains no successful real plugin test')
        assert(stageCalls.some(c=>c.name==='plugin_publish'&&c.success&&c.args.expectedRevision===plugin.revision),'This stage did not publish its final revision')
        const evidence=await verify(scenario,index,plugin,label+`-attempt-${repair}`)
        stage.status='passed';stage.completedAt=new Date().toISOString();stage.revision=evidence.revision;stage.hash=evidence.hash;stage.caseCount=evidence.caseCount;stage.attempts.push({repair,status:'passed'});save(label+'-plugin.json',plugin);break
      }catch(error){stage.attempts.push({repair,status:'failed',error:redact(error.message)});progress({event:'business-repair-required',id:scenario.id,index,repair,error:error.message});if(repair===3)throw error;snapshot=await author(scenario,`独立业务验收发现以下问题，请在同一插件中修复，保留所有功能并重新测试发布。不要弱化业务约定，也不要修改验收驱动。失败证据：\n${redact(error.message).slice(0,18000)}\n\n为避免上下文压缩丢失本轮要求，完整重申当前任务：\n${requirement}`,label+`-repair-${repair+1}`)}
    }
    progress({event:'stage-passed',id:scenario.id,index,revision:stage.revision,cases:stage.caseCount})
  }
  let {plugin}=await api('GET','/plugins/'+scenario.id)
  try{state.export=await exportProject(scenario,plugin)}catch(error){progress({event:'project-repair-required',id:scenario.id,error:error.message});await author(scenario,`插件实际导出工程的独立测试失败，请修复工程测试可移植性或实现，保留功能并重新测试发布。错误：${error.message}。标准工程 scripts/test.mjs 必须无需 npm install 且在任意路径下能用 Node 执行；不能依赖本机测试 workspace 的绝对路径，项目扫描测试应自行创建并清理工程内临时夹具。`,scenario.id+'/project-repair');({plugin}=await api('GET','/plugins/'+scenario.id));await verify(scenario,scenario.stages.length-1,plugin,scenario.id+'/final-regression');state.export=await exportProject(scenario,plugin)}
  state.selectedUse=await selectedUse(scenario,plugin);state.status='passed';delete state.error;state.completedAt=new Date().toISOString();progress({event:'scenario-passed',id:scenario.id,export:state.export})
}
async function stop(){
  if(!engine)return
  if(engine.connected)engine.send({command:'shutdown'})
  const closed=await Promise.race([engineClosed,delay(12_000).then(()=>null)])
  if(!closed){await stopCommandProcessTree(engine,engineStartedAt);await Promise.race([engineClosed,delay(4000)])}
}
if(!process.argv.includes('--run')){console.log('Opt-in runner. Pass --run and explicit authorized --source-profile. Five model-authored plugins; two receive three feature iterations.');process.exit(0)}
assertNoLinks(root);mkdirSync(root,{recursive:true})
timer=setTimeout(()=>controller.abort(new Error('Overall acceptance deadline exceeded')),120*60_000)
try{
  report.status='running';progress({event:'starting',root,modelId,sourceProfile,resume});config=await credential();fixtures();await start()
  const queue=scenarios.filter(s=>!selected||selected.includes(s.id));let cursor=0
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},async()=>{while(cursor<queue.length){const scenario=queue[cursor++];try{await scenarioRun(scenario)}catch(error){report.scenarios[scenario.id].status='failed';report.scenarios[scenario.id].error=redact(error.stack||error.message);progress({event:'scenario-failed',id:scenario.id,error:error.message})}}}))
  const target=scenarios.filter(s=>!selected||selected.includes(s.id));report.status=target.every(s=>report.scenarios[s.id]?.status==='passed')?'passed':authorOnly&&target.every(s=>report.scenarios[s.id]?.status==='checkpointed')?'checkpointed':'failed';report.completedAt=new Date().toISOString();progress({event:'completed',status:report.status,root});if(report.status==='failed')process.exitCode=1
}catch(error){report.status='failed';report.error=redact(error.stack||error.message);progress({event:'failed',error:report.error});process.exitCode=1}
finally{clearTimeout(timer);await stop();save('report.json',report)}
