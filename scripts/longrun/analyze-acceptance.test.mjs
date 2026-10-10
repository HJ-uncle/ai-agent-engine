import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {databaseAudit,analyze,telemetryAudit,initialProtectedAudit,archivedCommandEvidence,auditDevelopmentBaseline} from './analyze-acceptance.mjs'

test('independent development audit rejects green, incomplete, late, altered and unchanged baselines',()=>{
  const role={allowedFiles:['src/domain.mjs'],stages:[{testCommand:{command:'node',args:['tests/r4-domain-test.mjs','1']}}]}
  const baseline={at:'2026-10-09T00:00:00Z',testCommand:role.stages[0].testCommand,files:[{file:'src/domain.mjs',sha256:'a'.repeat(64)}],verification:{exitCode:1,signal:null,timedOut:false}}
  const rawText='# tests 3\n# pass 2\n# fail 1\n# skipped 0\n# cancelled 0\n# todo 0\n'
  const input={baseline,rawText,role,files:[{file:'src/domain.mjs',sha256:'b'.repeat(64)}],expected:3,modelStartedAt:'2026-10-09T00:00:01Z'}
  assert.equal(auditDevelopmentBaseline(input).passed,true)
  for(const mutation of [
    {rawText:rawText.replace('pass 2','pass 3').replace('fail 1','fail 0')},
    {rawText:'# tests 3\n# fail 1'},
    {baseline:{...baseline,at:'2026-10-09T00:00:02Z'}},
    {baseline:{...baseline,testCommand:{command:'node',args:['other.mjs']}}},
    {baseline:{...baseline,files:[]}},
    {files:baseline.files},
    {files:[]},
    {files:[{file:'src/domain.mjs',sha256:null}]},
    {files:[{file:'src/domain.mjs',sha256:'malformed'}]},
    {files:[{file:'src/domain.mjs',sha256:'b'.repeat(64)},{file:'src/peer.mjs',sha256:'c'.repeat(64)}]},
    {files:[{file:'src/domain.mjs',sha256:'b'.repeat(64)},{file:'src/domain.mjs',sha256:'b'.repeat(64)}]},
    {baseline:{...baseline,verification:{exitCode:null,signal:'SIGTERM',timedOut:true}}},
    {baseline:{...baseline,verification:{exitCode:1,signal:null,timedOut:true}}},
    {baseline:{...baseline,verification:{exitCode:0,signal:null,timedOut:false}}},
    {baseline:{...baseline,verification:{exitCode:1,signal:null,timedOut:false,error:{message:'spawn failure'}}}},
  ])assert.equal(auditDevelopmentBaseline({...input,...mutation}).passed,false)
})
const LibsqlDatabase=createRequire(import.meta.url)('libsql')

