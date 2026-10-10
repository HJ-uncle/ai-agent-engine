import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {consumeSSE, fileEvidence, verifiedReview, executeTests, apiEnvelope, currentTurnChildren, ownershipViolations, protectedEvidence, verifyProtectedEvidence, expectedContractTests, nodeTestSummary, sessionConcurrency, bindSessionWorkspace, stagePrompt, stageDependencies, workloadBudget, runStageAttempts, developmentEvidence} from './project-driver.mjs'

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aether-driver-contract-'))
const tap = ({tests=2,pass=tests,fail=0,skipped=0,cancelled=0,todo=0}={}) => `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`

test('SSE decoder retains split UTF-8, CRLF, multiline JSON and final unterminated frame',async()=>{
  const bytes=new TextEncoder().encode('event: run\r\ndata: {"title":"开发",\r\ndata: "status":"running"}\r\n\r\ndata: {"done":true}')
  const frames=[]
  await consumeSSE(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close()}}),frame=>frames.push(frame))
  assert.deepEqual(frames.map(f=>f.data),[{title:'开发',status:'running'},{done:true}])
  assert.equal(frames[0].event,'run')
})

test('HTTP 200 failure envelopes cannot pass business acceptance',()=>{
  const response={ok:true,status:200}
  assert.equal(apiEnvelope(response,{code:20000,data:'ok'}),'ok')
  for(const body of [{code:50000,message:'SQLite busy'},{code:400,message:'Empty JSON body'},{code:404,message:'Not found'},{code:201,data:'undocumented success'},{code:20000,success:false},{data:'missing code'},{code:20000,error:{message:'failed'}}])assert.throws(()=>apiEnvelope(response,body,'/chat/cancel'))
  assert.throws(()=>apiEnvelope({ok:false,status:403},{code:20000,data:'pretend'}))
})

test('ownership audit decodes JSON-string arguments and checks actual child tool writes',()=>{
  const workspace=temporary()
  fs.mkdirSync(path.join(workspace,'src'))
  fs.writeFileSync(path.join(workspace,'src','owned.mjs'),'export const x=1')
  const events=[{toolCall:{id:'own',name:'write_file',args:'{"path":"src/owned.mjs"}'}},{toolCall:{id:'peer',name:'edit_file',args:'{"file_path":"src/peer.mjs"}'}},{toolCall:{id:'bad',name:'write_file',args:'{"path":'}},{toolStart:{id:'streaming',name:'write_file'}}]
  const children=[{toolCalls:[{id:'child',name:'write_file',args:{path:'../outside.mjs'}}]}]
  const violations=ownershipViolations(workspace,['src/owned.mjs'],events,children)
  assert.deepEqual(violations.map(v=>v.toolCallId),['peer','bad','child'])
  assert.equal(violations[1].reason,'unverifiable_write_arguments')
})

test('current-turn review selection rejects historical and foreign-parent evidence',()=>{
  const children=[{runId:'old',parentConversationId:'old',parentSessionId:'s'},{runId:'new',parentConversationId:'turn',parentSessionId:'s'},{runId:'foreign',parentConversationId:'turn',parentSessionId:'other'}]
  assert.deepEqual(currentTurnChildren(children,{turnId:'turn'},'s').map(c=>c.runId),['new'])
  assert.deepEqual(currentTurnChildren(children,{},'s'),[])
})

test('review freshness binds SHA, epoch timestamps and post-write start',()=>{
  const files=[{file:'src/domain.mjs',sha256:'original',modifiedAtMs:1000}]
  const child={runId:'review-a',description:'review/role/1/A',modelId:'model',status:'succeeded',startedAt:'1970-01-01T00:00:01.100Z',finishedAt:1200,resultSummary:'Reviewed'}
  const accepted=verifiedReview({},[child],'review/role/1/',files)
  assert.equal(accepted.A.runId,'review-a')
  assert.equal(accepted.A.modelEvidence,'requested_only')
  assert.deepEqual(verifiedReview(accepted,[],'review/role/1/',[{...files[0],sha256:'changed'}]),{})
  assert.deepEqual(verifiedReview({},[{...child,startedAt:900}],'review/role/1/',files),{})
  assert.deepEqual(verifiedReview({},[{...child,startedAt:1200,finishedAt:1100}],'review/role/1/',files),{})
  assert.deepEqual(verifiedReview({},[{...child,startedAt:'invalid'}],'review/role/1/',files),{})
})

