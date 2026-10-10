import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { RetainedEventTail } from './retained-event-tail.mjs'
import { apiEnvelope, currentTurnChildren, fileEvidence, nodeTestSummary, ownershipViolations, protectedEvidence, verifyProtectedEvidence, expectedContractTests, sessionConcurrency, consumeSSE } from './project-driver.mjs'

const now = () => new Date().toISOString()
const sha = value => createHash('sha256').update(value).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const terminal = status => ['succeeded','failed','cancelled','blocked','interrupted','timed_out'].includes(status)
const stamp = value => typeof value === 'number' ? value : Date.parse(value)
const err = error => ({ message: String(error?.message ?? error), code: error?.code })
const samePath = (a,b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const read = filename => JSON.parse(fs.readFileSync(filename,'utf8'))
const redact = value => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,/^(apiKey|token|authorization|password|secret|accessToken|refreshToken)$/i.test(key) ? '[redacted]' : redact(item)])) : value
const write = (filename,value) => { fs.mkdirSync(path.dirname(filename),{recursive:true}); const temporary = filename + '.tmp'; fs.writeFileSync(temporary,JSON.stringify(redact(value),null,2)+'\n'); fs.renameSync(temporary,filename) }
const append = (filename,value) => { fs.mkdirSync(path.dirname(filename),{recursive:true}); fs.appendFileSync(filename,JSON.stringify(redact(value))+'\n') }
export const MODELS = ['MiniMax-M2.5','glm-5.3','kimi-k2.6','qwen3.8-flash','deepseek-v4.1-flash']
// The first wave mirrors the requested pressure shape: three simultaneous
// Qwen sessions plus two alternate providers. Later milestones rotate across
// all five models so Kimi and DeepSeek are exercised in continued sessions.
export const INITIAL_MODELS = ['qwen3.8-flash','qwen3.8-flash','qwen3.8-flash','MiniMax-M2.5','glm-5.3']
export const modelFor = (index,milestone,attempt=0) => {
  const initial=INITIAL_MODELS[index - 1] ?? MODELS[(index - 1) % MODELS.length]
  const alternatives=MODELS.filter(model=>model!==initial),offset=(index-1)%alternatives.length
  const rotation=[initial,...alternatives.slice(offset),...alternatives.slice(0,offset)]
  return rotation[(milestone+attempt)%rotation.length]
}

export function qualifiedDevelopmentStart(previous,round) {
  if(!round.success||round.kind!=='development'||round.development?.recoveryCompletion||round.development?.freshEligible===false)return previous??null
  const value=stamp(round.rootRun?.createdAt)
  if(!Number.isFinite(value))return previous??null
  const prior=stamp(previous)
  return new Date(Number.isFinite(prior)?Math.min(prior,value):value).toISOString()
}

// Retry observation, never an ambiguous chat POST. A timeout reading a durable
// snapshot must not discard the accepted dispatch or stop an otherwise healthy
// session. The caller can reconcile a retained pending run after a restart.
export async function readEnvelope(url,options={}, {fetchImpl=fetch,delay=wait,attempts=3,timeoutMs=30000,onRetry=()=>{}}={}) {
  const method=(options.method??'GET').toUpperCase(),retryable=['GET','HEAD'].includes(method)
  for(let attempt=0;;attempt++) {
    let response
    try {
      response=await fetchImpl(url,{...options,signal:options.signal??AbortSignal.timeout(timeoutMs)})
    } catch(error) {
      if(!retryable||attempt>=attempts-1||options.signal?.aborted)throw error
      await onRetry({attempt:attempt+1,reason:'transport',error:err(error)})
      await delay(Math.min(1000*2**attempt,5000));continue
    }
    if(retryable&&[502,503,504].includes(response.status)&&attempt<attempts-1&&!options.signal?.aborted) {
      await response.body?.cancel()
      await onRetry({attempt:attempt+1,reason:'http',status:response.status})
      await delay(Math.min(1000*2**attempt,5000));continue
    }
    const body=await response.json()
    apiEnvelope(response,body,url)
    return body
  }
}

export function modelEvidenceFailure(run,requested) {
  if(!run.actualModelId)return 'actual_model_unobserved'
  return run.actualModelId!==requested?'actual_model_mismatch':null
}
export function modelConfiguration(model) {
  const capabilities=model.resolvedCapabilities??model.capabilities??{}
  return {modelId:model.modelId,contextWindow:Number(capabilities.contextWindow??model.contextWindow),...(capabilities.thinking === true ? {thinkingMode:'low'} : capabilities.thinking === false ? {thinkingMode:false} : {}),capabilities:{contextWindow:capabilities.contextWindow,thinking:capabilities.thinking,toolCalling:capabilities.toolCalling}}
}
export function compactRound(round) {
  const keys=['dispatchId','sessionId','index','roleId','requirementId','kind','attempt','modelId','startedAt','finishedAt','elapsedMs','status','success','runId','stateIntervals','failureKinds','changedOwnedFiles','development','evidenceFile','unaidedRecall','verifiedRetrieval']
  return Object.fromEntries(keys.filter(key=>round[key]!==undefined).map(key=>[key,round[key]]))
}
function compactItem(item) {return {...item,baseline:item.baseline?{exitCode:item.baseline.exitCode,testSummary:item.baseline.testSummary,startedAt:item.baseline.startedAt,finishedAt:item.baseline.finishedAt}:undefined}}

// Active attempts are not yet present in `rounds`, but their running intervals
// must still be visible to checkpoint readers and the live concurrency report.
// Keep this projection deliberately small: the full attempt state remains in
// its state file, while the report needs only durable identity and intervals.
export function compactPendingState(pending) {
  if(!pending)return null
  const keys=['dispatchId','runId','stateFile','requirementId','attempt','status','startedAt','modelId','stateIntervals']
  return Object.fromEntries(keys.filter(key=>pending[key]!==undefined).map(key=>[key,pending[key]]).concat([['item',compactItem(pending.item)]]))
}

export function resourceBody(resources = {},tools = []) {
  return { allowedTools:[...new Set([...tools,...(resources.requiredTools ?? [])])], skills:resources.skillIds ?? (resources.inlineSkills ?? []).map(item=>item.id), mcpServers:resources.mcpServerIds ?? (resources.inlineMcpServers ?? []).map(item=>item.id), knowledgeBases:resources.knowledgeBaseIds ?? resources.knowledgeBases ?? [], inlineSkills:resources.inlineSkills ?? [], inlineMcpServers:resources.inlineMcpServers ?? [], ...(resources.inlineKnowledgeBases ? {inlineKnowledgeBases:resources.inlineKnowledgeBases} : {}) }
}

export function strictReviews(previous,children,prefix,files) {
  const hash = sha(JSON.stringify(files.map(file=>[file.file,file.sha256])))
  const latestWrite = Math.max(0,...files.map(file=>file.modifiedAtMs)), found = {...(previous ?? {})}
  for (const child of children) {
    if (!child.description?.startsWith(prefix)) continue
    const role = child.description.slice(prefix.length).trim()
    if (!['A','B'].includes(role)) continue
    const summary = child.resultSummary ?? child.partialOutput ?? ''
    found[role] = {runId:child.runId,modelId:child.modelId,actualModelId:child.actualModelId,status:child.status,startedAt:stamp(child.startedAt ?? child.createdAt),finishedAt:stamp(child.finishedAt),hash,decision:reviewVerdict(summary),summary:summary.slice(0,1800),errorCode:child.error?.code}
  }
  for (const [role,review] of Object.entries(found)) if (review.hash !== hash || !Number.isFinite(review.startedAt) || !Number.isFinite(review.finishedAt) || review.startedAt + 2 < latestWrite || review.finishedAt < review.startedAt) delete found[role]
  return found
}
export const reviewsPassed = reviews => ['A','B'].every(role=>reviews[role]?.status === 'succeeded' && reviews[role]?.decision === 'pass')