function archivedFixture(){
  const workspace=path.resolve('.e2e-tmp','archived-command-project'),session={sessionId:'s',workspace,config:{model:'fixture-model'}}
  const rootState={runId:'r',turnId:'turn',sessionId:'s',status:'succeeded',actualModelId:'fixture-model',createdAt:100,finishedAt:300}
  const command={command:'node',args:['tests/view-test.mjs','1']}
  const job={schemaVersion:1,jobId:'pruned-job',sessionId:'s',ownerSessionId:'s',runId:'r',turnId:'turn',toolCallId:'call',version:3,status:'succeeded',...command,cwd:workspace,background:false,createdAt:200,updatedAt:250,finishedAt:250,exitCode:0,signal:null,cursor:1,earliestCursor:0}
  const output='ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0'
  const invocation={name:'execute_cmd',toolCallId:'call',rootRunId:'r',turnId:'turn',args:{...command,cwd:workspace}}
  const end={...invocation,success:true,status:'succeeded',output,metadata:{commandJob:structuredClone(job),exitCode:0,outputTruncated:false,rootRunId:'r',turnId:'turn'}}
  return {snapshot:{sessionId:'s',finished:true,run:{...rootState},commandJobs:[job]},events:[{at:199,data:{toolCall:invocation}},{at:251,data:{toolEnd:end}}],rootState,session,command,after:240,expected:2,jobIndex:new Map()}
}
test('a pruned command requires raw snapshot, SSE invocation and exact successful test output owned by the DB run',()=>{
  const evidence=archivedFixture(),out=archivedCommandEvidence(evidence)
  assert.equal(out.length,1);assert.equal(out[0].jobId,'pruned-job');assert.equal(out[0].source,'archived-command-evidence');assert.equal(out[0].dbRetentionGap,true)
  evidence.events[1].data.toolResult=evidence.events[1].data.toolEnd;delete evidence.events[1].data.toolEnd
  assert.equal(archivedCommandEvidence(evidence).length,1)
})
test('archived command fallback never accepts driver claims, contradictory DB rows, stale or mismatched raw execution evidence',()=>{
  const cases=[
    ['only driver claim',x=>{x.snapshot.commandJobs=[];x.agentTestRuns=archivedFixture().snapshot.commandJobs}],
    ['missing SSE',x=>{x.events=[]}],
    ['missing invocation',x=>{x.events.shift()}],
    ['retained contradictory row',x=>{x.jobIndex.set('pruned-job',{status:'failed'})}],
    ['DB root owner mismatch',x=>{x.rootState.sessionId='other'}],
    ['DB root outcome mismatch',x=>{x.rootState.status='failed'}],
    ['snapshot root mismatch',x=>{x.snapshot.run.turnId='other'}],
    ['session owner mismatch',x=>{x.snapshot.commandJobs[0].ownerSessionId='child'}],
    ['run owner mismatch',x=>{x.snapshot.commandJobs[0].ownerRunId='other'}],
    ['SSE run mismatch',x=>{x.events[1].data.toolEnd.rootRunId='other'}],
    ['SSE invocation mismatch',x=>{x.events[0].data.toolCall.args.args=['tests/view-test.mjs','2']}],
    ['wrong cwd',x=>{x.snapshot.commandJobs[0].cwd=path.dirname(x.session.workspace)}],
    ['raw job contradiction',x=>{x.events[1].data.toolEnd.metadata.commandJob.version++}],
    ['stale after review',x=>{x.after=260}],
    ['outside DB run',x=>{x.rootState.finishedAt=230}],
    ['wrong count',x=>{x.expected=3}],
    ['skipped test',x=>{x.events[1].data.toolEnd.output=x.events[1].data.toolEnd.output.replace('skipped 0','skipped 1')}],
    ['missing count',x=>{x.events[1].data.toolEnd.output='tests reportedly passed'}],
    ['truncated output',x=>{x.events[1].data.toolEnd.metadata.outputTruncated=true}],
    ['failed execution',x=>{x.events[1].data.toolEnd.success=false}],
    ['nonzero exit',x=>{x.events[1].data.toolEnd.metadata.exitCode=1}],
  ]
  for(const [name,mutate]of cases){const evidence=archivedFixture();mutate(evidence);assert.deepEqual(archivedCommandEvidence(evidence),[],name)}
})

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-final-audit-'));fs.mkdirSync(path.join(root,'memory'))
  for(const file of ['memory/memory.db','knowledge.db']){const db=new DatabaseSync(path.join(root,file));db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT)');db.close()}
  const db=new DatabaseSync(path.join(root,'agent.db'))
  db.exec('CREATE TABLE root_runs(seq INTEGER PRIMARY KEY,run_id TEXT,session_id TEXT,turn_id TEXT,state TEXT);CREATE TABLE subagent_runs(run_id TEXT,parent_session_id TEXT,status TEXT,created_at INTEGER,snapshot TEXT);CREATE TABLE command_jobs(job_id TEXT,session_id TEXT,status TEXT,snapshot TEXT)')
  db.prepare('INSERT INTO root_runs VALUES(1,?,?,?,?)').run('r','s','turn',JSON.stringify({status:'succeeded',modelId:'qwen3.8-flash',actualModelId:'qwen3.8-flash',createdAt:1,finishedAt:2,request:{modelApiKey:'PRIVATE_MUST_NOT_BE_QUERIED'}}))
  db.prepare('INSERT INTO subagent_runs VALUES(?,?,?,?,?)').run('child','s','succeeded',1,JSON.stringify({status:'succeeded',modelId:'qwen3.8-flash',parentConversationId:'turn',parentToolCallId:'review',startedAt:1,finishedAt:2,task:'PRIVATE_TASK_NOT_SELECTED'}))
  db.prepare('INSERT INTO command_jobs VALUES(?,?,?,?)').run('job','s','succeeded',JSON.stringify({status:'succeeded',runId:'r',command:'node',args:['tests/domain-test.mjs','1'],cwd:root,exitCode:0,createdAt:1,finishedAt:2}))
  db.close();return root
}
test('three readonly databases pass integrity and only public model/status fields are projected',()=>{
  const root=fixture();const before=fs.readFileSync(path.join(root,'agent.db'));const out=databaseAudit(root)
  assert.equal(out.passed,true);assert.equal(out.databases.length,3);assert.equal(out.states.rootRuns[0].actualModelId,'qwen3.8-flash');assert.equal(out.states.commands[0].args[1],'1')
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));assert.deepEqual(fs.readFileSync(path.join(root,'agent.db')),before)
  for(const result of out.databases){assert.equal(result.backend.kind,'native-libsql');assert.equal(result.backend.queryOnly,1);assert.match(result.backend.readonlyUri,/mode=ro$/);assert.deepEqual(result.integrityCheck,['ok'])}
})