test('protected manifest entries detect additions deletion and content mutations',()=>{
  const root=temporary(),workspace=path.join(root,'ops')
  fs.mkdirSync(path.join(workspace,'tests'),{recursive:true})
  fs.mkdirSync(path.join(workspace,'contracts'))
  fs.writeFileSync(path.join(workspace,'tests','domain-test.mjs'),'protected')
  fs.writeFileSync(path.join(root,'README.md'),'root docs')
  fs.writeFileSync(path.join(root,'manifest.json'),'{}')
  const evidence=protectedEvidence(root,{projects:[{path:workspace}],protectedPaths:['README.md']})
  assert.deepEqual(verifyProtectedEvidence(evidence),[])
  fs.writeFileSync(path.join(workspace,'tests','new-test.mjs'),'added')
  assert.ok(verifyProtectedEvidence(evidence).some(v=>v.reason==='protected_directory_entries_changed'))
  fs.writeFileSync(path.join(root,'README.md'),'mutated')
  assert.ok(verifyProtectedEvidence(evidence).some(v=>v.file.endsWith('README.md')))
  fs.unlinkSync(path.join(workspace,'tests','domain-test.mjs'))
  assert.ok(verifyProtectedEvidence(evidence).some(v=>v.actual===null))
})

test('protected paths and implementation paths cannot escape workspace',()=>{
  const root=temporary();fs.writeFileSync(path.join(root,'manifest.json'),'{}')
  assert.throws(()=>protectedEvidence(root,{projects:[],protectedPaths:['../escape']}),/escapes/)
  assert.throws(()=>fileEvidence(root,['../escape']),/escapes/)
})

test('Node summary requires complete counts and rejects skip fail cancellation todo and zero tests',()=>{
  assert.equal(nodeTestSummary(tap(),2).passed,true)
  for(const row of [{tests:0,pass:0},{pass:1,fail:1},{pass:1,skipped:1},{pass:1,cancelled:1},{pass:1,todo:1}])assert.equal(nodeTestSummary(tap(row),2).passed,false)
  assert.equal(nodeTestSummary('# tests 2\n# pass 2\n',2).passed,false)
  assert.equal(nodeTestSummary(tap(),3).passed,false)
  assert.equal(nodeTestSummary('no tests here',null).passed,false)
})

