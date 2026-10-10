// Genuine cached ONNX embeddings, persisted engine memory, and production
// automatic recall composition. Runs against the isolated continuation only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const engineRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const root=path.resolve(process.argv[2]??'')
const state=JSON.parse(fs.readFileSync(path.join(root,'continuation-state.json'),'utf8'))
assert.equal(path.resolve(state.root),root);assert.notEqual(root,path.resolve(state.sourceRoot))
process.env.DATA_DIR=path.join(root,'agent.db')
process.env.EMBEDDING_BASE_URL=process.env.CONTINUATION_EMBEDDING_BASE ?? 'http://127.0.0.1:12501/v1'
process.env.EMBEDDING_MODEL='Xenova/paraphrase-multilingual-MiniLM-L12-v2'
process.env.EMBEDDING_DIMENSIONS='384'
process.env.EMBEDDING_API_KEY=''
const envFile=path.join(engineRoot,'.env')
if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){const text=line.trim(),equal=text.indexOf('=');if(!text||text.startsWith('#')||equal<1)continue;const key=text.slice(0,equal).trim();if(!(key in process.env))process.env[key]=text.slice(equal+1).trim().replace(/^["']|["']$/g,'')}
const stage=path.resolve(process.env.CONTINUATION_STAGE_ROOT ?? path.resolve(engineRoot,'../aether-code/resources/engine/win32-x64'))
const load=name=>import(pathToFileURL(path.join(stage,'dist',name)).href)
const {initMemoryDb,closeMemoryDb}=await load('storage/memory/db.js')
const {MEMORY_SCHEMA}=await load('storage/memory/schema.js')
const {SQLiteMemoryManager}=await load('storage/memory/memory-manager.js')
const {createMemoryEmbeddingService,backfillMemoryEmbeddings}=await load('storage/memory/embedding.js')
const {buildMemoryRecallBlock}=await load('middleware/memory/extractor.js')
const {closeDb}=await load('storage/sqlite/db.js')
const {decrypt}=await load('utils/encryption.js')
const report={startedAt:new Date().toISOString(),passed:false,scope:'Real production-stage vectors, durable storage, backfill, scoped cross-language recall and actual automatic recall block; long-run compaction recall is separate',checks:[],backfill:[],cleanup:[]}
const manager=new SQLiteMemoryManager(),suffix=randomUUID(),context={tenantId:'default',scope:'session',sessionId:'semantic-probe-'+suffix},other={...context,sessionId:'semantic-other-'+suffix}
const created=[]
try{
  await initMemoryDb(MEMORY_SCHEMA)
  const service=await createMemoryEmbeddingService();assert.ok(service);assert.equal(service.dimensions,384)
  const source='用户决定结算金额全部使用整数分，禁止浮点货币。'
  const query='Settlement money must be stored in integer cents instead of floating point.'
  const node=await manager.createNode({type:'decision',summary:source,importance:1,sourceSessionId:context.sessionId,sourceContextSnapshot:'semantic-probe-source-'+suffix,tags:['semantic-probe']},context);created.push({id:node.id,context})
  const distractor=await manager.createNode({type:'fact',summary:'The task board uses dark mode and blue icons.',tags:['semantic-probe']},context);created.push({id:distractor.id,context})
  const otherNode=await manager.createNode({type:'decision',summary:source,tags:['semantic-probe']},other);created.push({id:otherNode.id,context:other})
  const stored=await backfillMemoryEmbeddings(manager,context,service,{limit:20});assert.equal(stored.stored,2);assert.deepEqual(stored.errors,[])
  await backfillMemoryEmbeddings(manager,other,service,{limit:20})
  const [queryVector]=await service.embed(query)
  const recall=await manager.recallSimilar(queryVector,10,context,0.65,service.spaceId)
  assert.equal(recall[0]?.id,node.id);assert.ok(!recall.some(item=>item.id===otherNode.id||item.id===distractor.id))
  const persisted=await manager.getNode(node.id,context);assert.equal(persisted.embedding.length,384);assert.equal(persisted.embeddingSpace,service.spaceId)
  assert.equal((await manager.recallSimilar(queryVector,10,context,0.65,'wrong-space')).length,0)
  report.checks.push({name:'cross-language-semantic-without-keyword-overlap',passed:true,sourceId:node.id,returned:recall.map(item=>item.id),scopedIsolation:true,spaceIsolation:true,persistedDimensions:384})
  closeMemoryDb();await initMemoryDb(MEMORY_SCHEMA)
  assert.equal((await manager.recallSimilar(queryVector,10,context,0.65,service.spaceId))[0]?.id,node.id)
  report.checks.push({name:'durable-reopen',passed:true,id:node.id})
  const db=new DatabaseSync(path.join(root,'agent.db'),{readOnly:true});let model
  try{model=db.prepare('SELECT model_id,provider,api_key,base_url FROM models WHERE model_id=? AND tenant_id=? AND deleted_at IS NULL').get('qwen3.8-flash','default')}finally{db.close()}
  assert.ok(model)
  // Force the router to use its documented lexical fallback so this probe
  // tests the production embedding/recall path without spending a chat call.
  const block=await buildMemoryRecallBlock('default',query,{model:'semantic-probe-no-router',provider:'unsupported',baseUrl:'http://127.0.0.1:9',apiKey:'',contextWindow:100000},{scope:'session',sessionId:context.sessionId})
  fs.writeFileSync(path.join(root,'semantic-automatic-recall.txt'),block)
  assert.ok(block.includes(node.id)&&block.includes(source), 'Production automatic recall omitted real semantic decision')
  assert.ok(!block.includes(otherNode.id), 'Other session leaked into automatic recall')
  report.checks.push({name:'actual-production-automatic-recall-block',passed:true,sourceId:node.id,characters:block.length,proof:'semantic-automatic-recall.txt'})
  await manager.updateNode(node.id,{summary:'本测试已更正为只讨论蓝色图标。'},context)
  const edited=await manager.getNode(node.id,context);assert.equal(edited.embeddingJson,null);assert.equal(edited.embeddingSpace,null)
  assert.ok(!(await manager.recallSimilar(queryVector,10,context,0.65,service.spaceId)).some(item=>item.id===node.id))
  report.checks.push({name:'edited-memory-invalidates-stale-vector',passed:true,id:node.id})
  // Original R4 nodes remain untouched in the original run. Only cloned nodes
  // acquire current-space vectors; every successful batch is independently read.
  const contexts=[...state.sessions.map(session=>({tenantId:'default',scope:'session',sessionId:session.sessionId})),{tenantId:'default',scope:'global',sessionId:''}]
  for(const ctx of contexts){let count=0;for(let batch=0;batch<20;batch++){const result=await backfillMemoryEmbeddings(manager,ctx,service,{limit:20});assert.deepEqual(result.errors,[]);count+=result.stored;if(!result.attempted)break}const nodes=await manager.listNodes({limit:10000},ctx);const vectors=nodes.filter(item=>item.embeddingSpace===service.spaceId&&item.embedding?.length===384);assert.equal(vectors.length,nodes.length);report.backfill.push({scope:ctx.scope,sessionId:ctx.sessionId,nodes:nodes.length,vectors:vectors.length,newlyStored:count,passed:true})}
  report.passed=true
}catch(error){report.error={name:error.name,message:error.message};console.error(error.message)}
finally{
  for(const item of created)try{await manager.deleteNode(item.id,item.context);report.cleanup.push({id:item.id,deleted:!(await manager.getNode(item.id,item.context))})}catch(error){report.cleanup.push({id:item.id,error:error.message});report.passed=false}
  closeMemoryDb();closeDb();report.finishedAt=new Date().toISOString()
  fs.writeFileSync(path.join(root,'semantic-engine-acceptance.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,backfill:report.backfill.map(item=>({sessionId:item.sessionId,vectors:item.vectors})),file:path.join(root,'semantic-engine-acceptance.json')}))
}
process.exitCode=report.passed?0:2