test('real libSQL vector index with null and populated embeddings passes native integrity and retains vanilla incompatibility',()=>{
  const root=fixture(),file=path.join(root,'memory','memory.db'),db=new LibsqlDatabase(file)
  db.exec("CREATE TABLE memory_nodes(id TEXT PRIMARY KEY,embedding F32_BLOB(3));CREATE INDEX idx_memory_nodes_embedding ON memory_nodes(libsql_vector_idx(embedding));INSERT INTO memory_nodes VALUES('null',NULL);INSERT INTO memory_nodes VALUES('vector',vector32('[1,2,3]'))")
  assert.equal(db.prepare('SELECT count(*) AS rows FROM memory_nodes').get().rows,2);db.close()
  const before=fs.readFileSync(file),out=databaseAudit(root),memory=out.databases.find(row=>row.name==='memory')
  assert.equal(out.passed,true);assert.deepEqual(memory.quickCheck,['ok']);assert.deepEqual(memory.integrityCheck,['ok'])
  assert.equal(memory.vanillaCompatibility.authoritative,false)
  assert.ok(memory.vanillaCompatibility.integrityCheckError?.includes('libsql_vector_idx'))
  assert.deepEqual(fs.readFileSync(file),before)
  const uri=pathToFileURL(file);uri.searchParams.set('mode','ro');const readonly=new LibsqlDatabase(uri.href)
  assert.throws(()=>readonly.exec("INSERT INTO memory_nodes VALUES('must-not-write',NULL)"),/readonly/i);readonly.close()
  assert.deepEqual(fs.readFileSync(file),before)
})

test('formal audit uses its recorded native package and refuses a missing backend without source fallback',()=>{
  const root=fixture()
  fs.writeFileSync(path.join(root,'two-end-build-identity.json'),JSON.stringify({packagedRoot:path.resolve('.')}))
  let out=databaseAudit(root);assert.equal(out.passed,true);assert.equal(out.databases[0].backend.selection,'recorded-packaged-runtime')
  fs.writeFileSync(path.join(root,'two-end-build-identity.json'),JSON.stringify({packagedRoot:path.join(root,'missing-runtime')}))
  out=databaseAudit(root);assert.equal(out.passed,false);assert.ok(out.databases.every(row=>row.error.includes('backend unavailable')))
})

test('foreign-key corruption still fails under the correct native backend',()=>{
  const root=fixture(),db=new LibsqlDatabase(path.join(root,'knowledge.db'))
  db.exec('PRAGMA foreign_keys=OFF;CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(parent INTEGER REFERENCES parents(id));INSERT INTO children VALUES(7)');db.close()
  const out=databaseAudit(root),knowledge=out.databases.find(row=>row.name==='knowledge')
  assert.equal(out.passed,false);assert.deepEqual(knowledge.quickCheck,['ok']);assert.deepEqual(knowledge.integrityCheck,['ok']);assert.equal(knowledge.foreignKeyViolations.length,1)
})
test('persisted running roots or mismatched snapshot statuses fail final state acceptance',()=>{
  const root=fixture();const db=new DatabaseSync(path.join(root,'agent.db'));db.prepare('UPDATE root_runs SET state=?').run(JSON.stringify({status:'running'}));db.exec("UPDATE subagent_runs SET status='running'");db.close()
  const out=databaseAudit(root);assert.equal(out.passed,false);assert.equal(out.databases[0].nonterminal.length,2)
})
test('a missing or corrupt secondary database is never counted as tested',()=>{
  const root=fixture();fs.unlinkSync(path.join(root,'knowledge.db'));fs.writeFileSync(path.join(root,'memory','memory.db'),'bad bytes')
  const out=databaseAudit(root);assert.equal(out.passed,false);assert.equal(out.databases[1].passed,false);assert.equal(out.databases[2].exists,false)
})
test('post-cleanup analysis refuses live/incomplete orchestrator and cannot green an absent workload',()=>{
  const root=fixture();assert.throws(()=>analyze(root),/cleanupConfirmed/)
  fs.writeFileSync(path.join(root,'orchestrator-result.json'),JSON.stringify({cleanupConfirmed:true,exitCode:2}));const out=analyze(root)
  assert.equal(out.passed,false);assert.ok(out.problems.some(problem=>problem.includes('Formal driver report absent')));assert.ok(out.problems.some(problem=>problem.includes('client acceptance absent')))
  assert.equal(out.buildIdentity.nodePtyCovered,false);assert.equal(out.buildIdentity.nodePtyPatchCovered,false)
  assert.ok(out.notes.some(note=>note.includes('older run captured dist/SQLite identity only')))
  assert.ok(out.notes.some(note=>note.includes('older run did not verify or hash a deterministic')))
})

