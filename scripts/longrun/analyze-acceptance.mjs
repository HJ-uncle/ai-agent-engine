// Independent final evidence audit. Never starts an engine or reads model credentials.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {expectedContractTests} from './project-driver.mjs'

const digest=value=>createHash('sha256').update(value).digest('hex')
const time=value=>typeof value==='number'?value:Date.parse(value)
const terminal=new Set(['succeeded','failed','cancelled','interrupted','timed_out','blocked'])
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'))
const optionalJson=file=>fs.existsSync(file)?json(file):null
const jsonl=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[]
export function initialProtectedAudit(projectRoot,manifest,initial){
  projectRoot=path.resolve(projectRoot)
  const problems=[],files=new Map(Object.entries(initial?.hashes??{}).map(([file,hash])=>[path.resolve(file),hash]))
  const within=(parent,file)=>{const relative=path.relative(parent,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))}
  const report=(kind,file)=>problems.push(`${kind}: ${path.relative(projectRoot,file).replaceAll('\\','/')}`)
  const protectedNames=new Set(manifest?.protectedPaths??[])
  if(files.has(path.join(projectRoot,'manifest.json')))protectedNames.add('manifest.json')
  for(const protectedName of protectedNames){
    const protectedPath=path.resolve(projectRoot,protectedName)
    if(!within(projectRoot,protectedPath)){problems.push('Initial protected path escapes project root: '+protectedName);continue}
    const expected=new Map([...files].filter(([file])=>within(protectedPath,file)))
    if(!expected.size){report('Initial protected hash evidence absent',protectedPath);continue}
    const directories=new Set()
    for(const file of expected.keys())if(file!==protectedPath){for(let dir=path.dirname(file);within(protectedPath,dir);dir=path.dirname(dir)){directories.add(dir);if(dir===protectedPath)break}}
    const observed=new Set()
    const visit=file=>{
      observed.add(file)
      let stat;try{stat=fs.lstatSync(file)}catch{report('Initial protected artifact missing',file);return}
      if(stat.isSymbolicLink()){report('Initial protected artifact replaced by symlink',file);return}
      if(stat.isDirectory()){
        if(!directories.has(file))report('Initial protected directory added',file)
        for(const name of fs.readdirSync(file))visit(path.join(file,name))
      }else if(stat.isFile()){
        if(!expected.has(file))report('Initial protected artifact added',file)
        else if(digest(fs.readFileSync(file))!==expected.get(file))report('Initial protected artifact changed',file)
      }else report('Initial protected artifact has unsupported type',file)
    }
    visit(protectedPath)
    for(const file of expected.keys())if(!observed.has(file))report('Initial protected artifact missing',file)
    for(const directory of directories)if(!observed.has(directory))report('Initial protected directory missing',directory)
  }
  return {passed:problems.length===0,problems:[...new Set(problems)]}
}
function testTotals(text,expected){
  const values={tests:[],pass:[],fail:[],skipped:[],cancelled:[],todo:[]}
  for(const line of text.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/)){const m=line.match(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/);if(m)values[m[1]].push(Number(m[2]))}
  const totals=Object.fromEntries(Object.entries(values).map(([name,counts])=>[name,counts.reduce((a,b)=>a+b,0)]))
  const complete=values.tests.length>0&&Object.values(values).every(counts=>counts.length===values.tests.length)
  return {...totals,complete,expected,passed:complete&&totals.tests===expected&&totals.pass===expected&&totals.fail===0&&totals.skipped===0&&totals.cancelled===0&&totals.todo===0}
}
function expectedTests(workspace,command){return expectedContractTests(workspace,Array.isArray(command)?{args:command}:command)}
export function auditDevelopmentBaseline({baseline,rawText,role,files,expected,modelStartedAt}){
  const problems=[],summary=testTotals(rawText??'',expected),first=role.stages[0].testCommand
  if(!baseline||JSON.stringify(baseline.testCommand)!==JSON.stringify(first))problems.push('development baseline command does not match protected first-stage contract')
  if(!summary.complete||summary.tests!==expected||summary.fail<=0||summary.pass+summary.fail!==expected||summary.skipped||summary.cancelled||summary.todo)problems.push('raw development baseline is not complete and failing')
  const process=baseline?.verification
  if(!Number.isInteger(process?.exitCode)||process.exitCode===0||process.timedOut!==false||process.signal!==null||process.error)problems.push('development baseline test process did not finish normally with a failing exit')
  if(!Number.isFinite(time(baseline?.at))||!Number.isFinite(time(modelStartedAt))||time(baseline.at)>time(modelStartedAt))problems.push('development baseline does not precede model work')
  const old=Array.isArray(baseline?.files)?baseline.files:[],current=Array.isArray(files)?files:[]
  const complete=list=>JSON.stringify(list.map(file=>file?.file).sort())===JSON.stringify([...role.allowedFiles].sort())&&list.every(file=>/^[a-f0-9]{64}$/.test(file?.sha256??''))
  if(!complete(old))problems.push('owned implementation baseline is missing or malformed')
  if(!complete(current))problems.push('current owned implementation evidence is missing or malformed')
  if(!current.some(file=>old.some(original=>original?.file===file?.file&&original?.sha256!==file?.sha256)))problems.push('owned implementation did not change from red baseline')
  return {passed:problems.length===0,problems,summary}
}
// Terminal command history is intentionally bounded (100/session by default).
// A missing final row may be recovered only from two raw engine surfaces, never
// result.json/agentTestRuns. A retained contradictory DB row cannot be bypassed.
export function archivedCommandEvidence({snapshot,events,rootState,session,command,after,expected,jobIndex}){
  const root=snapshot?.run
  if(!rootState||rootState.sessionId!==session.sessionId||rootState.status!=='succeeded'||rootState.actualModelId!==session.config.model||snapshot?.sessionId!==session.sessionId||snapshot.finished!==true||root?.runId!==rootState.runId||root.turnId!==rootState.turnId||root.sessionId!==session.sessionId||root.status!=='succeeded'||root.actualModelId!==rootState.actualModelId)return []
  const equalPath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.isAbsolute(a)&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase()
  const sameInvocation=args=>args?.command==='node'&&JSON.stringify(args.args)===JSON.stringify(command.args)&&equalPath(args.cwd,session.workspace)
  const fields=['schemaVersion','jobId','sessionId','ownerSessionId','runId','ownerRunId','turnId','toolCallId','version','status','command','args','cwd','background','createdAt','updatedAt','finishedAt','exitCode','signal','cursor','earliestCursor']
  const signature=job=>JSON.stringify(fields.map(field=>job?.[field]))
  const owned=call=>call?.toolCallId&&call.rootRunId===rootState.runId&&call.turnId===rootState.turnId&&(call.name??call.toolName)==='execute_cmd'
  const inRun=at=>Number.isFinite(time(at))&&time(at)>=time(rootState.createdAt)&&time(at)<=time(rootState.finishedAt)+2
  return (snapshot.commandJobs??[]).filter(job=>{
    if(!job.jobId||jobIndex.has(job.jobId)||job.schemaVersion!==1||job.sessionId!==session.sessionId||job.ownerSessionId!==session.sessionId||job.runId!==rootState.runId||job.turnId!==rootState.turnId||!job.toolCallId||job.ownerRunId!==undefined&&job.ownerRunId!==rootState.runId||!sameInvocation(job)||job.status!=='succeeded'||job.exitCode!==0||!inRun(job.createdAt)||!inRun(job.finishedAt)||time(job.finishedAt)<time(job.createdAt)||time(job.finishedAt)+2<after)return false
    const starts=events.filter(event=>{const call=event.data?.toolCall;let args=call?.args;if(typeof args==='string'){try{args=JSON.parse(args)}catch{return false}}return owned(call)&&call.toolCallId===job.toolCallId&&sameInvocation(args)&&inRun(event.at)&&time(event.at)<=time(job.finishedAt)})
    if(!starts.length)return false
    return events.some(event=>{
      const end=event.data?.toolEnd??event.data?.toolResult,metadata=end?.metadata
      return owned(end)&&end.toolCallId===job.toolCallId&&end.success===true&&end.status==='succeeded'&&metadata?.exitCode===0&&metadata.outputTruncated===false&&metadata.rootRunId===rootState.runId&&metadata.turnId===rootState.turnId&&signature(metadata.commandJob)===signature(job)&&inRun(event.at)&&time(event.at)+2>=time(job.finishedAt)&&testTotals(end.output??'',expected).passed
    })
  }).map(job=>({...job,source:'archived-command-evidence',dbRetentionGap:true}))
}
function overlap(intervals){
  const points=[];for(const interval of intervals)if(interval.to>interval.from)points.push({at:interval.from,id:interval.sessionId,d:1},{at:interval.to,id:interval.sessionId,d:-1})
  points.sort((a,b)=>a.at-b.at);const active=new Map(),duration={};let previous,max=0
  for(let i=0;i<points.length;){const at=points[i].at;if(previous!==undefined&&at>previous){duration[active.size]=(duration[active.size]??0)+at-previous;max=Math.max(max,active.size)}while(i<points.length&&points[i].at===at){const point=points[i++],count=(active.get(point.id)??0)+point.d;if(count>0)active.set(point.id,count);else active.delete(point.id)}previous=at}
  return {maxConcurrentSessions:max,durationByCountMs:duration,allFiveOverlapMs:duration[5]??0}
}
const quantiles=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);const q=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]:null;return {p50:q(.5),p95:q(.95),p99:q(.99),max:sorted.at(-1)??null}}
export function telemetryAudit(root){
  const lifecycle=jsonl(path.join(root,'lifecycle.jsonl')),healthRows=jsonl(path.join(root,'health.jsonl')),monitorRows=jsonl(path.join(root,'monitor.jsonl')),runtimeRows=jsonl(path.join(root,'runtime.jsonl'))
  const enginePid=Number(optionalJson(path.join(root,'engine.pid.json'))?.pid)
  const ownerKnown=Number.isSafeInteger(enginePid)&&enginePid>0
  const ownerRuntime=ownerKnown?runtimeRows.filter(row=>row.pid===enginePid):[]
  const ignoredRuntime=ownerKnown?runtimeRows.filter(row=>row.pid!==enginePid):runtimeRows
  const phaseAt=at=>{let phase='unknown';for(const event of lifecycle)if(time(event.at)<=time(at))phase=event.phase;return phase}
  const requiredPhases=new Set(['model_preflight','preflight','baseline','active','finalization','cooldown','client_acceptance'])
  const health={};for(const phase of new Set(healthRows.map(row=>row.phase))){const rows=healthRows.filter(row=>row.phase===phase),success=rows.filter(row=>row.status===200&&!row.error);health[phase]={samples:rows.length,ok:success.length,failures:rows.length-success.length,allObservedLatencyMs:quantiles(rows.map(row=>row.latencyMs)),successfulLatencyMs:quantiles(success.map(row=>row.latencyMs))}}
  const healthFailures=healthRows.filter(row=>requiredPhases.has(row.phase)&&(row.status!==200||row.error))
  const samples=monitorRows.filter(row=>row.type==='sample'),activeSamples=samples.filter(row=>phaseAt(row.at)==='active'),activeRuntime=ownerRuntime.filter(row=>row.type==='runtime-sample'&&phaseAt(row.at)==='active')
  const metric=(rows,key)=>Math.max(0,...rows.map(row=>Number(row[key])||0))
  const diagnostics=monitorRows.flatMap(row=>row.type==='error'?[{at:row.at,type:'monitor-error',message:row.message}]:row.type==='sample'?(row.errors??[]).map(message=>({at:row.at,type:'resource-sample-error',message})):[])
  const fatalMonitorErrors=diagnostics.filter(row=>row.type==='monitor-error'),runtimeWriteErrors=ownerRuntime.filter(row=>(row.writeErrors??0)>0)
  const fatal=[]
  if(!health.active?.samples)fatal.push('No active health probes')
  if(healthFailures.length)fatal.push(`${healthFailures.length} non-startup/non-cleanup HTTP health failures`)
  if(!activeSamples.length)fatal.push('No active process-tree resource coverage')
  if(!ownerKnown)fatal.push('Main-thread runtime owner PID evidence is absent or invalid')
  if(!activeRuntime.length)fatal.push('No active main-thread runtime coverage')
  if(fatalMonitorErrors.length)fatal.push('Resource monitor fatal error')
  if(runtimeWriteErrors.length)fatal.push('Runtime probe write errors')
  return {passed:fatal.length===0,fatal,health,healthFailures,resources:{scope:'engine process tree',samples:samples.length,activeSamples:activeSamples.length,firstActiveAt:activeSamples[0]?.at,lastActiveAt:activeSamples.at(-1)?.at,peakRssBytes:metric(activeSamples,'rssBytes'),peakPrivateBytes:metric(activeSamples,'privateBytes'),peakHandles:metric(activeSamples,'handles'),peakThreads:metric(activeSamples,'threads'),peakProcesses:metric(activeSamples,'processCount'),peakCpuOneCorePercent:metric(activeSamples,'cpuOneCorePercent'),peakCpuMachinePercent:metric(activeSamples,'cpuMachinePercent'),observedCpuSeconds:samples.at(-1)?.observedCpuSeconds??null,diagnostics,stop:monitorRows.findLast(row=>row.type==='stop')},runtime:{scope:'recorded engine PID main thread only; excludes descendants',enginePid:ownerKnown?enginePid:null,ignoredRecords:ignoredRuntime.length,ignoredPids:[...new Set(ignoredRuntime.map(row=>row.pid))],activeSamples:activeRuntime.length,firstActiveAt:activeRuntime[0]?.at,lastActiveAt:activeRuntime.at(-1)?.at,maxEventLoopDelayMs:Math.max(0,...activeRuntime.map(row=>row.delayMs?.max??0)),intervalP95DelayMs:quantiles(activeRuntime.map(row=>row.delayMs?.p95)),peakEventLoopUtilization:Math.max(0,...activeRuntime.map(row=>row.eventLoop?.utilization??0)),peakMainRssBytes:Math.max(0,...activeRuntime.map(row=>row.memory?.rssBytes??0)),peakHeapUsedBytes:Math.max(0,...activeRuntime.map(row=>row.memory?.heapUsedBytes??0)),gcCount:activeRuntime.reduce((sum,row)=>sum+(row.gc?.count??0),0),gcDurationMs:activeRuntime.reduce((sum,row)=>sum+(row.gc?.durationMs??0),0),writeErrors:runtimeWriteErrors}}
}
function projected(column,field,alias=field){return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${field}') END AS "${alias}"`}
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
function databaseBackend(root){
  const identity=optionalJson(path.join(root,'two-end-build-identity.json'))
  // A formal run must use its recorded packaged native backend. Never silently
  // fall back to vanilla SQLite, which cannot understand libSQL ANN indexes.
  const packageRoot=path.resolve(identity?.packagedRoot??sourceRoot)
  const require=createRequire(path.join(packageRoot,'package.json'))
  return {Database:require('libsql'),evidence:{kind:'native-libsql',packageRoot,packageVersion:json(path.join(path.dirname(require.resolve('libsql')),'package.json')).version,selection:identity?.packagedRoot?'recorded-packaged-runtime':'source-runtime-fixture'}}
}
function vanillaCompatibility(file){
  let db;const out={kind:'node:sqlite',nodeVersion:process.version,sqliteVersion:process.versions.sqlite,authoritative:false,scope:'Compatibility diagnostic only; native libSQL integrity decides acceptance'}
  try{
    db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON')
    for(const [field,pragma] of [['quickCheck','quick_check'],['integrityCheck','integrity_check']])try{out[field]=db.prepare(`PRAGMA ${pragma}`).all().map(row=>Object.values(row)[0])}catch(error){out[field+'Error']=error.message}
  }catch(error){out.error=error.message}finally{db?.close()}
  return out
}
export function databaseAudit(root){
  const results=[];let states={rootRuns:[],children:[],commands:[]}
  let backend,backendError
  try{backend=databaseBackend(root)}catch(error){backendError=error.message}
  for(const [name,relative] of [['agent','agent.db'],['memory','memory/memory.db'],['knowledge','knowledge.db']]){
    const file=path.join(root,relative),out={name,file,exists:fs.existsSync(file),passed:false}
    if(!out.exists){out.error='Database not exercised or absent; not counted as an integrity pass';results.push(out);continue}
    let db
    try{
      if(backendError)throw new Error('Recorded native database backend unavailable: '+backendError)
      const uri=pathToFileURL(file);uri.searchParams.set('mode','ro')
      db=new backend.Database(uri.href);db.exec('PRAGMA query_only=ON')
      out.backend={...backend.evidence,sqliteVersion:db.prepare('SELECT sqlite_version() AS version').get().version,readonlyUri:uri.href,queryOnly:db.prepare('PRAGMA query_only').get().query_only}
      out.quickCheck=db.prepare('PRAGMA quick_check').all().map(row=>Object.values(row)[0]);out.integrityCheck=db.prepare('PRAGMA integrity_check').all().map(row=>Object.values(row)[0]);out.foreignKeyViolations=db.prepare('PRAGMA foreign_key_check').all()
      out.passed=out.backend.queryOnly===1&&out.quickCheck.length===1&&out.quickCheck[0]==='ok'&&out.integrityCheck.length===1&&out.integrityCheck[0]==='ok'&&out.foreignKeyViolations.length===0
      if(name==='agent'){
        const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name))
        for(const name of ['root_runs','subagent_runs','command_jobs'])if(!tables.has(name))throw new Error(`Missing state table ${name}`)
        // Select only public state fields. The private request/credential fields are never queried.
        states.rootRuns=db.prepare(`SELECT run_id AS runId,session_id AS sessionId,turn_id AS turnId,json_valid(state) AS valid,${['status','modelId','actualModelId','createdAt','finishedAt'].map(field=>projected('state',field)).join(',')} FROM root_runs ORDER BY seq`).all()
        states.children=db.prepare(`SELECT run_id AS runId,parent_session_id AS parentSessionId,status AS persistedStatus,json_valid(snapshot) AS valid,${['status','modelId','parentConversationId','parentToolCallId','startedAt','finishedAt'].map(field=>projected('snapshot',field)).join(',')} FROM subagent_runs ORDER BY created_at`).all()
        states.commands=db.prepare(`SELECT job_id AS jobId,session_id AS sessionId,status AS persistedStatus,json_valid(snapshot) AS valid,${['status','runId','ownerRunId','command','args','cwd','exitCode','createdAt','finishedAt'].map(field=>projected('snapshot',field)).join(',')} FROM command_jobs`).all().map(row=>({...row,args:typeof row.args==='string'?JSON.parse(row.args):row.args}))
        out.nonterminal=[...states.rootRuns.map(row=>({table:'root_runs',...row})),...states.children.map(row=>({table:'subagent_runs',...row})),...states.commands.map(row=>({table:'command_jobs',...row}))].filter(row=>!row.valid||!terminal.has(row.status)||(row.persistedStatus&&row.persistedStatus!==row.status))
        out.passed&&=out.nonterminal.length===0
      }
    }catch(error){out.error=error.message;out.passed=false}finally{db?.close()}
    if(name==='memory')out.vanillaCompatibility=vanillaCompatibility(file)
    results.push(out)
  }
  return {passed:results.length===3&&results.every(result=>result.passed),databases:results,states}
}