export function developmentEvidence(item,before,current,recovery) {
  const changed = previous => current.filter(file=>previous.find(old=>old.file===file.file)?.sha256!==file.sha256).map(file=>file.file)
  const baseline=item.baseline
  const baselineRed=baseline?.testSummary?.complete===true&&baseline.testSummary.fail>0&&baseline.testSummary.skipped===0&&baseline.testSummary.tests===item.expectedTests&&baseline.exitCode!==0
  const freshChangedOwnedFiles=changed(before),cumulativeChangedOwnedFiles=recovery?changed(recovery.before):freshChangedOwnedFiles
  return {baselineRed,freshChangedOwnedFiles,changedOwnedFiles:cumulativeChangedOwnedFiles,freshEligible:!recovery,recoveryCompletion:!!recovery&&!freshChangedOwnedFiles.length&&cumulativeChangedOwnedFiles.length>0,...(recovery?{recoveryEvidenceFile:recovery.evidenceFile,recoveryEvidenceSha256:recovery.evidenceSha256}:{})}
}

export function reviewVerdict(summary) {
  // Reviewers often explain their checks before writing the verdict. Looking
  // only at the first few lines classified a successful review as missing;
  // inspect the full summary, but only accept explicit verdict-shaped lines
  // so a prose mention of "pass" cannot satisfy the gate.
  const lines=String(summary??'').split(/\r?\n/).map(line=>line.replace(/[*_`#]/g,'').trim()).filter(Boolean)
  const blocking=lines.some(line=>/^(?:blocking|阻塞)(?:\s|$)/iu.test(line)&&!/^阻塞原因\s*[:：]/u.test(line))||lines.some(line=>/^(?:结论|判定|结果|verdict|decision)\s*[:：]\s*(?:blocking|阻塞)(?:\s|$)/iu.test(line))
  if(blocking)return 'blocking'
  const passed=lines.some(line=>/^(?:pass|通过)(?:\s|$)/iu.test(line))||lines.some(line=>/^(?:结论|判定|结果|verdict|decision)\s*[:：]\s*(?:pass|通过)(?:\s|$)/iu.test(line))
  return passed?'pass':'blocking_or_missing'
}

export function freshParentTests(jobs,runId,workspace,command,afterMs) {
  return jobs.filter(job=>job.runId === runId && job.command === command.command && JSON.stringify(job.args) === JSON.stringify(command.args) && samePath(job.cwd,workspace) && job.status === 'succeeded' && job.exitCode === 0 && Number.isFinite(stamp(job.createdAt)) && stamp(job.createdAt) + 2 >= afterMs && Number.isFinite(stamp(job.finishedAt)) && stamp(job.finishedAt) >= stamp(job.createdAt))
}

export function evaluateRecall(probes,answer,firstToolOffset = Infinity) {
  const marker = /\[HISTORY_RECALL\]\s*(\{[^\n]*\})/g.exec(answer)
  let values
  try { values = marker ? JSON.parse(marker[1]) : null } catch { values = null }
  return { present:!!values, beforeTools:!!marker && marker.index < firstToolOffset, probes:probes.map(probe=>{ const value = values?.[probe.id]; const text = typeof value === 'string' ? value : ''; return { id:probe.id,kind:probe.kind,passed:typeof value === 'string' && (probe.expectedPatterns ?? []).every(pattern=>new RegExp(pattern,'iu').test(text)) && !(probe.forbiddenPatterns ?? []).some(pattern=>new RegExp(pattern,'iu').test(text)),answerHash:sha(text) } }), passed:!!values && !!marker && marker.index < firstToolOffset && probes.every(probe=>typeof values[probe.id] === 'string' && (probe.expectedPatterns ?? []).every(pattern=>new RegExp(pattern,'iu').test(values[probe.id])) && !(probe.forbiddenPatterns ?? []).some(pattern=>new RegExp(pattern,'iu').test(values[probe.id]))) }
}

export function evaluateRetrieval(probes,answer,events,sources,rootCreatedAt) {
  const marker=/\[HISTORY_RETRIEVAL\]\s*(\{[^\n]*\})/g.exec(answer)
  let values;try{values=marker?JSON.parse(marker[1]):null}catch{values=null}
  const calls=new Map(),retrieved=new Set(),toolEvidence=[]
  for(const event of events) {
    const call=event.toolCall,result=event.toolResult
    if(call)calls.set(call.toolCallId??call.id,call.name??call.toolName)
    if(!result||result.success!==true)continue
    const id=result.toolCallId??result.id,name=calls.get(id)??result.name??result.toolName
    if(!['search_history','recall','list_memories'].includes(name))continue
    const output=String(result.output??'');toolEvidence.push({toolCallId:id,name,outputHash:sha(output)})
    if(name==='search_history')try{for(const message of JSON.parse(output).messages??[])retrieved.add(message.messageId)}catch{}
    else for(const source of sources)if(output.includes('['+source.id+']'))retrieved.add(source.id)
  }
  const checks=probes.map(probe=>{
    const item=values?.[probe.id],text=typeof item?.answer==='string'?item.answer:'',ids=Array.isArray(item?.sourceIds)?item.sourceIds:[]
    const matching=ids.filter(id=>retrieved.has(id)&&sources.some(source=>source.id===id&&stamp(source.createdAt)<stamp(rootCreatedAt)&&(probe.expectedPatterns??[]).every(pattern=>new RegExp(pattern,'iu').test(source.text))))
    return {id:probe.id,passed:!!text&&(probe.expectedPatterns??[]).every(pattern=>new RegExp(pattern,'iu').test(text))&&!(probe.forbiddenPatterns??[]).some(pattern=>new RegExp(pattern,'iu').test(text))&&matching.length>0,answerHash:sha(text),sourceIds:matching}
  })
  return {passed:!!values&&checks.length>0&&checks.every(check=>check.passed),probes:checks,toolEvidence,criteria:'Correct private-oracle answer cites an older durable source actually returned by successful history/memory tool; current prompt cannot be its source.'}
}

export function memoryRetrievalSource(node) {
  // Memory timestamps use Unix seconds, including updates. Use the END of
  // that second so a new/current-turn edit cannot look older than its root.
  const timestamp=Math.max(Number(node.createdAt),Number(node.updatedAt??node.createdAt))
  return {id:node.id,createdAt:Number.isFinite(timestamp)?(timestamp+1)*1000:NaN,text:[node.summary,node.detail].filter(Boolean).join('\n')}
}

// Only a concrete accepted review of this exact pending payload resolves a
// permission observation. Historical requests remain in the retained evidence.
export function permissionResolutionEvidence(root, run) {
  const receipts=fs.readdirSync(root).filter(file=>/^permission-review-[a-z0-9-]+\.json\.receipt\.json$/i.test(file))
  return (run.pending??[]).filter(pending=>pending.kind==='permission').map(pending=>{
    const expected={runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId,name:pending.toolName,args:pending.args}
    for(const file of receipts) {
      const receiptFile=path.join(root,file)
      if(fs.lstatSync(receiptFile).isSymbolicLink())continue
      let receipt;try{receipt=read(receiptFile)}catch{continue}
      const body={sessionId:run.sessionId,toolResponse:{runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId,name:pending.toolName,output:'approved'}}
      const review=receipt.reviewFile,relative=typeof review==='string'?path.relative(root,path.resolve(review)):'..'
      if(![receipt.manualReview?.reviewedAt,receipt.startedAt,receipt.finishedAt,run.createdAt,run.finishedAt].every(value=>Number.isFinite(stamp(value))))continue
      if(pending.status!=='answered'||pending.output!=='approved'||receipt.decision!=='approved'||receipt.sessionId!==run.sessionId||receipt.runId!==run.runId||JSON.stringify(receipt.reviewedRequest)!==JSON.stringify(expected)||JSON.stringify(receipt.requestBody)!==JSON.stringify(body)||receipt.method!=='POST'||receipt.route!=='/api/v1/chat'||receipt.httpStatus!==200||!receipt.contentType?.includes('text/event-stream')||receipt.manualReview?.approved!==true||receipt.manualReview.requestHash!==sha(JSON.stringify(expected))||relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(review)||fs.lstatSync(review).isSymbolicLink()||sha(fs.readFileSync(review))!==receipt.reviewSha256||!Number.isFinite(stamp(receipt.manualReview.reviewedAt))||stamp(receipt.manualReview.reviewedAt)>stamp(receipt.startedAt)||stamp(receipt.startedAt)<run.createdAt||stamp(receipt.finishedAt)<stamp(receipt.startedAt)||stamp(receipt.finishedAt)>run.finishedAt)continue
      return {requestId:pending.requestId,runId:run.runId,sessionId:run.sessionId,toolCallId:pending.toolCallId,name:pending.toolName,decision:'approved',source:'manual-review',receiptFile,receiptSha256:sha(fs.readFileSync(receiptFile))}
    }
    return {requestId:pending.requestId,runId:run.runId,sessionId:run.sessionId,toolCallId:pending.toolCallId,name:pending.toolName,decision:pending.output==='rejected'?'rejected':'unresolved'}
  })
}

export async function independentTest(workspace,command,expectedTests,maxMs=120000) {
  if (command.command !== 'node' || !Array.isArray(command.args) || !command.args.length || !Number.isSafeInteger(expectedTests) || expectedTests < 1) throw new Error('Explicit Node argv and positive expectedTests required')
  const startedAt = now(), start = Date.now(), env={...process.env}; delete env.NODE_TEST_CONTEXT
  return new Promise(resolve=>{
    let stdout='',stderr='',timedOut=false,settled=false
    const child=spawn(process.execPath,command.args,{cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    const finish = result=>{if(settled)return;settled=true;clearTimeout(timer);const testSummary=nodeTestSummary(stdout,expectedTests);resolve({...result,command:{command:command.command,args:[...command.args]},cwd:path.resolve(workspace),executable:process.execPath,stdout,stderr,timedOut,testSummary,contractPassed:result.exitCode===0&&!timedOut&&testSummary.passed,startedAt,finishedAt:now(),elapsedMs:Date.now()-start})}
    child.stdout.on('data',bytes=>stdout=(stdout+bytes).slice(-2000000));child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-2000000))
    const timer=setTimeout(()=>{timedOut=true;child.kill()},maxMs)
    child.once('error',error=>finish({exitCode:null,error:err(error)}));child.once('close',(exitCode,signal)=>finish({exitCode,signal}))
  })
}

export function freezeRequirement(item,sourceDirectory,destination) {
  if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(item.id) || !item.roleId || !item.title) throw new Error('Requirement needs safe unique id, roleId and title')
  const files={}
  for (const key of item.kind==='retained-audit'?[]:['contractFile','testFile']) {
    const source=path.resolve(sourceDirectory,item[key] ?? ''),relative=path.relative(sourceDirectory,source)
    if (!item[key] || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw new Error('Requirement file must be a regular file within queue directory')
    const target=path.join(destination,key==='contractFile'?'contract.md':'check.mjs'),bytes=fs.readFileSync(source)
    fs.mkdirSync(destination,{recursive:true})
    if (fs.existsSync(target) && sha(fs.readFileSync(target))!==sha(bytes)) throw new Error('Frozen requirement changed: '+item.id)
    if(!fs.existsSync(target))fs.writeFileSync(target,bytes)
    files[key]={path:target,sha256:sha(bytes)}
  }
  const frozen={...item,...Object.fromEntries(Object.entries(files).map(([key,value])=>[key,value.path])),frozenHashes:files}
  if(item.designInputFile){
    const source=path.resolve(sourceDirectory,item.designInputFile),relative=path.relative(sourceDirectory,source)
    if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(source)||!fs.statSync(source).isFile()||fs.lstatSync(source).isSymbolicLink())throw new Error('Design input must be a regular file within queue directory')
    const target=path.join(destination,'design-input.txt'),bytes=fs.readFileSync(source)
    if(fs.existsSync(target)&&sha(fs.readFileSync(target))!==sha(bytes))throw new Error('Design input changed: '+item.id)
    if(!fs.existsSync(target))fs.writeFileSync(target,bytes)
    frozen.designInputFile=target;frozen.frozenHashes.designInputFile={path:target,sha256:sha(bytes)}
  }
  write(path.join(destination,'requirement.json'),frozen);return frozen
}
export const frozenViolations = requirement => Object.entries(requirement.frozenHashes ?? {}).filter(([,e])=>!fs.existsSync(e.path)||sha(fs.readFileSync(e.path))!==e.sha256).map(([key])=>key)

export function evidenceMatrix(rounds,requiredTools=[]) {
  const calls=new Map(),cas=[],memory=[],history=[],compactions=[]
  for(const round of rounds) {
    for(const event of round.toolEvents ?? []) {
      const call=event.toolCall,result=event.toolResult,identity=call?.id??call?.toolCallId??result?.id??result?.toolCallId
      if(call&&identity)calls.set(identity,{id:identity,name:call.name??call.toolName,roundId:round.dispatchId,sessionId:round.sessionId,result:null})
      if(result&&identity) {const row=calls.get(identity);if(row)row.result=result}
      const serialized=JSON.stringify(result??{})
      if(/EDIT_VERSION_CONFLICT|REVISION_CONFLICT|IDEMPOTENCY_CONFLICT/.test(serialized))cas.push({roundId:round.dispatchId,id:identity})
    }
    if(round.audit) {memory.push({roundId:round.dispatchId,count:round.audit.memoryCount});history.push({roundId:round.dispatchId,archiveCount:round.audit.archiveCount,recall:round.recall?.passed,complete:round.audit.archiveComplete});compactions.push(...(round.audit.compressionEvents??[]))}
  }
  const rows=requiredTools.map(name=>{const found=[...calls.values()].filter(call=>call.name===name);return {name,invocations:found.length,successfulResults:found.filter(call=>call.result&&!call.result.error&&call.result.success!==false).length,qualified:false,qualification:'Invocation/result is observational evidence; fixture assertions or independent acceptance must qualify semantic use.',evidence:found.map(call=>({id:call.id,roundId:call.roundId}))}})
  return {tools:rows,cas:{observedConflicts:cas,qualified:false,qualification:'Require independent simultaneous-state assertion before declaring conflict handling covered.'},memory,history,compactions}
}

export async function allPages(envelope,route,pageSize=100,identityKey) {
  const items=[],seen=new Set();let current=1,total
  for (;;) {
    const body=await envelope(route+(route.includes('?')?'&':'?')+'current='+current+'&pageSize='+pageSize)
    if(!Array.isArray(body.data))throw new Error('Paginated API did not return array: '+route)
    const declared=Number(body.pagination?.total ?? body.data.length)
    if(!Number.isSafeInteger(declared)||declared<0)throw new Error('Invalid pagination total')
    if(total!==undefined&&declared!==total)throw new Error('Archive changed during terminal pagination')
    total=declared
    for(const item of body.data) {const id=identityKey?item[identityKey]:item.id??item.messageId??item.nodeId;if(id===undefined)throw new Error('Paginated item missing durable identity');if(seen.has(id))throw new Error('Duplicate paginated identity');seen.add(id);items.push(item)}
    if(items.length>=total)break
    if(!body.data.length)throw new Error('Incomplete paginated archive')
    current++
  }
  if(items.length!==total)throw new Error('Pagination total mismatch')
  return {items,total,pages:current}
}

function promptFor(session,item,commands,prefix,missing,probes,seed,correction,feedback,resources) {
  const recall=probes.length ? `第一条输出必须为一行[HISTORY_RECALL] JSON对象，键为题号、值为记忆中的答案；必须在任何工具调用之前输出，不确定请如实说未知。只按既有本会话历史回答，不从当前文件猜。问题：${JSON.stringify(probes.map(({id,question})=>({id,question})))}\n然后实际用search_history检索当前会话早期原文（或list_memories获得有ID的会话记忆）；答案不得取自本轮提示或源码。根据检索结果补一行[HISTORY_RETRIEVAL] JSON对象，键同题号，值为{answer:'答案',sourceIds:['实际返回的旧messageId或记忆id']}。保留unaided首次答案，不用检索答案覆盖它。\n` : ''
  return `${recall}${seed?`本轮追加用户需求与项目决策（后续持续有效）：\n${seed}\n`:''}${correction?`本轮正式更正已有决策：\n${correction}\n`:''}${session.title}，续用原会话和原项目。模型轮换不改变已有项目约束。\n项目：${session.workspace}；角色：${session.roleId}；仅可修改 ${session.role.allowedFiles.join(', ')}。共享目录其它角色拥有的源码只能读，禁止修改原tests/contracts/spec/package.json/README/manifest以及续跑合同与测试。禁止创建其它文件。\n任务 ${item.id}：${item.title}\n${item.prompt ?? ''}\n先读冻结合同 ${item.contractFile ?? '原contracts/r4.md'}；历史约束必须独立复核，保留全部原R4功能、持久化和冲突语义。本任务真实开发，不得返回固定示例、修改测试或跳断言。${item.kind==='retained-audit'?'本轮完整复核原项目，修复后要求新的真实Agent验收。':''}\n允许必要的计划、文件检索、终端、子Agent、会话归档检索、记忆和已挂载资源。资源要求：${resources.requirementPrompt ?? '按任务真实需要使用挂载技能、MCP和知识库，并说明证据。'}\n先实现并逐条 execute_cmd 运行${JSON.stringify(commands.map(command=>({...command,cwd:session.workspace,timeoutMs:120000})))}。两个独立只读评审description精确为${JSON.stringify(missing.map(role=>prefix+role))}，access:'read-only'（不设置人为步数上限），必须同批派出。A复核合同和实际实现，B复核边界、历史兼容、持久化和并发。task须自包含当前项目路径、合同路径、具体变更与源函数位置、完整测试路径；评审只读定向检查，禁止写文件和执行命令，首行必须pass或blocking，后续最多400中文字并给文件行号；机器失败不能以文本pass代替。已有新鲜成功评审保留，仅补缺少角色。评审后父Agent再次逐条执行完全相同测试命令；若随后修改源码，则重取新鲜双评审再跑测试。\n不要安装依赖、改变引擎或审批、手动压缩历史。遇到工具冲突重读完整sha256:64hex再编辑。最终说明真实测试结果、两个评审runId机器状态与遗留问题。${feedback?`\n上次权威验收反馈：${feedback}`:''}`
}

export async function main() {
  const sourceRoot=path.resolve(process.env.CONTINUATION_SOURCE_RUN_ROOT??process.env.LONGRUN_SOURCE_RUN_ROOT??'')
  const root=path.resolve(process.env.CONTINUATION_RUN_ROOT??'')
  if(!process.env.CONTINUATION_RUN_ROOT||!process.env.CONTINUATION_SOURCE_RUN_ROOT)throw new Error('CONTINUATION_SOURCE_RUN_ROOT and CONTINUATION_RUN_ROOT required')
  if(samePath(root,sourceRoot))throw new Error('Continuation evidence must use a separate directory')
  const source=read(path.join(sourceRoot,'active-start.json')),manifest=read(source.manifestFile),resourcesFile=process.env.CONTINUATION_RESOURCES_FILE??path.join(root,'resources.json')
  const resources=fs.existsSync(resourcesFile)?read(resourcesFile):{}
  const oracleFile=process.env.CONTINUATION_HISTORY_ORACLE_FILE??resources.historyOracleFile
  const oracle=oracleFile?read(oracleFile):{sessions:[]}
  const queueFile=process.env.CONTINUATION_REQUIREMENTS_FILE??path.join(root,'requirements','queue.json')
  const tokenFile=process.env.CONTINUATION_TOKEN_FILE
  const token=tokenFile?fs.readFileSync(tokenFile,'utf8').trim():process.env.CONTINUATION_TOKEN
  if(!token)throw new Error('Isolated instance token file or token required')
  const base=process.env.CONTINUATION_BASE??'http://127.0.0.1:12499'
  const headers={'content-type':'application/json','x-aether-instance-token':token,'x-aether-tool-profile':'code'}
  // Archive reads grow with every turn and may briefly contend with the
  // streaming writer/compaction transaction. Give them an independent
  // deadline and retry budget so one slow page cannot terminate a session;
  // ordinary control-plane requests retain the shorter fail-fast timeout.
  const envelope=async(route,options={})=>{
    const archive=route.startsWith('/conversation/archive')
    return readEnvelope(base+'/api/v1'+route,{headers,...options},{
      attempts: archive ? 5 : 3,
      timeoutMs: archive ? 120_000 : 30_000,
      onRetry: observation=>append(path.join(root,'transport-recovery.jsonl'),{at:now(),route,...observation})
    })
  }
  const request=async(route,options={})=>(await envelope(route,options)).data
  fs.mkdirSync(root,{recursive:true})
  const checkpointFile=path.join(root,'checkpoint.json')
  const checkpoint=fs.existsSync(checkpointFile)?read(checkpointFile):{protocolVersion:'continuation-1',sourceRoot,root,createdAt:now(),firstDispatchAt:null,firstWave:[],durationMs:Number(process.env.CONTINUATION_DURATION_MINUTES??360)*60000,sessions:source.sessions.map(session=>({index:session.index,projectId:session.projectId,roleId:session.roleId,title:session.title,sessionId:session.sessionId,workspace:session.workspace,agentId:session.agentId,role:{allowedFiles:[session.role.allowedFiles].flat()},accepted:[],rounds:[],errors:[],pending:null,status:'ready'}))}
  if(!samePath(checkpoint.sourceRoot,sourceRoot)||!samePath(checkpoint.root,root)||checkpoint.sessions.length!==5)throw new Error('Checkpoint does not identify the original five sessions')
  if(!Number.isFinite(checkpoint.durationMs)||checkpoint.durationMs<60000)throw new Error('Duration must be positive minutes')
  const sessions=checkpoint.sessions
  for(const session of sessions)if(session.pending?.stateFile)session.pending=read(session.pending.stateFile)
  const compactSession=session=>({...session,rounds:session.rounds.map(compactRound),accepted:session.accepted.map(compactItem),pending:compactPendingState(session.pending)})
  const save=()=>{for(const session of sessions)if(session.pending?.stateFile){const {prompt,answer,toolEvents,children,commandJobs,verifications,...state}=session.pending;write(session.pending.stateFile,{...state,item:compactItem(state.item)})}write(checkpointFile,{...checkpoint,sessions:sessions.map(compactSession)});write(path.join(root,'active-report.json'),report())}
  let stopping=false,stopReason
  const protectedFile=path.join(root,'protected-baseline.json')
  const protectedSnapshot=fs.existsSync(protectedFile)?read(protectedFile):null
  const captured=protectedSnapshot?{files:new Map(Object.entries(protectedSnapshot.files)),directories:new Map(Object.entries(protectedSnapshot.directories))}:protectedEvidence(source.projectRoot,manifest,source.manifestFile)
  if(!protectedSnapshot)write(protectedFile,{files:Object.fromEntries(captured.files),directories:Object.fromEntries(captured.directories)})
  const tools=(await allPages(envelope,'/tools',100,'name')).items.map(tool=>tool.name)
  const enabled=(await request('/models')).filter(model=>model.isEnabled)
  const modelConfigs=Object.fromEntries(enabled.map(model=>[model.modelId,modelConfiguration(model)]))
  for(const model of MODELS)if(modelConfigs[model]?.contextWindow!==100000)throw new Error('Required enabled 100000-context model missing: '+model)
  write(path.join(root,'model-preflight.json'),{at:now(),models:MODELS.map(model=>modelConfigs[model])})
  const resourceConfig=resourceBody(resources,tools)
  for(const session of sessions)await request('/agents/'+encodeURIComponent(session.agentId),{method:'PUT',body:JSON.stringify({allowedTools:resourceConfig.allowedTools,skills:resourceConfig.skills,mcpServers:resourceConfig.mcpServers,knowledgeBases:resourceConfig.knowledgeBases})})
  const cancel=async(session,reason)=>{try{await request('/chat/cancel',{method:'POST',body:JSON.stringify({sessionId:session.sessionId})});append(path.join(root,'control.jsonl'),{at:now(),sessionId:session.sessionId,reason,action:'cancel'})}catch(error){session.errors.push({source:'cancel',...err(error)})}}
  const activeControllers=new Map()
  const stop=async reason=>{stopping=true;stopReason=reason;for(const [sessionId,controller] of activeControllers){controller.abort();const session=sessions.find(candidate=>candidate.sessionId===sessionId);if(session)await cancel(session,reason)}save()}
  const signal=()=>void stop('driver_signal')
  process.once('SIGINT',signal);process.once('SIGTERM',signal)
  // Retained audits, recovered old work and failed attempts have separate
  // clocks. The full development window starts at a qualified fresh root.
  const deadline=()=>checkpoint.firstQualifiedDevelopmentAt?stamp(checkpoint.firstQualifiedDevelopmentAt)+checkpoint.durationMs:Infinity
  const due=()=>Date.now()>=deadline()
  function report() {
    const rounds=sessions.flatMap(session=>session.rounds),running=sessions.some(session=>session.pending),evidenceRounds=rounds.map(round=>round.evidenceFile&&fs.existsSync(round.evidenceFile)?read(round.evidenceFile):round)
    return {...checkpoint,sessions:sessions.map(compactSession),updatedAt:now(),elapsedFromFirstRequestsMs:checkpoint.firstDispatchAt?Date.now()-stamp(checkpoint.firstDispatchAt):0,elapsedFromQualifiedDevelopmentMs:checkpoint.firstQualifiedDevelopmentAt?Date.now()-stamp(checkpoint.firstQualifiedDevelopmentAt):0,stopReason,running,rates:{attempts:rounds.length,passedAttempts:rounds.filter(round=>round.success).length,failedAttempts:rounds.filter(round=>!round.success).length,developmentMilestones:evidenceRounds.filter(round=>round.success&&round.kind==='development'&&!round.development?.recoveryCompletion&&round.development?.freshEligible!==false).length,recoveryCompletionMilestones:evidenceRounds.filter(round=>round.success&&round.kind==='development'&&round.development?.recoveryCompletion).length,recoveryMaintenanceMilestones:evidenceRounds.filter(round=>round.success&&round.kind==='development'&&round.development?.freshEligible===false).length,retainedAuditMilestones:rounds.filter(round=>round.success&&round.kind==='retained-audit').length},concurrency:sessionConcurrency(sessions),evidenceMatrix:evidenceMatrix(evidenceRounds,resources.requiredTools??tools),acceptance:{passed:false,criteria:'Final independent project acceptance, sustained qualified development, all five models auto-compression plus raw history restore and subsequent development, private recall accuracy, tool coverage qualification and cleanup are separate gates; elapsed duration alone never passes.'}}
  }
  async function audit(session,directory) {
    const archive=await allPages(envelope,'/conversation/archive?sessionId='+encodeURIComponent(session.sessionId)),meta=(await envelope('/conversation/archive?sessionId='+encodeURIComponent(session.sessionId)+'&current=1&pageSize=1')).metadata??{}
    // /memory/list is the paginated collection endpoint. /memory/nodes is the
    // mutation endpoint (and /memory/nodes/:id is the single-node lookup), so
    // using it here turns a successful run into a false 404 during audit.
    const memory=await allPages(envelope,'/memory/list?scope=session&sessionId='+encodeURIComponent(session.sessionId))
    const summary=meta.summary,compressionEvents=[]
    const engineLogFile=resources.engineLogFile??path.join(root,'engine.out.log')
    if(engineLogFile&&fs.existsSync(engineLogFile)) {
      for(const line of fs.readFileSync(engineLogFile,'utf8').split(/\r?\n/)) {
        let data;try{data=JSON.parse(line)}catch{continue}
        if(data.sessionId!==session.sessionId||(!/Micro-compact done|Compression done/.test(data.msg??'')))continue
        compressionEvents.push({kind:data.msg==='Micro-compact done'?'micro':'auto',at:data.time,sessionId:session.sessionId,runId:data.runId,preTokens:data.preRequestTokens??data.rawTokens,postTokens:data.postRequestTokens})
      }
    }
    const result={at:now(),archiveCount:archive.total,archivePages:archive.pages,archiveComplete:true,currentMessageCount:meta.currentMessageCount,compressed:meta.compressed,summary:summary?{hash:sha(summary.content??''),leafSeq:summary.leafSeq,preTokens:summary.preTokens,postTokens:summary.postTokens}:null,memoryCount:memory.total,memoryProvenance:memory.items.map(node=>({id:node.id,scope:node.scope,sessionId:node.sessionId,sourceMessageId:node.sourceMessageId})),compressionEvents}
    write(path.join(directory,'history-memory-audit.json'),result)
    return {result,messages:archive.items,nodes:memory.items}
  }
  function oracleFor(session) {return (oracle.sessions??[]).find(item=>item.sessionId===session.sessionId)??{probes:[]}}
  function commandsFor(session,item) {
    const regression={command:'node',args:['tests/r4-integration.mjs']}
    return item.kind==='retained-audit'?[{...regression,expectedTests:expectedContractTests(session.workspace,regression)}]:[{command:'node',args:[item.testFile,session.workspace],expectedTests:item.expectedTests},...session.accepted.filter(previous=>previous.kind==='development').map(previous=>({command:'node',args:[previous.testFile,session.workspace],expectedTests:previous.expectedTests})),{...regression,expectedTests:expectedContractTests(session.workspace,regression)}]
  }
  async function reconcilePending(session) {
    if(session.pending.runId)return
    const archive=await allPages(envelope,'/conversation/archive?sessionId='+encodeURIComponent(session.sessionId))
    const messages=archive.items.filter(message=>message.role==='user'&&message.metadata?.continuationDispatchId===session.pending.dispatchId)
    const runIds=[...new Set(messages.map(message=>message.metadata?.rootRunId??message.rootRunId).filter(Boolean))]
    if(runIds.length===1){session.pending.runId=runIds[0];save();return}
    const roots=(await request('/chat/runs?sessionId='+encodeURIComponent(session.sessionId))).runs??[]
    const candidates=roots.filter(run=>messages.some(message=>(message.id??message.messageId)===run.userMessageId))
    if(candidates.length===1){session.pending.runId=candidates[0].runId;save();return}
    if(session.pending.dispatchedAt)throw new Error('Ambiguous accepted dispatch; no automatic duplicate POST: '+session.pending.dispatchId)
  }
  async function attempt(session,item,number,previous) {
    const out=session.pending??{dispatchId:randomUUID(),sessionId:session.sessionId,index:session.index,roleId:session.roleId,requirementId:item.id,kind:item.kind??'development',attempt:number,modelId:modelFor(session.index,session.accepted.length-(session.modelRotationBase??0),number),startedAt:now(),stateIntervals:[],toolEvents:[],errors:[],permissionRequests:[],answer:'',firstToolOffset:null,item}
    const directory=path.join(root,'sessions','session-'+session.index,item.id,'attempt-'+out.attempt)
    out.stateFile=path.join(directory,'attempt-state.json')
    fs.mkdirSync(directory,{recursive:true});session.pending=out;save()
    const before=out.before??fileEvidence(session.workspace,session.role.allowedFiles);out.before=before
    const commands=commandsFor(session,item),prefix='continuation/review/'+item.id+'/',old=strictReviews(previous?.reviews,[],prefix,before),missing=['A','B'].filter(role=>old[role]?.status!=='succeeded'||old[role]?.decision!=='pass')
    const history=oracleFor(session),correction=(history.corrections??[])[session.accepted.length-2]
    // Seeds and corrections are real user inputs. Probe them only on a later turn,
    // so a prompt containing the answer is never counted as historical recall.
    const appliedCorrections=(history.corrections??[]).slice(0,Math.max(0,session.accepted.length-2))
    const probes=session.accepted.length===0||correction?[]:appliedCorrections.length?[...(history.probes??[]).filter(probe=>probe.id!=='current-quota'&&probe.kind!=='exact-value'),...appliedCorrections.flatMap(item=>item.probes??[])]:history.probes??[]
    const feedback=previous?JSON.stringify({failureKinds:previous.failureKinds,verification:previous.verifications?.map(test=>({command:test.command,summary:test.testSummary,tail:test.stdout.slice(-5000)})),reviews:previous.reviews,recallPassed:previous.recall?.passed}):''
    if(!out.prompt){const design=item.designInputFile&&fs.existsSync(item.designInputFile)?fs.readFileSync(item.designInputFile,'utf8'):'';out.prompt=fs.existsSync(path.join(directory,'request.json'))?read(path.join(directory,'request.json')).message:promptFor(session,{...item,prompt:[item.prompt??'',design].filter(Boolean).join('\n')},commands.map(({expectedTests,...command})=>command),prefix,missing,probes,session.accepted.length===0?history.seedMessage:'',correction?.message,feedback,resources)}
    out.answer??='';out.toolEvents??=[];out.errors??=[];out.permissionRequests??=[]
    let status='starting',stateAt=Date.now()
    const transition=value=>{if(status===value)return false;const at=Date.now();out.stateIntervals.push({status,from:stateAt,to:at});status=value;stateAt=at;out.status=value;return true}
    const receivedEventIds=new Set()
    const receive=(event,persist=true)=>{
      const data=event.data;if(persist)append(path.join(directory,'events.jsonl'),{at:now(),...event})
      if(event.id){if(receivedEventIds.has(event.id))return;receivedEventIds.add(event.id)}
      if(event.id)out.lastEventId=event.id
      if(data.run){out.rootRun=data.run;out.runId=data.run.runId;transition(data.run.status);if(persist)save()}
      if(typeof data.content==='string')out.answer+=data.content
      if(typeof data.delta==='string')out.answer+=data.delta
      if(data.toolCall||data.toolResult||data.toolStart||data.toolEnd){if(out.firstToolOffset===null)out.firstToolOffset=out.answer.length;out.toolEvents.push({at:now(),...data})}
      if(data.permissionRequest)out.permissionRequests.push(data.permissionRequest)
      if(data.error)out.errors.push({source:'sse',error:data.error})
    }
    if(out.dispatchedAt&&fs.existsSync(path.join(directory,'events.jsonl'))) {
      out.answer='';out.toolEvents=[];out.firstToolOffset=null;out.permissionRequests=[];out.errors=[]
      for(const line of fs.readFileSync(path.join(directory,'events.jsonl'),'utf8').split(/\r?\n/)){if(!line)continue;try{receive(JSON.parse(line),false)}catch{}}
      save()
    }
    const resumptionTails=new Map()
    const observeResumptions=()=>{
      for(const name of fs.readdirSync(root).filter(file=>/^permission-review-[a-z0-9-]+\.json\.receipt\.json$/i.test(file))) {
        const receiptFile=path.join(root,name);if(fs.lstatSync(receiptFile).isSymbolicLink())continue
        let receipt;try{receipt=read(receiptFile)}catch{continue}
        if(receipt.runId!==out.runId||receipt.sessionId!==session.sessionId||typeof receipt.traceFile!=='string')continue
        const file=path.resolve(receipt.traceFile),relative=path.relative(root,file)
        if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(file))continue
        if(!resumptionTails.has(file))resumptionTails.set(file,new RetainedEventTail())
        out.resumptionTraces??=[]
        if(!out.resumptionTraces.some(item=>item.traceFile===file))out.resumptionTraces.push({receiptFile,traceFile:file})
        for(const event of resumptionTails.get(file).read(file))receive(event,false)
      }
    }
    const controller=new AbortController();activeControllers.set(session.sessionId,controller)
    const maxAttemptMs=Number(process.env.CONTINUATION_ATTEMPT_MINUTES??30)*60000,attemptDeadline=Math.min(deadline(),stamp(out.startedAt)+maxAttemptMs)
    const timer=setTimeout(()=>controller.abort(),Math.max(1,attemptDeadline-Date.now()))
    try {
      if(out.dispatchedAt)await reconcilePending(session)
      if(!out.runId) {
        out.dispatchedAt=now();if(!checkpoint.firstDispatchAt)checkpoint.firstDispatchAt=out.dispatchedAt
        if(!checkpoint.firstWave.includes(session.sessionId))checkpoint.firstWave.push(session.sessionId)
        save()
        const body={sessionId:session.sessionId,agentId:session.agentId,model:out.modelId,subagentModel:out.modelId,utilityModel:out.modelId,thinkingMode:modelConfigs[out.modelId].thinkingMode,memoryScope:'session',inheritContext:true,workspacePaths:[session.workspace],...resourceConfig,message:out.prompt,metadata:{continuationDispatchId:out.dispatchId,continuationRequirementId:item.id,continuationRoleId:session.roleId}}
        write(path.join(directory,'request.json'),body)
        const response=await fetch(base+'/api/v1/chat',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal})
        if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Chat SSE HTTP '+response.status)
        await consumeSSE(response.body,receive)
      } else {
        if(transition('running'))save()
        try {const response=await fetch(base+'/api/v1/chat/stream?sessionId='+encodeURIComponent(session.sessionId)+'&lastEventId='+encodeURIComponent(out.lastEventId??''),{headers,signal:controller.signal});if(response.ok&&response.body)await consumeSSE(response.body,receive)}catch(error){out.transportRecovery=err(error)}
      }
    } catch(error){out.transportRecovery=err(error)}finally{clearTimeout(timer);activeControllers.delete(session.sessionId)}
    if(!out.runId)await reconcilePending(session)
    let snapshot,cancelledAt
    for (;;) {
      observeResumptions()
      snapshot=await request('/chat/snapshot?sessionId='+encodeURIComponent(session.sessionId))
      const roots=(await request('/chat/runs?sessionId='+encodeURIComponent(session.sessionId))).runs??[]
      out.rootRun=roots.find(run=>run.runId===out.runId)??(snapshot.run?.runId===out.runId?snapshot.run:out.rootRun)
      if(!out.rootRun)throw new Error('Dispatched root not found durably')
      if(transition(out.rootRun.status))save()
      if(terminal(out.rootRun.status))break
      if(stopping||Date.now()>=attemptDeadline){cancelledAt??=Date.now();await cancel(session,stopping?stopReason:'attempt_deadline');if(Date.now()-cancelledAt>30000)throw new Error('Cancellation did not persist a terminal root within 30 seconds');await wait(250);continue}
      await wait(1500)
    }
    observeResumptions()
    out.status=out.rootRun.status
    // The chat snapshot intentionally exposes only the currently attached
    // command cards. A completed execute_cmd can therefore be absent even
    // though the durable command-jobs collection contains its terminal row.
    // Read that authoritative session-scoped collection before applying the
    // strict fresh-parent-test gate; this avoids a false failure under long
    // concurrent runs while preserving the exact run/session ownership check.
    const commandJobPage=await request('/command-jobs?sessionId='+encodeURIComponent(session.sessionId))
    out.commandJobs=Array.isArray(commandJobPage?.jobs)?commandJobPage.jobs:(snapshot.commandJobs??[])
    out.permissionResolutions=permissionResolutionEvidence(root,out.rootRun)
    const children=await request('/subagent/runs?parentSessionId='+encodeURIComponent(session.sessionId));out.children=currentTurnChildren(children,out.rootRun,session.sessionId)
    write(path.join(directory,'snapshot.json'),{run:out.rootRun,commandJobs:out.commandJobs,historyCompacted:snapshot.historyCompacted})
    write(path.join(directory,'subagents.json'),out.children)
    out.files=fileEvidence(session.workspace,session.role.allowedFiles);out.reviews=strictReviews(old,out.children,prefix,out.files)
    out.verifications=[]
    for(const command of commands){const verification=await independentTest(session.workspace,command,command.expectedTests);out.verifications.push({command,...verification});fs.writeFileSync(path.join(directory,'verification-'+out.verifications.length+'.txt'),verification.stdout+'\n'+verification.stderr)}
    const afterMs=Math.max(0,...out.files.map(file=>file.modifiedAtMs),...['A','B'].map(role=>out.reviews[role]?.finishedAt??0))
    out.parentTestRuns=commands.map(command=>({command,jobs:freshParentTests(out.commandJobs,out.runId,session.workspace,{command:command.command,args:command.args},afterMs).map(job=>job.id??job.jobId)}))
    const historyAudit=await audit(session,directory);out.audit=historyAudit.result
    const answerMessages=historyAudit.messages.filter(message=>message.role==='assistant'&&(message.metadata?.rootRunId===out.runId||message.rootRunId===out.runId||message.turnId===out.rootRun.turnId))
    if(!out.answer&&answerMessages.length)out.answer=answerMessages.map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n')
    out.recall=probes.length?evaluateRecall(probes,out.answer,out.firstToolOffset??Infinity):{passed:null,reason:history.seedMessage?'seed_or_correction_input_turn':'oracle_not_configured'}
    out.unaidedRecall=out.recall
    out.verifiedRetrieval=probes.length?evaluateRetrieval(probes,out.answer,out.toolEvents,[...historyAudit.messages.map(message=>({id:message.id??message.messageId,createdAt:message.createdAt,text:typeof message.content==='string'?message.content:JSON.stringify(message.content)})),...historyAudit.nodes.map(memoryRetrievalSource)],out.rootRun.createdAt):{passed:null,reason:'seed_or_correction_input_turn'}
    out.ownershipViolations=ownershipViolations(session.workspace,session.role.allowedFiles,out.toolEvents,out.children)
    out.protectedViolations=[...verifyProtectedEvidence(captured),...frozenViolations(item).map(file=>({file,reason:'frozen_requirement_changed'}))]
    const recovery=session.recoveryImplementation?.[item.id]
    if(recovery&&(!fs.existsSync(recovery.evidenceFile)||sha(fs.readFileSync(recovery.evidenceFile))!==recovery.evidenceSha256))throw new Error('Original recovery implementation evidence changed')
    out.development=developmentEvidence(item,before,out.files,recovery)
    out.changedOwnedFiles=out.development.changedOwnedFiles
    out.failureKinds=[out.status!=='succeeded'&&'root_failed',modelEvidenceFailure(out.rootRun,out.modelId),out.children.some(child=>child.modelId!==out.modelId||(child.actualModelId&&child.actualModelId!==out.modelId))&&'child_model_mismatch',!reviewsPassed(out.reviews)&&'review_incomplete',out.parentTestRuns.some(test=>!test.jobs.length)&&'fresh_parent_tests_missing',out.verifications.some(test=>!test.contractPassed)&&'independent_contract_failed',out.protectedViolations.length&&'protected_mutation',out.ownershipViolations.length&&'ownership_violation',(out.permissionResolutions.some(item=>item.decision!=='approved')||out.permissionRequests.some(request=>!out.permissionResolutions.some(item=>item.requestId===request.requestId&&item.decision==='approved')))&&'permission_required',out.errors.length&&'runtime_error',probes.length&&!out.verifiedRetrieval.passed&&'historical_retrieval_failed',out.kind==='development'&&(!out.development.baselineRed||!out.changedOwnedFiles.length)&&'new_development_evidence_missing',out.children.some(child=>!terminal(child.status))&&'active_children',out.commandJobs.some(job=>!terminal(job.status))&&'active_commands'].filter(Boolean)
    out.success=!out.failureKinds.length;out.finishedAt=now();out.stateIntervals.push({status,from:stateAt,to:Date.now()});out.elapsedMs=stamp(out.finishedAt)-stamp(out.startedAt)
    fs.writeFileSync(path.join(directory,'assistant-answer.txt'),out.answer)
    delete out.prompt;delete out.answer
    out.evidenceFile=path.join(directory,'result.json')
    write(out.evidenceFile,out);session.rounds.push(compactRound(out));session.pending=null;save();return out
  }
  function nextItem(session) {
    if(!session.accepted.some(item=>item.kind==='retained-audit'))return {id:'retained-'+session.roleId,roleId:session.roleId,title:'原项目完整回归与历史约束复核',kind:'retained-audit',prompt:'完整执行原R4累计集成合同，并独立复核历史约束；保留同目录当前已完成实现，不重置。'}
    if(!fs.existsSync(queueFile))return null
    const queue=read(queueFile),items=Array.isArray(queue)?queue:queue.requirements??[]
    const ids=new Set();for(const item of items){if(ids.has(item.id))throw new Error('Duplicate requirement id');ids.add(item.id)}
    const item=items.find(item=>item.roleId===session.roleId&&!session.accepted.some(old=>old.id===item.id)&&(item.dependencies??[]).every(id=>sessions.some(peer=>peer.accepted.some(old=>old.id===id))))
    if(!item)return null
    const evidenceCopy=freezeRequirement(item,path.dirname(queueFile),path.join(root,'requirements','frozen',item.id))
    const frozen=freezeRequirement(item,path.dirname(queueFile),path.join(session.workspace,'.continuation','requirements',item.id))
    frozen.frozenHashes={...frozen.frozenHashes,evidenceContract:evidenceCopy.frozenHashes.contractFile,evidenceTest:evidenceCopy.frozenHashes.testFile,...(evidenceCopy.frozenHashes.designInputFile?{evidenceDesign:evidenceCopy.frozenHashes.designInputFile}: {})}
    // A maintenance recovery can retain partly implemented work. Its original
    // red baseline remains authoritative; never manufacture a new red test or
    // reject recovery because the implementation is already green.
    const baselineFile=path.join(root,'requirements','frozen',item.id,'baseline.json')
    if(fs.existsSync(baselineFile))frozen.baseline=read(baselineFile)
    return frozen
  }
  await Promise.all(sessions.map(async session=>{
    try {
      let starvationAt
      while(!stopping&&!due()) {
        let item=session.pending?.item??nextItem(session)
        if(!item) {
          const queue=fs.existsSync(queueFile)?read(queueFile):{requirements:[]},queued=Array.isArray(queue)?queue:queue.requirements??[]
          const waiting=queued.filter(item=>item.roleId===session.roleId&&!session.accepted.some(old=>old.id===item.id))
          if(waiting.length){starvationAt=null;session.status='dependency_wait';save();await wait(1500);continue}
          starvationAt??=Date.now();session.status='workload_starved';save()
          append(path.join(root,'workload-provider-requests.jsonl'),{at:now(),roleId:session.roleId,completed:session.accepted.map(item=>item.id),action:'append_real_requirement'})
          if(Date.now()-starvationAt>Number(process.env.CONTINUATION_STARVATION_MINUTES??5)*60000)throw new Error('Real requirement provider starved; continuous workload not satisfied')
          await wait(5000);continue
        }
        starvationAt=null;session.status='working'
        if(item.kind!=='retained-audit'&&!item.baseline) {
          item.baseline=await independentTest(session.workspace,{command:'node',args:[item.testFile,session.workspace]},item.expectedTests)
          write(path.join(root,'requirements','frozen',item.id,'baseline.json'),item.baseline)
          if(item.baseline.contractPassed)throw new Error('Requirement already green before development: '+item.id)
        }
        let previous,accepted=false
        const first=session.pending?.attempt??0
        for(let number=first;number<Number(process.env.CONTINUATION_MAX_ATTEMPTS??4)&&!stopping&&!due();number++) {
          const result=await attempt(session,item,number,previous);previous=result
          if(result.success){checkpoint.firstQualifiedDevelopmentAt=qualifiedDevelopmentStart(checkpoint.firstQualifiedDevelopmentAt,result);session.accepted.push({...item,acceptedAt:now(),modelId:result.modelId,runId:result.runId});accepted=true;save();break}
          if(result.protectedViolations.length||result.ownershipViolations.length)throw new Error('Protected or peer ownership violation')
        }
        if(!accepted&&!stopping&&!due())throw new Error('Requirement exhausted retries: '+item.id)
      }
      session.status=stopping?'interrupted':'duration_reached'
    } catch(error){
      // Isolate a failed session: cancel only its active root and let the
      // other four workers continue until the shared deadline. Global stop
      // remains reserved for an explicit signal/STOP marker.
      session.errors.push({source:'worker',...err(error)})
      session.status='failed'
      if(session.pending){
        await cancel(session,'worker_failure')
        // Preserve the accepted dispatch and its evidence even if cancelling
        // or a follow-up snapshot times out. Restart reconciliation must see it.
        session.pending.recoveryRequired=true
      }
      save()
    }
    finally{if(session.pending)await cancel(session,stopReason??'driver_deadline');save()}
  }))
  const final=report();final.finishedAt=now();final.projectAcceptance=[]
  for(const project of manifest.projects){const workspace=path.resolve(source.projectRoot,project.path),command={command:'node',args:['tests/r4-integration.mjs']};final.projectAcceptance.push({projectId:project.id,command,...await independentTest(workspace,command,expectedContractTests(workspace,command))})}
  final.cleanup=[]
  for(const session of sessions){await cancel(session,'driver_final_cleanup');const snapshot=await request('/chat/snapshot?sessionId='+encodeURIComponent(session.sessionId)),children=await request('/subagent/runs?parentSessionId='+encodeURIComponent(session.sessionId));final.cleanup.push({sessionId:session.sessionId,run:snapshot.run,jobs:(snapshot.commandJobs??[]).filter(job=>!terminal(job.status)).map(job=>job.id??job.jobId),children:children.filter(child=>!terminal(child.status)).map(child=>child.runId)})}
  final.acceptance={passed:false,requiresIndependentQualification:true,durationReached:checkpoint.firstDispatchAt&&Date.now()>=deadline(),allFiveFirstRequests:checkpoint.firstWave.length===5,projectRegressionPassed:final.projectAcceptance.every(test=>test.contractPassed),cleanupTerminal:final.cleanup.every(item=>!item.jobs.length&&!item.children.length&&terminal(item.run?.status)),protectedPassed:verifyProtectedEvidence(captured).length===0,workerErrors:sessions.flatMap(session=>session.errors),criteria:final.acceptance.criteria}
  write(path.join(root,'active-report.json'),final);process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal)
  console.log(JSON.stringify({root,acceptance:final.acceptance,rates:final.rates,concurrency:final.concurrency}));process.exitCode=final.acceptance.workerErrors.length?2:0
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main()