test('newly declared node-pty and patch coverage cannot pass without actual source package and final evidence',()=>{
  const root=fixture();fs.writeFileSync(path.join(root,'orchestrator-result.json'),JSON.stringify({cleanupConfirmed:true,exitCode:2}))
  fs.writeFileSync(path.join(root,'build-artifact-evidence.json'),JSON.stringify({unchangedThroughoutObservedChecks:true,nodePtyCoverage:true,nodePtyPatchCoverage:true}))
  fs.writeFileSync(path.join(root,'two-end-build-identity.json'),JSON.stringify({synchronized:{unchanged:true}}))
  const out=analyze(root)
  assert.equal(out.buildIdentity.nodePtyCovered,false);assert.equal(out.buildIdentity.nodePtyPatchCovered,false)
  assert.ok(out.problems.some(problem=>problem.includes('lacks present source/package/final')))
  assert.ok(out.problems.some(problem=>problem.includes('lacks verified source/package/final receipts')))
})

test('interrupted run keeps session-file metadata and unfinished attempts without a final report',()=>{
  const root=fixture(),projectRoot=path.join(root,'retained-projects'),workspace=path.join(projectRoot,'board')
  fs.mkdirSync(workspace,{recursive:true})
  fs.writeFileSync(path.join(projectRoot,'manifest.json'),JSON.stringify({projects:[],protectedPaths:[]}))
  fs.writeFileSync(path.join(root,'orchestrator-result.json'),JSON.stringify({cleanupConfirmed:true,exitCode:2}))
  const session={index:1,sessionId:'s',projectId:'board',roleId:'domain',workspace,config:{model:'qwen3.8-flash'},role:{allowedFiles:['src/domain.mjs'],stages:[{index:1}]},rounds:[]}
  fs.writeFileSync(path.join(root,'active-start.json'),JSON.stringify({projectRoot,sessions:[{index:1}]}))
  fs.writeFileSync(path.join(root,'session-1.json'),JSON.stringify(session))
  const attempt=path.join(root,'sessions','session-1','stage-1-attempt-0');fs.mkdirSync(attempt,{recursive:true})
  fs.writeFileSync(path.join(attempt,'events.jsonl'),JSON.stringify({at:1,data:{run:{runId:'r',status:'running'}}})+'\n')
  const out=analyze(root)
  assert.equal(out.passed,false);assert.equal(out.rates.attempts,1);assert.equal(out.rates.failedAttempts,1)
  assert.equal(out.failedAttempts[0].roleId,'domain');assert.equal(out.failedAttempts[0].rootStatus,'succeeded');assert.equal(out.failedAttempts[0].actualModelId,'qwen3.8-flash')
  assert.equal(out.projectSharing[0].workspace,workspace);assert.equal(out.independentIntervalCount,1)
  assert.ok(out.problems.some(problem=>problem.includes('unfinished attempt retained')))
  assert.ok(out.problems.some(problem=>problem.includes('Formal driver report absent')))
  assert.ok(out.problems.some(problem=>problem.includes('report role is absent from protected manifest')))
})

function protectedFixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-protected-audit-')),directory=path.join(root,'board','tests')
  fs.mkdirSync(directory,{recursive:true})
  const file=path.join(directory,'domain-test.mjs');fs.writeFileSync(file,'test contract')
  const initial={hashes:{[file]:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}}
  return {root,directory,file,initial,manifest:{protectedPaths:['board/tests']}}
}

test('protected initial directory rejects additions and empty directories while ignoring retained R1 scratch files',()=>{
  const {root,directory,file,initial,manifest}=protectedFixture()
  const scratch=path.join(root,'default','R1-session');fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'handoff.json'),'retained R1 failure evidence')
  const source=path.join(root,'board','src');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'domain.mjs'),'R2 owned source')
  assert.equal(initialProtectedAudit(root,manifest,initial).passed,true)
  fs.writeFileSync(path.join(directory,'replacement-test.mjs'),'new unchecked contract');fs.mkdirSync(path.join(directory,'empty-added-directory'))
  const out=initialProtectedAudit(root,manifest,initial)
  assert.equal(out.passed,false);assert.ok(out.problems.some(p=>p.includes('artifact added')));assert.ok(out.problems.some(p=>p.includes('directory added')))
  assert.ok(out.problems.every(p=>!p.includes('default')&&!p.includes('src')))
  fs.writeFileSync(file,'weakened test');assert.ok(initialProtectedAudit(root,manifest,initial).problems.some(p=>p.includes('artifact changed')))
  fs.unlinkSync(file);assert.ok(initialProtectedAudit(root,manifest,initial).problems.some(p=>p.includes('artifact missing')))
})