export function analyze(root){
  root=path.resolve(root)
  const orchestrator=optionalJson(path.join(root,'orchestrator-result.json'))
  if(!orchestrator?.cleanupConfirmed)throw new Error('Final database audit requires completed orchestrator.cleanupConfirmed=true')
  const report=optionalJson(path.join(root,'active-report.json')),startedReport=optionalJson(path.join(root,'active-start.json')),problems=[],notes=[]
  const fail=message=>problems.push(message)
  if(!report)fail('Formal driver report absent: formal workload was not completed')
  const projectRoot=report?.projectRoot??startedReport?.projectRoot??path.resolve(root,'../..'),manifest=optionalJson(report?.manifestFile??startedReport?.manifestFile??path.join(projectRoot,'manifest.json'))
  if(!manifest)fail('Retained-project manifest absent')
  const sessions=report?.sessions??(startedReport?.sessions??[]).map(session=>optionalJson(path.join(root,`session-${session.index}.json`))??session),attempts=[],rawIntervals=[]
  const databases=databaseAudit(root),rootIndex=new Map(databases.states.rootRuns.map(row=>[row.runId,row])),childIndex=new Map(databases.states.children.map(row=>[row.runId,row])),jobIndex=new Map(databases.states.commands.map(row=>[row.jobId,row]))
  if(!databases.passed)fail('Database integrity or persisted terminal-state check failed')
  const telemetry=telemetryAudit(root)
  for(const reason of telemetry.fatal)fail(reason)
  if(sessions.length!==5)fail('Exactly five formal sessions not found')
  const groups=new Map();for(const session of sessions){const key=path.resolve(session.workspace);groups.set(key,[...(groups.get(key)??[]),session]);}
  const sharing=[...groups].map(([workspace,rows])=>({workspace,sessionIds:rows.map(row=>row.sessionId),projectIds:[...new Set(rows.map(row=>row.projectId))],roles:rows.map(row=>row.roleId)}))
  if(sharing.length!==2||JSON.stringify(sharing.map(group=>group.sessionIds.length).sort())!=='[2,3]'||sharing.some(group=>group.projectIds.length!==1))fail('Projects do not share exactly 3 + 2 sessions in two real directories')
  if(sessions.filter(s=>s.config?.model==='qwen3.8-flash').length!==3)fail('Exactly three formal Qwen configurations not found')
  const qualifiedByRole=new Map(),historicalChildren=[]
  for(const session of sessions){
    const protectedRole=manifest?.projects?.find(project=>project.id===session.projectId)?.roles?.find(role=>role.id===session.roleId)
    if(!protectedRole)fail(`${session.roleId}: report role is absent from protected manifest`)
    else if(JSON.stringify(protectedRole)!==JSON.stringify(session.role))fail(`${session.roleId}: report role differs from protected manifest`)
    const sessionDirectory=path.join(root,'sessions',`session-${session.index}`)
    const directories=fs.existsSync(sessionDirectory)?fs.readdirSync(sessionDirectory).filter(name=>/^stage-\d+-attempt-\d+$/.test(name)).sort((a,b)=>Number(a.match(/stage-(\d+)/)[1])-Number(b.match(/stage-(\d+)/)[1])||Number(a.match(/attempt-(\d+)/)[1])-Number(b.match(/attempt-(\d+)/)[1])):[]
    if(directories.length!==(session.rounds?.length??0))fail(`${session.roleId}: report hides or omits on-disk attempts`)
    const accepted=new Set()
    for(const name of directories){
      const dir=path.join(sessionDirectory,name),result=optionalJson(path.join(dir,'result.json'))
      if(!result){
        fail(`${session.roleId}/${name}: unfinished attempt retained`)
        const stage=Number(name.match(/stage-(\d+)/)[1]),attempt=Number(name.match(/attempt-(\d+)/)[1]),events=jsonl(path.join(dir,'events.jsonl'));let running=null,lastRoot
        for(const event of events){const at=time(event.at),run=event.data?.run;if(run)lastRoot=run;if(run?.status==='running'&&running===null)running=at;else if(run?.status&&run.status!=='running'&&running!==null){rawIntervals.push({sessionId:session.sessionId,from:running,to:at});running=null}}
        const persisted=rootIndex.get(lastRoot?.runId)
        if(running!==null){const end=time(persisted?.finishedAt??events.at(-1)?.at);if(Number.isFinite(end))rawIntervals.push({sessionId:session.sessionId,from:running,to:end})}
        attempts.push({sessionId:session.sessionId,roleId:session.roleId,stage,attempt,claimedSuccess:false,independentlyQualified:false,reasons:['unfinished attempt killed before result.json'],rootStatus:persisted?.status??lastRoot?.status,actualModelId:persisted?.actualModelId??lastRoot?.actualModelId,driverFailureKinds:[]})
        continue
      }
      const stage=session.role.stages.find(stage=>stage.index===result.round)
      if(!stage){fail(`${session.roleId}/${name}: unknown requirement`);continue}
      const reasons=[];const reject=message=>reasons.push(message)
      const expected=expectedTests(session.workspace,stage.testCommand),verification=testTotals(fs.existsSync(path.join(dir,'verification.txt'))?fs.readFileSync(path.join(dir,'verification.txt'),'utf8'):'',expected)
      if(result.verification?.exitCode!==0||!verification.passed)reject('independent tests not exact/pass/no-skip')
      const rootState=rootIndex.get(result.runId)
      if(!rootState||rootState.sessionId!==session.sessionId||rootState.status!=='succeeded'||rootState.actualModelId!==session.config.model)reject('DB root outcome/model mismatch')
      const events=jsonl(path.join(dir,'events.jsonl'));let running=null
      for(const event of events){const at=time(event.at),run=event.data?.run;if(run?.actualModelId&&run.actualModelId!==session.config.model)reject('observed fallback/actual model mismatch');if(run?.status==='running'&&running===null)running=at;else if(run?.status&&run.status!=='running'&&running!==null){rawIntervals.push({sessionId:session.sessionId,from:running,to:at});running=null}}
      if(running!==null){const last=time(events.at(-1)?.at);if(Number.isFinite(last))rawIntervals.push({sessionId:session.sessionId,from:running,to:last});notes.push(`${session.roleId}/${name}: final running interval ends at last raw event; persisted outcome audited separately`)}
      const children=optionalJson(path.join(dir,'subagents.json'))??[]
      const persistedChildren=databases.states.children.filter(child=>child.parentSessionId===session.sessionId&&child.parentConversationId===rootState?.turnId)
      if(JSON.stringify(persistedChildren.map(child=>child.runId).sort())!==JSON.stringify(children.map(child=>child.runId).sort()))reject('DB child runs omitted from attempt evidence')
      for(const child of children){historicalChildren.push({sessionId:session.sessionId,stage:stage.index,attempt:result.attempt,runId:child.runId,status:child.status,stopReason:child.stopReason,errorCode:child.error?.code});const stored=childIndex.get(child.runId);if(!stored||stored.parentSessionId!==session.sessionId||stored.parentConversationId!==rootState?.turnId||stored.status!==child.status||stored.modelId!==session.config.model)reject('child DB/current-turn/model evidence mismatch')}
      const required=stage.acceptance?.minReviewerAgents>1||stage.index%3===0||stage.index===session.role.stages.length?['A','B']:['A']
      const hash=digest(JSON.stringify((result.files??[]).map(file=>[file.file,file.sha256])))
      const latestWrite=Math.max(0,...(result.files??[]).map(file=>file.modifiedAtMs))
      for(const role of required){const review=result.reviews?.[role],stored=childIndex.get(review?.runId);if(!review||!stored||stored.status!=='succeeded'||review.hash!==hash||stored.modelId!==session.config.model||time(review.startedAt)+2<latestWrite)reject(`review ${role} missing/stale/not successful`)}
      const after=Math.max(latestWrite,...required.map(role=>time(result.reviews?.[role]?.finishedAt)).filter(Number.isFinite))
      const jobs=databases.states.commands.filter(job=>job.runId===result.runId&&job.command==='node'&&JSON.stringify(job.args)===JSON.stringify(stage.testCommand.args)&&path.resolve(job.cwd??'').toLowerCase()===path.resolve(session.workspace).toLowerCase()&&job.status==='succeeded'&&job.exitCode===0&&time(job.finishedAt)+2>=after).map(job=>({...job,source:'final-database',dbRetentionGap:false}))
      if(!jobs.length)jobs.push(...archivedCommandEvidence({snapshot:optionalJson(path.join(dir,'snapshot.json')),events,rootState,session,command:stage.testCommand,after,expected,jobIndex}))
      if(jobs.some(job=>job.dbRetentionGap))notes.push(`${session.roleId}/${name}: final DB command history retention gap; raw snapshot and SSE command invocation, ownership, successful exit and exact test counts agree`)
      if(!jobs.length)reject('actual Agent test missing/stale/wrong cwd')
      for(const violation of [...(result.protectedViolations??[]),...(result.ownershipViolations??[])])reject('reported protection/ownership violation '+violation.file)
      const actualWrites=[...events.flatMap(event=>event.data?.toolCall?[event.data.toolCall]:[]),...children.flatMap(child=>child.toolCalls??[])]
      for(const call of actualWrites)if(['write_file','edit_file'].includes(call.name??call.toolName)){let args=call.args??call.arguments;if(typeof args==='string'){try{args=JSON.parse(args)}catch{reject('unparseable write arguments');continue}}const file=args?.path??args?.filePath??args?.file_path;if(typeof file!=='string'||!session.role.allowedFiles.some(allowed=>path.resolve(session.workspace,allowed).toLowerCase()===path.resolve(session.workspace,file).toLowerCase()))reject('observed non-owned write')}
      if(result.errors?.length||result.permissionRequests?.length)reject('runtime/permission event')
      if(protectedRole?.requiresDevelopment){
        const baseline=optionalJson(path.join(root,`${session.roleId}-development-baseline.json`)),rawFile=path.join(root,`${session.roleId}-development-baseline.txt`)
        const development=auditDevelopmentBaseline({baseline,rawText:fs.existsSync(rawFile)?fs.readFileSync(rawFile,'utf8'):'',role:protectedRole,files:result.files,expected:expectedTests(session.workspace,protectedRole.stages[0].testCommand),modelStartedAt:rootState?.createdAt??rootState?.startedAt})
        for(const reason of development.problems)reject(reason)
      }
      const qualified=reasons.length===0&&result.success===true
      if(result.success===true&&!qualified)fail(`${session.roleId}/${name}: false-green accepted attempt: ${[...new Set(reasons)].join('; ')}`)
      if(qualified)accepted.add(stage.index)
      attempts.push({sessionId:session.sessionId,roleId:session.roleId,stage:stage.index,attempt:result.attempt,claimedSuccess:result.success,independentlyQualified:qualified,reasons:[...new Set(reasons)],driverFailureKinds:result.failureKinds,testSummary:verification,rootStatus:rootState?.status,actualModelId:rootState?.actualModelId,agentTestJobIds:jobs.map(job=>job.jobId),agentTestEvidence:jobs.map(job=>({jobId:job.jobId,source:job.source,dbRetentionGap:job.dbRetentionGap})),reviewRunIds:required.map(role=>result.reviews?.[role]?.runId)})
    }
    qualifiedByRole.set(session.roleId,accepted)
    if(accepted.size!==session.role.stages.length)fail(`${session.roleId}: ${accepted.size}/${session.role.stages.length} requirements independently qualified`)
    const final=session.rounds?.at(-1)
    for(const file of final?.files??[]){const absolute=path.resolve(session.workspace,file.file);if(!fs.existsSync(absolute)||digest(fs.readFileSync(absolute))!==file.sha256)fail(`${session.roleId}: source changed after final acceptance ${file.file}`)}
  }
  const concurrency=overlap(rawIntervals)
  if(concurrency.allFiveOverlapMs<=0)fail('Raw SSE does not establish positive-duration actual five-running-session overlap')
  const initial=optionalJson(path.join(root,'protected-baseline.json'))??optionalJson(path.join(projectRoot,'scaffold-validation.json'))
  if(!initial)fail('Initial protected contract hash evidence absent')
  const protectedAudit=initialProtectedAudit(projectRoot,manifest,initial)
  for(const problem of protectedAudit.problems)fail(problem)
  const integrations=[]
  for(const project of manifest?.projects??[]){const rows=sessions.filter(session=>session.projectId===project.id);const expected=rows.reduce((sum,session)=>sum+expectedTests(session.workspace,session.role.stages.at(-1).testCommand),0);const file=path.join(root,`${project.id}-integration.txt`),totals=testTotals(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'',expected);integrations.push({projectId:project.id,...totals});if(!totals.passed)fail(`${project.id}: final full-project integration counts not passed`)}
  const client=optionalJson(path.join(root,'client-acceptance.json'))
  if(!client?.passed)fail('Actual client acceptance absent or failed; packaged engine identity is not UI acceptance')
  const projectUi=optionalJson(path.join(root,'project-ui-acceptance.json'))
  if(!projectUi?.passed||projectUi.projects?.length!==2||!projectUi.cleanupConfirmed)fail('Real Chromium project workflow/restart acceptance absent or failed')
  const identity=optionalJson(path.join(root,'two-end-build-identity.json')),build=optionalJson(path.join(root,'build-artifact-evidence.json'))
  if(!identity?.synchronized?.unchanged||!build?.unchangedThroughoutObservedChecks)fail('Two-end build identity or frozen build artifact checks failed')
  const nodePtyCovered=Boolean(build?.nodePtyCoverage===true&&identity?.source?.nodePtyProduction?.present&&identity?.packaged?.nodePtyProduction?.present&&build?.finalCheck?.finalArtifacts?.nodePtyProduction?.present)
  if(build?.nodePtyCoverage!==undefined&&!nodePtyCovered)fail('Declared node-pty build coverage lacks present source/package/final runtime evidence')
  if(build?.nodePtyCoverage===undefined)notes.push('This older run captured dist/SQLite identity only; node-pty dependency content drift was not monitored and cannot be inferred from later harness changes.')
  const nodePtyPatchCovered=Boolean(build?.nodePtyPatchCoverage===true&&identity?.source?.nodePtyProduction?.patchReceipt?.valid&&identity?.packaged?.nodePtyProduction?.patchReceipt?.valid&&build?.finalCheck?.finalArtifacts?.nodePtyProduction?.patchReceipt?.valid)
  if(build?.nodePtyPatchCoverage!==undefined&&!nodePtyPatchCovered)fail('Declared node-pty patch coverage lacks verified source/package/final receipts')
  if(build?.nodePtyPatchCoverage===undefined)notes.push('This older run did not verify or hash a deterministic node-pty patch receipt; later patch verification does not apply retrospectively.')
  const cleanup=optionalJson(path.join(root,'cleanup-processes.json')),cancelEvents=jsonl(path.join(root,'cleanup-cancellations.jsonl'))
  if(!cleanup||cleanup.remaining?.length)fail('Owned process cleanup evidence missing/incomplete')
  if(orchestrator.exitCode!==0||report?.acceptance?.passed!==true)fail('Driver/orchestrator did not accept the formal run')
  const rejectedCancellations=cancelEvents.filter(row=>!row.ok)
  if(rejectedCancellations.length)notes.push(`${rejectedCancellations.length} cleanup cancellation requests failed; preserved independently of final terminal states`)
  const formalSessionIds=new Set(sessions.map(session=>session.sessionId))
  const persistedFormalChildren=databases.states.children.filter(row=>formalSessionIds.has(row.parentSessionId))
  const childFailures=persistedFormalChildren.filter(row=>row.status!=='succeeded'),failedAttempts=attempts.filter(row=>!row.independentlyQualified)
  notes.push('Monitor scope: engine process tree only, including Agent commands and database processes; excludes independent driver test subprocesses and Electron client resources.')
  notes.push('Database actualModelId verifies engine routing metadata. Gateway model implementation and provider physical capacity are outside locally observable evidence.')
  notes.push('A short cooldown and one formal run do not establish leak-free behavior, maximum server capacity, four-hour continuity or 7×24 unattended operation.')
  const result={at:new Date().toISOString(),root,passed:problems.length===0,problems,notes,projectSharing:sharing,concurrency,requirements:[...qualifiedByRole].map(([roleId,set])=>({roleId,qualifiedStages:[...set].sort((a,b)=>a-b)})),rates:{attempts:attempts.length,qualifiedAttempts:attempts.length-failedAttempts.length,failedAttempts:failedAttempts.length,recoveredRequirements:[...qualifiedByRole.values()].reduce((sum,set)=>sum+set.size,0),childRuns:persistedFormalChildren.length,historicalChildFailures:childFailures.length},attempts,failedAttempts,historicalChildFailures:childFailures,integrations,databases,telemetry,protectedAudit,clientAcceptance:{present:!!client,passed:client?.passed??false},projectUiAcceptance:{present:!!projectUi,passed:projectUi?.passed??false},cleanup:{confirmed:orchestrator.cleanupConfirmed,processes:cleanup,cancellationFailures:rejectedCancellations},buildIdentity:{synchronized:identity?.synchronized?.unchanged??false,unchanged:build?.unchangedThroughoutObservedChecks??false,nodePtyCovered,nodePtyPatchCovered},independentIntervalCount:rawIntervals.length}
  return result
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const root=process.argv[2];if(!root)throw new Error('Usage: node scripts/longrun/analyze-acceptance.mjs <completed-run-root>');const result=analyze(root);fs.writeFileSync(path.join(path.resolve(root),'independent-acceptance.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({root:result.root,passed:result.passed,problems:result.problems,rates:result.rates,concurrency:result.concurrency,databaseIntegrity:result.databases.passed},null,2));process.exitCode=result.passed?0:2}
