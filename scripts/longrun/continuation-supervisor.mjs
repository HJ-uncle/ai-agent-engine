// Owns only the isolated continuation processes. START_DRIVER releases the
// fresh-client/build gates; elapsed preparation never counts as load duration.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Transform } from 'node:stream'
import { continuationDatabaseAudit } from './continuation-database-audit.mjs'
import { captureBuildArtifacts, compareBuildArtifacts } from './build-artifact-identity.mjs'

const exec = promisify(execFile)
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const root = path.resolve(process.argv[2] ?? '')
const state = JSON.parse(fs.readFileSync(path.join(root, 'continuation-state.json'), 'utf8'))
if (path.resolve(state.root) !== root || root === path.resolve(state.sourceRoot)) throw new Error('Distinct retained continuation root required')
const stage = path.resolve(process.env.CONTINUATION_STAGE_ROOT ?? path.resolve(engineRoot, '../aether-code/resources/engine/win32-x64'))
const artifactRoot = path.resolve(process.env.CONTINUATION_ARTIFACT_ROOT ?? engineRoot)
const port = Number(process.env.CONTINUATION_PORT ?? 12499)
const embeddingPort = Number(process.env.CONTINUATION_EMBEDDING_PORT ?? 12501)
for (const value of [port, embeddingPort]) if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error('Invalid test port')
const base = `http://127.0.0.1:${port}`
const token = fs.readFileSync(path.join(root, '.instance-token'), 'utf8').trim()
const environment = { ...process.env }
const envFile = path.join(engineRoot, '.env')
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const text = line.trim(), equal = text.indexOf('=')
  if (!text || text.startsWith('#') || equal < 1) continue
  const key = text.slice(0, equal).trim()
  if (!(key in environment)) environment[key] = text.slice(equal + 1).trim().replace(/^["']|["']$/g, '')
}
const secrets = [token, ...Object.entries(environment).filter(([key,value])=>/key|token|secret|password/i.test(key)&&value?.length>=8).map(([,value])=>value)]
const redact = value => {
  let text = String(value)
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
}
const now = () => new Date().toISOString()
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms))
const write = (file,data) => {const temporary=path.join(root,file+'.tmp');fs.writeFileSync(temporary,JSON.stringify(data,null,2)+'\n');fs.renameSync(temporary,path.join(root,file))}
const append = (file,data) => fs.appendFileSync(path.join(root,file),JSON.stringify(data)+'\n')
async function powershell(script) {
  const {stdout} = await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024})
  return stdout.trim()?JSON.parse(stdout.replace(/^\uFEFF/,'').trim()):[]
}
const processTable = () => powershell("$rows=@(Get-CimInstance Win32_Process | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();name=$_.Name}});ConvertTo-Json -InputObject $rows -Compress")
const identity = row => `${row.pid}:${row.startTicks}`
const owned = new Map(), children = []
async function captureOwned() {
  const table=await processTable(), live=new Map(table.map(row=>[identity(row),row])), accepted=new Map()
  for(const key of owned.keys())if(live.has(key))accepted.set(key,live.get(key))
  let changed=true
  while(changed){changed=false;for(const row of table)if(!accepted.has(identity(row))&&[...accepted.values()].some(parent=>row.parentPid===parent.pid&&BigInt(row.startTicks)>=BigInt(parent.startTicks))){accepted.set(identity(row),row);changed=true}}
  for(const [key,row]of accepted)owned.set(key,row)
  write('continuation-owned-processes.json',{at:now(),roots:children.map(child=>({role:child.role,pid:child.pid,startTicks:child.startTicks})),observed:[...owned.values()],live:[...accepted.values()]})
  return [...accepted.values()]
}
const redactingStream = () => {let buffer='';return new Transform({transform(chunk,_encoding,callback){buffer+=chunk.toString('utf8');const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';for(const line of lines)this.push(redact(line)+'\n');if(buffer.length>1024*1024){this.push(redact(buffer));buffer=''}callback()},flush(callback){if(buffer)this.push(redact(buffer));callback()}})}
async function launch(role, command, args, env=environment, cwd=engineRoot) {
  const child=spawn(command,args,{env,cwd,windowsHide:true,stdio:['ignore','pipe','pipe']})
  child.role=role;child.exit=null;children.push(child)
  child.done=new Promise(resolve=>{child.once('error',error=>{child.exit={code:null,error:redact(error.message)};resolve(child.exit)});child.once('close',(code,signal)=>{child.exit={code,signal};resolve(child.exit)})})
  child.stdout.pipe(redactingStream()).pipe(fs.createWriteStream(path.join(root,`${role}.out.log`),{flags:'a'}))
  child.stderr.pipe(redactingStream()).pipe(fs.createWriteStream(path.join(root,`${role}.err.log`),{flags:'a'}))
  const row=(await processTable()).find(row=>row.pid===child.pid)
  if(row){child.startTicks=row.startTicks;owned.set(identity(row),row);write(`${role}.pid.json`,{at:now(),...row})}
  else if(!child.exit){await wait(250);if(!child.exit)throw new Error(`${role}: process identity unavailable`)}
  return child
}
async function freePort(value) {await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error(`Test port ${value} occupied; refusing to alter existing service`)));server.listen({host:'127.0.0.1',port:value,exclusive:true},()=>server.close(resolve))})}
async function ready(url,child,timeout=90000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){if(child.exit)throw new Error(`${child.role} exited: ${JSON.stringify(child.exit)}`);try{const response=await fetch(url,{signal:AbortSignal.timeout(3000)});if(response.ok)return await response.json()}catch{}await wait(250)}throw new Error(`${child.role} readiness timeout`)}
const initialSource=captureBuildArtifacts(artifactRoot,{requireNodePty:true,requireNodePtyPatch:true})
const initialStage=captureBuildArtifacts(stage,{requireNodePty:true,requireNodePtyPatch:true})
if(!compareBuildArtifacts(initialSource,initialStage).unchanged)throw new Error('Two-end stage differs before startup')
let phase='preparation', abort=null, engine=null, embedding=null, driver=null, finishedAt=null, lastSample=0, healthSequence=0, finalCode=2
const startedAt=now()
const mark=(name,extra={})=>{phase=name;append('continuation-lifecycle.jsonl',{at:now(),phase,...extra});write('supervisor-status.json',{at:now(),startedAt,phase,base,port,embeddingPort,buildId:initialSource.manifest.buildId,driverPid:driver?.pid??null,enginePid:engine?.pid??null,abort,finishedAt})}
process.on('SIGINT',()=>{abort='SIGINT'});process.on('SIGTERM',()=>{abort='SIGTERM'})
try {
  await freePort(port);await freePort(embeddingPort)
  write('continuation-freeze.json',{at:now(),artifactRoot,stageRoot:stage,source:initialSource,stage:initialStage,synchronized:compareBuildArtifacts(initialSource,initialStage)})
  embedding=await launch('embedding',process.execPath,[path.join(engineRoot,'scripts/longrun/local-embedding-service.mjs')],{...environment,CONTINUATION_EMBEDDING_PORT:String(embeddingPort)})
  const semantic=await ready(`http://127.0.0.1:${embeddingPort}/health`,embedding,120000)
  const engineEnv={...environment,NODE_ENV:'production',MAX_CONSECUTIVE_FAILURES:'0',PORT:String(port),HOST:'127.0.0.1',AUTH_ENABLED:'false',AETHER_INSTANCE_TOKEN:token,DATA_DIR:path.join(root,'agent.db'),KNOWLEDGE_DATA_DIR:path.join(root,'knowledge.db'),WORKSPACE_ROOT:state.projectRoot,AETHER_GLOBAL_DIR:path.join(root,'global'),SKILLS_ROOT:path.join(root,'skills'),MCP_CONFIG_PATH:path.join(root,'mcp.json'),QA_LOG_DIR:path.join(root,'logs'),ENABLE_LONG_TERM_MEMORY:'true',DEFAULT_SECURITY_MODE:'standard',DISABLE_TELEMETRY:'true',HISTORY_BACKEND:'jsonl',MAX_ITERATIONS:'0',LLM_FALLBACK_MODEL:'',EMBEDDING_BASE_URL:`http://127.0.0.1:${embeddingPort}/v1`,EMBEDDING_MODEL:'Xenova/paraphrase-multilingual-MiniLM-L12-v2',EMBEDDING_DIMENSIONS:'384',EMBEDDING_API_KEY:'',PRESSURE_RUNTIME_METRICS_FILE:path.join(root,'runtime.jsonl')}
  if(!fs.existsSync(path.join(root,'mcp.json')))fs.writeFileSync(path.join(root,'mcp.json'),'{"mcpServers":{}}\n')
  engine=await launch('engine',path.join(stage,'runtime/node.exe'),['--import',pathToFileURL(path.join(engineRoot,'scripts/longrun/runtime-probe.mjs')).href,path.join(stage,'dist/main.js')],engineEnv,root)
  await ready(base+'/health',engine)
  const response=await fetch(base+'/api/v1/models',{headers:{'x-aether-instance-token':token},signal:AbortSignal.timeout(10000)})
  const modelBody=await response.json()
  if(!response.ok||modelBody.code!==200)throw new Error('Instance token model probe failed')
  const models=state.models.map(modelId=>{const model=modelBody.data.find(item=>item.modelId===modelId&&item.isEnabled);const window=model?.resolvedCapabilities?.contextWindow??model?.capabilities?.contextWindow;if(Number(window)!==100000)throw new Error('Missing enabled 100K model: '+modelId);return{modelId,contextWindow:window,provider:model.provider,capabilities:model.resolvedCapabilities??model.capabilities}})
  write('runtime-preflight.json',{at:now(),models,semantic,base,tokenEnabled:true,isolatedData:true})
  const retainedResources=path.join(root,'resources.json')
  if(fs.existsSync(retainedResources)) {
    const config=JSON.parse(fs.readFileSync(retainedResources,'utf8')),changes=[]
    for(const server of config.inlineMcpServers??[])if(server.id==='continuation'&&server.transportType==='stdio'&&server.args?.[0]===path.join(engineRoot,'scripts/longrun/continuation-mcp-fixture.mjs')) {
      const command=path.join(stage,'runtime/node.exe');if(server.command!==command){changes.push({field:'inlineMcpServers.continuation.command',before:server.command,after:command});server.command=command}
    }
    if(config.semanticEmbedding){const url=`http://127.0.0.1:${embeddingPort}/v1`;if(config.semanticEmbedding.baseUrl!==url){changes.push({field:'semanticEmbedding.baseUrl',before:config.semanticEmbedding.baseUrl,after:url});config.semanticEmbedding.baseUrl=url}}
    write('continuation-resource-runtime-remap.json',{at:now(),buildId:initialSource.manifest.buildId,changes,scope:'Only owned continuation fixture Node and actual embedding service address; original evidence remains at recovery source'})
    write('resources.json',config)
  }
  for(const child of [engine,embedding])await launch(`${child.role}-monitor`,'powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(engineRoot,'scripts/longrun/monitor.ps1'),'-EnginePid',String(child.pid),'-OutputPath',path.join(root,`${child.role}-monitor.jsonl`),'-StopPath',path.join(root,'MONITOR_STOP'),'-MaxMinutes','600'])
  const resources=await launch('resources',process.execPath,[path.join(engineRoot,'scripts/longrun/continuation-resources.mjs'),root,...(fs.existsSync(path.join(root,'resources.json'))?['--verify-crud']:[])],{...environment,CONTINUATION_BASE:base})
  if((await resources.done).code!==0)throw new Error('Actual resource CRUD preflight failed')
  mark('runtime-ready-awaiting-client-and-semantic-gates')
  while(!abort) {
    if(fs.existsSync(path.join(root,'STOP'))){abort='STOP';break}
    if(engine.exit||embedding.exit)throw new Error('Owned runtime exited during continuation')
    if(!driver&&fs.existsSync(path.join(root,'START_DRIVER'))){
      const gate=JSON.parse(fs.readFileSync(path.join(root,'START_DRIVER'),'utf8'))
      if(gate.buildId!==initialSource.manifest.buildId||gate.clientPassed!==true||gate.semanticPassed!==true)throw new Error('Fresh full-client and real semantic acceptance gates required')
      driver=await launch('continuation-driver',process.execPath,[path.join(engineRoot,'scripts/longrun/continuation-driver.mjs')],{...environment,CONTINUATION_BASE:base,CONTINUATION_RUN_ROOT:root,CONTINUATION_SOURCE_RUN_ROOT:state.sourceRoot,CONTINUATION_TOKEN_FILE:path.join(root,'.instance-token'),CONTINUATION_RESOURCES_FILE:path.join(root,'resources.json'),CONTINUATION_HISTORY_ORACLE_FILE:path.join(root,'history-oracle.json'),CONTINUATION_DURATION_MINUTES:'360',CONTINUATION_ATTEMPT_MINUTES:'120',CONTINUATION_MAX_ATTEMPTS:environment.CONTINUATION_MAX_ATTEMPTS??'5'})
      mark('active',{durationMinutes:360,attemptMinutes:120})
    }
    if(driver?.exit&&!finishedAt){finishedAt=now();mark('post-driver-acceptance',{driverExit:driver.exit});write('continuation-driver-exit.json',{at:finishedAt,...driver.exit})}
    if(finishedAt&&fs.existsSync(path.join(root,'FINAL_ACCEPTANCE_DONE'))){finalCode=driver.exit.code===0?0:2;break}
    if(Date.now()-lastSample>=10000){
      lastSample=Date.now();await captureOwned();const start=performance.now()
      try{const health=await fetch(base+'/health',{signal:AbortSignal.timeout(5000)});await health.arrayBuffer();append('continuation-health.jsonl',{at:now(),sequence:healthSequence++,phase,status:health.status,latencyMs:performance.now()-start})}catch(error){append('continuation-health.jsonl',{at:now(),sequence:healthSequence++,phase,status:null,latencyMs:performance.now()-start,error:redact(error.message)})}
      const current=captureBuildArtifacts(artifactRoot,{requireNodePty:true,requireNodePtyPatch:true}),packaged=captureBuildArtifacts(stage,{requireNodePty:true,requireNodePtyPatch:true})
      const source=compareBuildArtifacts(initialSource,current),client=compareBuildArtifacts(initialStage,packaged)
      append('continuation-artifacts.jsonl',{at:now(),phase,source,client})
      if(!source.unchanged||!client.unchanged)throw new Error('Frozen runtime artifacts changed during continuation')
    }
    await wait(1000)
  }
} catch(error){abort=redact(error.stack??error);append('continuation-supervisor-errors.jsonl',{at:now(),phase,error:abort});console.error(abort)}
finally {
  mark('cleanup');fs.writeFileSync(path.join(root,'MONITOR_STOP'),'owned continuation cleanup\n')
  if(driver&&!driver.exit)driver.kill('SIGTERM')
  // Cancel root runs through the actual API before closing the owned runtime.
  if(engine&&!engine.exit)for(const session of state.sessions)try{await fetch(base+'/api/v1/chat/cancel',{method:'POST',headers:{'content-type':'application/json','x-aether-instance-token':token},body:JSON.stringify({sessionId:session.sessionId}),signal:AbortSignal.timeout(10000)})}catch{}
  const errors=[];let inventoryComplete=true
  const cleanupInventory=async()=>{try{return await captureOwned()}catch(error){inventoryComplete=false;errors.push({source:'process-inventory',error:redact(error.message)});return []}}
  await cleanupInventory()
  for(const child of children)if(!child.exit)child.kill('SIGTERM')
  await Promise.race([Promise.all(children.map(child=>child.done)),wait(10000)])
  const remaining=await cleanupInventory()
  // PID reuse cannot authorize a kill: compare exact recorded CreationDate.
  for(const row of remaining)try{await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}';if($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq '${row.startTicks}'){Stop-Process -Id ${row.pid} -Force -ErrorAction Stop};ConvertTo-Json -InputObject @() -Compress`)}catch(error){errors.push({pid:row.pid,error:redact(error.message)})}
  await wait(500)
  const leftover=await cleanupInventory(),databaseAudit=continuationDatabaseAudit(root,stage)
  write('continuation-cleanup.json',{at:now(),inventoryComplete,remaining:leftover,errors,databaseAudit,databases:databaseAudit.databases,processes:children.map(child=>({role:child.role,pid:child.pid,exit:child.exit}))})
  mark('stopped',{exitCode:finalCode,abort})
  console.log(JSON.stringify({root,base,exitCode:finalCode,abort,remaining:leftover.length}))
}
process.exitCode=finalCode