test('protected directory replaced by a junction or symlink is rejected without following it',()=>{
  const {root,directory,initial,manifest}=protectedFixture(),target=path.join(root,'original-tests')
  fs.renameSync(directory,target);fs.symlinkSync(target,directory,process.platform==='win32'?'junction':'dir')
  const out=initialProtectedAudit(root,manifest,initial)
  assert.equal(out.passed,false);assert.ok(out.problems.some(p=>p.includes('replaced by symlink')))
})

test('altering the manifest cannot remove its own initial hash gate',()=>{
  const {root,initial,manifest}=protectedFixture(),file=path.join(root,'manifest.json')
  fs.writeFileSync(file,JSON.stringify(manifest));initial.hashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const weakened={protectedPaths:[]};fs.writeFileSync(file,JSON.stringify(weakened))
  const out=initialProtectedAudit(root,weakened,initial)
  assert.equal(out.passed,false);assert.ok(out.problems.some(p=>p==='Initial protected artifact changed: manifest.json'))
})
test('health errors after startup fail while resource/GC/event-loop peaks remain honest',()=>{
  const root=fixture(),write=(name,rows)=>fs.writeFileSync(path.join(root,name),rows.map(row=>JSON.stringify(row)).join('\n'))
  fs.writeFileSync(path.join(root,'engine.pid.json'),JSON.stringify({pid:100}))
  write('lifecycle.jsonl',[{at:'2026-10-09T00:00:00Z',phase:'startup'},{at:'2026-10-09T00:00:10Z',phase:'active'},{at:'2026-10-09T00:01:00Z',phase:'cooldown'}])
  write('health.jsonl',[{at:'2026-10-09T00:00:01Z',phase:'startup',status:null,error:'TimeoutError',latencyMs:1500},{at:'2026-10-09T00:00:12Z',phase:'active',status:200,error:null,latencyMs:20}])
  write('monitor.jsonl',[{type:'sample',at:'2026-10-09T00:00:12Z',rssBytes:200,privateBytes:150,handles:12,cpuOneCorePercent:110,cpuMachinePercent:10,processCount:3,errors:[]}])
  write('runtime.jsonl',[{type:'runtime-sample',pid:100,at:'2026-10-09T00:00:12Z',delayMs:{max:30,p95:11},gc:{count:2,durationMs:3},memory:{rssBytes:100,heapUsedBytes:50},writeErrors:0},{type:'runtime-sample',pid:200,at:'2026-10-09T00:00:12Z',delayMs:{max:9000,p95:9000},gc:{count:999,durationMs:999},memory:{rssBytes:9000,heapUsedBytes:9000},writeErrors:9}])
  let out=telemetryAudit(root);assert.equal(out.passed,true);assert.equal(out.resources.peakRssBytes,200);assert.equal(out.runtime.gcCount,2);assert.equal(out.health.active.successfulLatencyMs.p95,20)
  assert.equal(out.runtime.maxEventLoopDelayMs,30);assert.equal(out.runtime.peakMainRssBytes,100);assert.deepEqual(out.runtime.ignoredPids,[200]);assert.equal(out.runtime.ignoredRecords,1)
  fs.appendFileSync(path.join(root,'health.jsonl'),'\n'+JSON.stringify({at:'2026-10-09T00:00:14Z',phase:'active',status:200,error:'TimeoutError',latencyMs:1500}))
  out=telemetryAudit(root);assert.equal(out.passed,false);assert.equal(out.healthFailures.length,1)
  fs.appendFileSync(path.join(root,'health.jsonl'),'\n'+JSON.stringify({at:'2026-10-09T00:00:58Z',phase:'finalization',status:null,error:'TimeoutError',latencyMs:1500}))
  out=telemetryAudit(root);assert.equal(out.passed,false);assert.equal(out.healthFailures.length,2)
  fs.unlinkSync(path.join(root,'engine.pid.json'));out=telemetryAudit(root);assert.equal(out.runtime.activeSamples,0);assert.ok(out.fatal.includes('Main-thread runtime owner PID evidence is absent or invalid'))
})