test('Node spec reporter ANSI counts and multiple integration subprocess summaries are understood',()=>{
  const spec=tap().replace(/^# /gm,'\u001b[34mℹ ').replace(/\n/g,'\u001b[39m\n')
  assert.equal(nodeTestSummary(spec,2).passed,true)
  const summary=nodeTestSummary(tap({tests:3})+tap({tests:4}),7)
  assert.equal(summary.passed,true);assert.equal(summary.blocks,2);assert.equal(summary.tests,7)
})

test('static protected stage counts are cumulative and direct Node preflight tests are counted',()=>{
  const root=temporary();fs.mkdirSync(path.join(root,'tests'))
  fs.writeFileSync(path.join(root,'tests','domain-test.mjs'),'check(1,"first",f);check(1,"second",f);check(2,"third",f);')
  assert.equal(expectedContractTests(root,{args:['tests/domain-test.mjs','1']}),2)
  assert.equal(expectedContractTests(root,{args:['tests/domain-test.mjs','2']}),3)
  fs.writeFileSync(path.join(root,'contract.test.mjs'),'test("one",f);test("two",f);')
  assert.equal(expectedContractTests(root,{args:['--test','contract.test.mjs']}),2)
})

test('new profile counts inherit protected contracts while old integration ignores added profiles',()=>{
  const root=temporary();fs.mkdirSync(path.join(root,'tests'))
  fs.writeFileSync(path.join(root,'tests','domain-test.mjs'),'check(1,"base",f);check(10,"last",f);')
  fs.writeFileSync(path.join(root,'tests','r4-domain-test.mjs'),'// baseline-contract: tests/domain-test.mjs 10\ncheck(1,"new",f);check(10,"last",f);')
  fs.writeFileSync(path.join(root,'tests','integration-test.mjs'),"const tests=['domain-test.mjs'];")
  assert.equal(expectedContractTests(root,{args:['tests/r4-domain-test.mjs','1']}),3)
  assert.equal(expectedContractTests(root,{args:['tests/r4-domain-test.mjs','10']}),4)
  assert.equal(expectedContractTests(root,{args:['tests/integration-test.mjs']}),2)
  fs.writeFileSync(path.join(root,'tests','r4-domain-test.mjs'),'// baseline-contract: tests/r4-domain-test.mjs 10\ncheck(1,"new",f);')
  assert.throws(()=>expectedContractTests(root,{args:['tests/r4-domain-test.mjs','1']}),/Cyclic/)
  fs.writeFileSync(path.join(root,'tests','r4-domain-test.mjs'),'// baseline-contract: ../outside.mjs 10\ncheck(1,"new",f);')
  assert.throws(()=>expectedContractTests(root,{args:['tests/r4-domain-test.mjs','1']}),/Missing/)
})

test('development accepts a retained retry only against a complete original red contract',()=>{
  const baseline={files:[{file:'src/domain.mjs',sha256:'original'}],verification:{exitCode:1,signal:null,timedOut:false,testSummary:nodeTestSummary(tap({tests:3,pass:2,fail:1}),3)}}
  assert.equal(developmentEvidence(baseline,[{file:'src/domain.mjs',sha256:'implemented'}]).passed,true)
  assert.equal(developmentEvidence(baseline,[{file:'src/domain.mjs',sha256:'original'}]).passed,false)
  for(const summary of [nodeTestSummary(tap({tests:3}),3),nodeTestSummary(tap({tests:1,pass:0,fail:1}),3),nodeTestSummary(tap({tests:3,pass:1,fail:1,skipped:1}),3),nodeTestSummary('syntax error',3)]){
    assert.equal(developmentEvidence({...baseline,verification:{testSummary:summary}},[{file:'src/domain.mjs',sha256:'implemented'}]).passed,false)
  }
  for(const process of [{exitCode:0},{exitCode:null},{timedOut:true},{signal:'SIGTERM'},{error:{message:'spawn failure'}}])assert.equal(developmentEvidence({...baseline,verification:{...baseline.verification,...process}},[{file:'src/domain.mjs',sha256:'implemented'}]).baselineRed,false)
})

test('real Node passing tests carry exact counts and contractPassed',async()=>{
  const root=temporary()
  fs.writeFileSync(path.join(root,'contract.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';test('real',()=>assert.equal(1+1,2));")
  const result=await executeTests(root,{command:'node',args:['--test','contract.test.mjs']})
  assert.equal(result.exitCode,0);assert.equal(result.expectedTests,1);assert.equal(result.testSummary.tests,1);assert.equal(result.contractPassed,true)
})

test('real Node skipped tests and exit-zero non-test scripts fail contract acceptance',async()=>{
  const root=temporary()
  fs.writeFileSync(path.join(root,'skip.test.mjs'),"import {test} from 'node:test';test('skip',{skip:true},()=>{});")
  const skipped=await executeTests(root,{command:'node',args:['--test','skip.test.mjs']})
  assert.equal(skipped.exitCode,0);assert.equal(skipped.contractPassed,false);assert.equal(skipped.testSummary.skipped,1)
  fs.writeFileSync(path.join(root,'empty.mjs'),"console.log('nothing was tested')")
  const empty=await executeTests(root,{command:'node',args:['empty.mjs']})
  assert.equal(empty.exitCode,0);assert.equal(empty.contractPassed,false)
})

test('all real retained-project stage commands have nonzero cumulative independent case counts',()=>{
  const projectRoot=path.resolve('test-projects/longrun-20261009')
  const manifest=JSON.parse(fs.readFileSync(path.join(projectRoot,'manifest.json'),'utf8'))
  const evidence=protectedEvidence(projectRoot,manifest)
  assert.ok(evidence.files.size>10)
  assert.deepEqual(verifyProtectedEvidence(evidence),[])
  for(const project of manifest.projects){let finalSum=0;for(const role of project.roles){let previous=0;for(const stage of role.stages){const count=expectedContractTests(project.path,stage.testCommand);assert.ok(count>previous,`${role.id} stage ${stage.index} adds cases`);previous=count;}finalSum+=previous;}assert.equal(expectedContractTests(project.path,project.integrationTestCommand),finalSum);}
})

test('concurrency counts actual running overlap, not sequential sessions or boundary instants',()=>{
  const make=(id,from,to)=>({sessionId:id,rounds:[{stateIntervals:[{status:'running',from,to}]}]})
  const shared=sessionConcurrency([make('a',0,100),make('b',20,100),make('c',30,100),make('d',40,100),make('e',50,100)])
  assert.equal(shared.maxConcurrentSessions,5);assert.equal(shared.allFiveOverlapMs,50)
  const sequential=sessionConcurrency([make('a',0,10),make('b',10,20),make('c',20,30),make('d',30,40),make('e',40,50)])
  assert.equal(sequential.maxConcurrentSessions,1);assert.equal(sequential.allFiveOverlapMs,0)
})

test('R3 prompt keeps strict ownership, static concise review, parallel A/B and 24 steps',()=>{
  const session={title:'Formal',roleId:'ops-domain',workspace:'D:/project',role:{title:'domain',allowedFiles:['src/domain.mjs']}}
  const stage={index:3,title:'Search',prompt:'Implement search',testCommand:{command:'node',args:['tests/domain-test.mjs','3']}}
  const prompt=stagePrompt(session,stage,['A','B'],'review/ops-domain/3/')
  assert.ok(prompt.includes("access:'read-only',maxSteps:24"));assert.ok(prompt.includes('同一个工具调用批次'));assert.ok(prompt.includes('禁止创建任何额外handoff'));assert.ok(prompt.includes('不要抢先实现后续阶段'));assert.ok(!prompt.includes('readonly:true'))
  assert.ok(prompt.includes('禁止依次等待A再派B'));assert.ok(prompt.includes('没有execute_cmd工具'));assert.ok(prompt.includes('不超过400中文字'));assert.ok(prompt.includes('不读.test-data历史运行产物'));assert.ok(prompt.includes('上限而非必须用满'))
  const reused=stagePrompt(session,stage,[],'review/ops-domain/3/');assert.ok(reused.includes('不要重做评审'));assert.ok(!reused.includes('description须精确'))
})

test('A-only and B-only review prompts request exactly the missing role without inviting extra review',()=>{
  const session={title:'Formal',roleId:'api',workspace:'D:/project',role:{allowedFiles:['src/repository.mjs']}},stage={index:1,title:'Repository',prompt:'Implement repository',testCommand:{command:'node',args:['tests/api-test.mjs','1']}}
  const a=stagePrompt(session,stage,['A'],'review/api/1/')
  assert.ok(a.includes('本轮只补指定评审角色 A'));assert.ok(a.includes('不额外派其它评审'));assert.ok(a.includes('A核对当前阶段合同和实现'))
  assert.ok(!a.includes('B核对'));assert.ok(!a.includes('review/api/1/B'));assert.ok(!a.includes('两个独立评审'))
  const b=stagePrompt(session,stage,['B'],'review/api/1/')
  assert.ok(b.includes('本轮只补指定评审角色 B'));assert.ok(b.includes('不重评已有新鲜成功证据'));assert.ok(b.includes('B核对当前阶段边界'))
  assert.ok(!b.includes('A核对'));assert.ok(!b.includes('review/api/1/A'));assert.ok(!b.includes('两个独立评审'))
})

test('unrelated project failure does not cancel a waiting real prerequisite',()=>{
  const session={projectId:'ops-board',roleId:'ops-view'},stage={dependencies:[{role:'ops-domain',stage:3}]}
  const domain={projectId:'ops-board',roleId:'ops-domain',completedStage:2,errors:[],role:{stages:[{index:3}]}},foreign={projectId:'ledger-api',roleId:'ledger-api',completedStage:0,errors:[{message:'Stage 1 failed'}],status:'failed'}
  assert.deepEqual(stageDependencies(session,stage,[domain,foreign]),{ready:false,waiting:['ops-domain/S3'],blockers:[]})
  domain.completedStage=3
  assert.deepEqual(stageDependencies(session,stage,[domain,foreign]),{ready:true,waiting:[],blockers:[]})
})

test('required failed or impossible dependency blocks precisely while accepted stages remain valid',()=>{
  const session={projectId:'ops-board'},stage={dependencies:[{role:'ops-domain',stage:3}]}
  const peer={projectId:'ops-board',roleId:'ops-domain',completedStage:2,errors:[{message:'failed S3'}],status:'failed',role:{stages:[{index:3}]}}
  assert.match(stageDependencies(session,stage,[peer]).blockers[0],/ops-domain\/S3: dependency ended/)
  peer.completedStage=3;assert.equal(stageDependencies(session,stage,[peer]).ready,true)
  assert.match(stageDependencies(session,stage,[]).blockers[0],/required role missing/)
  assert.match(stageDependencies(session,stage,[{...peer,projectId:'ledger-api'}]).blockers[0],/required role missing/)
  assert.match(stageDependencies(session,stage,[{...peer,completedStage:2,errors:[],status:undefined,role:{stages:[{index:1}]}}]).blockers[0],/required stage does not exist/)
  assert.equal(stageDependencies(session,{dependencies:[]},[peer]).ready,true)
})

test('R3 budgets are recorded as 20-minute attempts and 120-minute workload with three attempts',()=>{
  assert.deepEqual(workloadBudget({}),{maxMs:7200000,stageTimeoutMs:1200000,maxAttempts:3})
  assert.deepEqual(workloadBudget({LONGRUN_MAX_MS:'3600000',LONGRUN_STAGE_TIMEOUT_MS:'480000'}),{maxMs:3600000,stageTimeoutMs:480000,maxAttempts:3})
  for(const value of ['0','-1','NaN','Infinity'])assert.throws(()=>workloadBudget({LONGRUN_MAX_MS:value}),/positive duration/)
})

test('retry runner waits for prior cancellation evidence and never calls an attempt after the workload deadline',async()=>{
  const session={rounds:[],completedStage:0},stage={index:1},published=[]
  let clock=0,calls=0,settled=false
  const attempt=async()=>{calls++;await new Promise(resolve=>setImmediate(resolve));settled=true;clock=100;return {success:false,protectedViolations:[],ownershipViolations:[],cancellationSettled:settled}}
  await assert.rejects(()=>runStageAttempts({session,stage,attempt,publish:async s=>published.push(s.rounds.at(-1)),deadlineMs:100,currentTime:()=>clock}),/No further attempt after workload deadline/)
  assert.equal(calls,1);assert.equal(settled,true);assert.equal(session.rounds.length,1);assert.equal(published[0].cancellationSettled,true)
})

test('retry runner dispatches no new model attempt when already expired or explicitly stopped',async()=>{
  for(const state of [{clock:100,stopping:false},{clock:0,stopping:true}]){
    let calls=0
    await assert.rejects(()=>runStageAttempts({session:{rounds:[]},stage:{index:1},attempt:async()=>{calls++},publish:()=>{},deadlineMs:100,currentTime:()=>state.clock,shouldStop:()=>state.stopping}),/No further attempt/)
    assert.equal(calls,0)
  }
})

test('retry runner still permits three bounded attempts and stops on success or ownership violation',async()=>{
  let calls=0
  const failed={success:false,protectedViolations:[],ownershipViolations:[]}
  await assert.rejects(()=>runStageAttempts({session:{rounds:[]},stage:{index:1},attempt:async()=>{calls++;return failed},publish:()=>{},deadlineMs:100,currentTime:()=>0}),/Stage 1 did not recover after 3 attempts/)
  assert.equal(calls,3)
  const session={rounds:[],completedStage:0};calls=0
  const success=await runStageAttempts({session,stage:{index:1},attempt:async(n,previous)=>{calls++;if(n===1){assert.equal(previous,failed);return {...failed,success:true}}return failed},publish:()=>{},deadlineMs:100,currentTime:()=>0})
  assert.equal(calls,2);assert.equal(success.success,true);assert.equal(session.completedStage,1)
  calls=0
  await assert.rejects(()=>runStageAttempts({session:{rounds:[]},stage:{index:1},attempt:async()=>{calls++;return {...failed,ownershipViolations:[{file:'peer.mjs'}]}},publish:()=>{},deadlineMs:100,currentTime:()=>0}),/ownership violated/)
  assert.equal(calls,1)
})

test('workspace binding checks canonical project path and actual client directory root',async()=>{
  const workspace=temporary(),session={sessionId:'formal-session',workspace}
  const calls=[]
  const request=async(route,options)=>{calls.push({route,options});if(route==='/workspace/bind')return {workspaceRoot:fs.realpathSync(workspace)};return {root:workspace,entries:['src','tests','contracts'].map(name=>({name}))}}
  const out=await bindSessionWorkspace(request,session);assert.equal(out.passed,true);assert.deepEqual(JSON.parse(calls[0].options.body),{sessionId:session.sessionId,workspaceRoot:workspace});assert.ok(calls[1].route.includes('sessionId=formal-session'))
  await assert.rejects(()=>bindSessionWorkspace(async()=>({workspaceRoot:temporary()}),session),/canonical/)
  await assert.rejects(()=>bindSessionWorkspace(async route=>route==='/workspace/bind'?{workspaceRoot:workspace}:{root:temporary(),entries:[]},session),/directory API/)
})

test('actual built workspace HTTP routes bind two sessions to one canonical retained project',async()=>{
  const root=temporary(),project=path.join(root,'shared');fs.mkdirSync(project);for(const name of ['src','tests','contracts'])fs.mkdirSync(path.join(project,name))
  const previous={WORKSPACE_ROOT:process.env.WORKSPACE_ROOT,AUTH_ENABLED:process.env.AUTH_ENABLED};process.env.WORKSPACE_ROOT=root;process.env.AUTH_ENABLED='false'
  let app
  try{
    const {default:fastify}=await import('fastify');const {workspaceRoutes}=await import('../../dist/api/http/routes/workspace.js');app=fastify();await app.register(workspaceRoutes,{prefix:'/api/v1'});const base=await app.listen({port:0,host:'127.0.0.1'})
    const request=async(route,options={})=>{const response=await fetch(base+'/api/v1'+route,{headers:{'content-type':'application/json'},...options});return apiEnvelope(response,await response.json(),route)}
    const a=await bindSessionWorkspace(request,{workspace:project,sessionId:'formal-a'}),b=await bindSessionWorkspace(request,{workspace:project,sessionId:'formal-b'});assert.equal(a.canonicalWorkspace,b.canonicalWorkspace);assert.deepEqual(a.directoryEntryNames,['contracts','src','tests'])
  }finally{await app?.close();for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value}
})
