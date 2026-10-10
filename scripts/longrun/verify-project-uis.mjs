// Real Chromium + retained project HTTP acceptance. Only kills processes spawned here.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {executeTests} from './project-driver.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const errorInfo=error=>({name:error.name,message:error.message})
export async function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port))})})}
export function browserExecutable(chromium){const candidates=[process.env.LONGRUN_BROWSER_EXECUTABLE,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'];const existing=candidates.find(candidate=>candidate&&fs.existsSync(candidate));if(!existing)throw new Error('No installed Chromium/Chrome/Edge executable; this verifier never downloads browsers');return existing}
async function eventually(check,label,maxMs=20000){const until=Date.now()+maxMs;let last;while(Date.now()<until){try{const value=await check();if(value)return value}catch(error){last=error}await sleep(100)}throw new Error(`Timed out: ${label}${last?': '+last.message:''}`)}
async function http(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const text=await response.text();let json;try{json=JSON.parse(text)}catch{}return {status:response.status,text,json}}

export async function verify(root,{currentProjects=false}={}){
  root=path.resolve(root);const report=JSON.parse(fs.readFileSync(path.join(root,'active-report.json'),'utf8'))
  if(!currentProjects&&!report.acceptance?.passed)throw new Error('Run all 50 staged cumulative contracts before actual project UI acceptance')
  const manifest=JSON.parse(fs.readFileSync(report.manifestFile??path.join(report.projectRoot,'manifest.json'),'utf8'))
  const evidenceRoot=path.join(root,currentProjects?'current-project-uis':'project-uis');fs.mkdirSync(evidenceRoot,{recursive:true})
  const out={startedAt:new Date().toISOString(),root,scope:currentProjects?'Current retained source after external repair; does not certify the original Agent run':'Original staged Agent run',mode:'real installed Chromium via existing Playwright; no installation',passed:false,projectContracts:[],projects:[],errors:[],spawnedServers:[],cleanup:[],screenshots:[]}
  const childObjects=[];let browser,page
  const record=(project,event,data={})=>{const row={at:new Date().toISOString(),project,event,...data};fs.appendFileSync(path.join(evidenceRoot,'actions.jsonl'),JSON.stringify(row)+'\n')}
  const start=async project=>{
    const port=await freePort(),base=`http://127.0.0.1:${port}`,child=spawn(process.execPath,['src/server.mjs',String(port)],{cwd:project.path,windowsHide:true,stdio:['ignore','pipe','pipe']})
    const owned={projectId:project.id,pid:child.pid,port,base,startedAt:new Date().toISOString(),closed:false};out.spawnedServers.push(owned)
    const promise=new Promise(resolve=>{child.once('error',error=>{owned.error=errorInfo(error);owned.closed=true;resolve()});child.once('close',(exitCode,signal)=>{owned.exitCode=exitCode;owned.signal=signal;owned.closed=true;resolve()})})
    child.stdout.pipe(fs.createWriteStream(path.join(evidenceRoot,`${project.id}-${port}.out.log`)))
    child.stderr.pipe(fs.createWriteStream(path.join(evidenceRoot,`${project.id}-${port}.err.log`)))
    const serverProcess={child,owned,promise};childObjects.push(serverProcess)
    await eventually(async()=>{if(owned.closed)throw new Error('Project server exited '+JSON.stringify(owned));const r=await http(base,'/health');return r.status===200&&r.json?.ok===true&&r.json?.scaffold!==true},`${project.id} actual implemented server health`)
    record(project.id,'server-started',{pid:child.pid,port});return serverProcess
  }
  const stop=async serverProcess=>{
    if(!serverProcess.owned.closed)serverProcess.child.kill()
    await Promise.race([serverProcess.promise,sleep(10000)])
    assert.equal(serverProcess.owned.closed,true,'Own spawned project server must exit')
    const released=await new Promise(resolve=>{const check=net.createServer();check.once('error',()=>resolve(false));check.listen(serverProcess.owned.port,'127.0.0.1',()=>check.close(()=>resolve(true)))})
    out.cleanup.push({pid:serverProcess.owned.pid,port:serverProcess.owned.port,exited:serverProcess.owned.closed,portReleased:released,identity:'owned ChildProcess handle; no PID-based taskkill'})
    assert.equal(released,true,'Own project port must be released')
  }
  const screenshot=async name=>{const file=path.join(evidenceRoot,name+'.png');await page.screenshot({path:file,fullPage:true});out.screenshots.push(file);return file}
  try{
    if(currentProjects){
      for(const project of manifest.projects){
        const checked=await executeTests(project.path,project.integrationTestCommand,120000)
        out.projectContracts.push({projectId:project.id,...checked})
        assert.equal(checked.contractPassed,true,project.id+' current full-project contract counts must pass without skips')
      }
    }
    const require=createRequire(path.resolve(process.env.LONGRUN_CLIENT_ROOT||'D:/dev/aether-code','package.json'))
    const {chromium}=require('@playwright/test'),executablePath=browserExecutable(chromium)
    browser=await chromium.launch({executablePath,headless:true});out.browser={executablePath,version:browser.version()}
    const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});page=await context.newPage();page.setDefaultTimeout(20000)
    const browserErrors=[]
    page.on('pageerror',error=>browserErrors.push(errorInfo(error)))
    page.on('dialog',async dialog=>{browserErrors.push({name:'UnexpectedDialog',message:`${dialog.type()}: ${dialog.message()}`});await dialog.dismiss()})
    const ops=manifest.projects.find(project=>project.id==='ops-board');assert.ok(ops)
    let serverProcess=await start(ops),base=serverProcess.owned.base
    const unique=randomUUID().slice(0,8),persistentTitle=`Browser retained ${unique}`,initialTitle=`Browser draft ${unique}`,editedTitle=`Browser edited ${unique}`
    const board=async()=>{const r=await http(base,'/api/board');assert.equal(r.status,200);assert.ok(r.json?.data?.tasks);return r.json.data}
    await page.goto(base,{waitUntil:'networkidle'});await page.locator('[data-action="create"]').first().waitFor();await screenshot('ops-initial')
    const create=async title=>{await page.locator('[data-action="create"]').first().click();const form=page.locator('[data-form="task"]');await form.waitFor();await form.locator('[name="title"]').fill(title);if(await form.locator('[name="description"]').count())await form.locator('[name="description"]').fill('Created through real Chromium, retained for future iteration');await form.locator('button[type="submit"]').click();await eventually(async()=>{const b=await board();return b.tasks.find(task=>task.title===title)},'browser create persisted');await page.locator('article.task-card').filter({hasText:title}).first().waitFor()}
    await create(persistentTitle);await create(initialTitle);record('ops-board','create',{titles:[persistentTitle,initialTitle]})
    const draft=(await board()).tasks.find(task=>task.title===initialTitle),card=()=>page.locator(`article[data-task-id=${JSON.stringify(draft.id)}]`)
    await card().locator('[data-action="edit"]').click();let form=page.locator('[data-form="task"]');await form.waitFor();await form.locator('[name="title"]').fill(editedTitle);await form.locator('button[type="submit"]').click();await eventually(async()=>(await board()).tasks.find(task=>task.id===draft.id)?.title===editedTitle,'browser edit');record('ops-board','edit',{taskId:draft.id,title:editedTitle})
    const search=page.locator('[name="query"]');await search.fill('no-such-task-'+unique);await eventually(async()=>await page.locator('article.task-card').count()===0,'browser no-match filter');await search.fill(persistentTitle);await eventually(async()=>await page.locator('article.task-card').count()===1,'browser one-match filter');await search.fill('');await card().waitFor();record('ops-board','filter',{emptyResult:true,oneMatch:true})
    for(let i=0;i<3;i++){const task=(await board()).tasks.find(task=>task.id===draft.id);if(task.status==='done')break;await card().locator('[data-action="move"]').click();await eventually(async()=>(await board()).tasks.find(task=>task.id===draft.id)?.status!==task.status,'browser status progression')}
    assert.equal((await board()).tasks.find(task=>task.id===draft.id).status,'done');await page.locator('[data-status="done"]').locator(`article[data-task-id=${JSON.stringify(draft.id)}]`).waitFor();await screenshot('ops-completed');record('ops-board','complete',{taskId:draft.id})
    await card().locator('[data-action="remove"]').click();await eventually(async()=>await page.locator('[data-action="confirm-remove"]').count()||!(await board()).tasks.some(task=>task.id===draft.id),'delete or show inline confirmation');if(await page.locator('[data-action="confirm-remove"]').count())await page.locator('[data-action="confirm-remove"]').click();await eventually(async()=>!(await board()).tasks.some(task=>task.id===draft.id),'browser delete');record('ops-board','remove',{taskId:draft.id})
    await page.reload({waitUntil:'networkidle'});await page.locator('article.task-card').filter({hasText:persistentTitle}).waitFor();assert.equal(await page.locator('article.task-card').filter({hasText:editedTitle}).count(),0);assert.ok((await board()).tasks.some(task=>task.title===persistentTitle));await screenshot('ops-reloaded-persistent');record('ops-board','reload',{persistentTitle})
    if(manifest.profile==='r4-real-development'){
      const unchangedBoard=await board(),persistentId=unchangedBoard.tasks.find(task=>task.title===persistentTitle).id
      const taskIds=async()=>await page.locator('article.task-card').evaluateAll(cards=>cards.map(card=>card.dataset.taskId).sort())
      const assertSavedFilter=async()=>{assert.equal(await page.locator('[name="query"]').inputValue(),persistentTitle);assert.deepEqual(await taskIds(),[persistentId]);return true}
      const savedName='浏览器视图 <'+unique+'>',renamedName='浏览器改名 '+unique,select=()=>page.locator('select[name="saved-view"]')
      await page.locator('[name="query"]').fill(persistentTitle)
      await page.locator('[data-action="save-view"]').click()
      const viewForm=()=>page.locator('form[data-form="saved-view"]')
      await viewForm().locator('[name="view-name"]').fill(savedName);await viewForm().locator('button[type="submit"]').click()
      await eventually(async()=>await select().locator('option').evaluateAll((options,name)=>options.some(option=>option.textContent===name),savedName),'saved view appears')
      await page.locator('[name="query"]').fill('')
      await select().selectOption({label:savedName});await eventually(assertSavedFilter,'saved view applies real task filter')
      await page.locator('[data-action="rename-view"]').click();await viewForm().locator('[name="view-name"]').fill(renamedName);await viewForm().locator('button[type="submit"]').click()
      await eventually(async()=>await select().locator('option').evaluateAll((options,name)=>options.some(option=>option.textContent===name),renamedName),'saved view renamed')
      await page.reload({waitUntil:'networkidle'});await select().selectOption({label:renamedName})
      await eventually(assertSavedFilter,'saved view persists and filters real tasks after actual bootstrap reload');await screenshot('ops-saved-view-persistent')
      await page.locator('[data-action="delete-view"]').click()
      await eventually(async()=>!(await select().locator('option').evaluateAll((options,name)=>options.some(option=>option.textContent===name),renamedName)),'saved view deleted')
      assert.equal(await page.locator('[name="query"]').inputValue(),'','deleting selected view restores ordinary board')
      await eventually(async()=>{assert.deepEqual(await taskIds(),unchangedBoard.tasks.filter(task=>task.archived!==true).map(task=>task.id).sort());return true},'deleted view restores complete active task set')
      await page.reload({waitUntil:'networkidle'});assert.equal(await select().locator('option').evaluateAll((options,name)=>options.some(option=>option.textContent===name),renamedName),false)
      assert.deepEqual(await board(),unchangedBoard,'all saved view actions leave server board, revision and events unchanged')
      record('ops-board','saved-view-crud-reload',{savedName,renamedName,actualBootstrap:true});out.r4SavedViewsPassed=true
    }
    await page.setViewportSize({width:390,height:844});const overflowing=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);assert.equal(overflowing,false,'Narrow browser must not require page-level horizontal scrolling');await screenshot('ops-narrow');await page.setViewportSize({width:1280,height:900})
    await stop(serverProcess);serverProcess=await start(ops);base=serverProcess.owned.base;await page.goto(base,{waitUntil:'networkidle'});await page.locator('article.task-card').filter({hasText:persistentTitle}).waitFor();assert.equal((await board()).tasks.some(task=>task.id===draft.id),false);record('ops-board','server-restart-persistence',{persistentTitle});await screenshot('ops-server-restarted');await stop(serverProcess)
    assert.deepEqual(browserErrors,[],'Application must run in real Chromium without JS/import errors or native prompts')
    out.projects.push({projectId:'ops-board',passed:true,workflow:['create','edit','filter-zero','filter-one','complete','remove','reload','server-restart','narrow-layout'],retainedTaskTitle:persistentTitle,browserErrors})

    const ledger=manifest.projects.find(project=>project.id==='ledger-api');assert.ok(ledger)
    const ledgerFile=path.join(ledger.path,'data/ledger.json');let reconcileBody,reconcileCommitted
    serverProcess=await start(ledger);base=serverProcess.owned.base;await page.goto(base,{waitUntil:'networkidle'});await screenshot('ledger-overview')
    const productId='browser-product-'+unique,orderId='browser-order-'+unique,sku='BROWSER-'+unique
    let r=await http(base,'/api/products',{method:'POST',body:{id:productId,sku,name:'Retained verification stock '+unique,priceCents:2500,stock:10}});assert.equal(r.status,201);assert.equal(r.json.data.id,productId);record('ledger-api','product-create',{productId,stock:10,priceCents:2500})
    r=await http(base,'/api/orders',{method:'POST',body:{id:orderId,lines:[{productId,quantity:3}],idempotencyKey:'ui-order-'+unique}});assert.equal(r.status,201);assert.equal(r.json.data.totalCents,7500);assert.equal(r.json.data.status,'placed');record('ledger-api','checkout',{orderId,totalCents:7500})
    const replay=await http(base,'/api/orders',{method:'POST',body:{id:orderId,lines:[{productId,quantity:3}],idempotencyKey:'ui-order-'+unique}});assert.equal(replay.status,200);assert.equal((await http(base,'/api/products')).json.data.find(product=>product.id===productId).stock,7)
    const excess=await http(base,'/api/orders',{method:'POST',body:{id:'too-many-'+unique,lines:[{productId,quantity:99}]}});assert.equal(excess.status,409);assert.equal(excess.json.error.code,'INSUFFICIENT_STOCK');assert.equal((await http(base,'/api/products')).json.data.find(product=>product.id===productId).stock,7)
    r=await http(base,`/api/orders/${encodeURIComponent(orderId)}/fulfil`,{method:'POST',body:{}});assert.equal(r.status,200);assert.equal(r.json.data.status,'fulfilled');record('ledger-api','fulfil',{orderId})
    if(manifest.profile==='r4-real-development'){
      r=await http(base,'/api/inventory/low-stock?threshold=7');assert.equal(r.status,200);assert.ok(r.json.data.some(product=>product.id===productId))
      const body={rows:[{productId,stock:6}],idempotencyKey:'browser-reconcile-'+unique,expectedRevision:JSON.parse(fs.readFileSync(ledgerFile,'utf8')).revision}
      r=await http(base,'/api/inventory/reconcile',{method:'POST',body});assert.equal(r.status,200);assert.equal(r.json.data.products.find(product=>product.id===productId).stock,6)
      assert.equal(Number.isSafeInteger(r.json.revision),true);assert.equal(r.json.revision,r.json.data.revision)
      reconcileBody=body;reconcileCommitted=r.json.data;const committedBytes=fs.readFileSync(ledgerFile)
      const replayCount=await http(base,'/api/inventory/reconcile',{method:'POST',body});assert.equal(replayCount.status,200);assert.equal(replayCount.json.revision,r.json.revision);assert.deepEqual(replayCount.json.data,reconcileCommitted);assert.deepEqual(fs.readFileSync(ledgerFile),committedBytes,'replay cannot change persisted revision, stock, keys or events')
      const conflict=await http(base,'/api/inventory/reconcile',{method:'POST',body:{...body,rows:[{productId,stock:5}]}});assert.equal(conflict.status,409);assert.equal(conflict.json.error.code,'IDEMPOTENCY_CONFLICT')
      assert.deepEqual(fs.readFileSync(ledgerFile),committedBytes,'key conflict cannot change durable ledger')
      record('ledger-api','inventory-reconcile-replay-conflict',{productId,stock:6,key:body.idempotencyKey});out.r4InventoryPassed=true
    }
    await stop(serverProcess);serverProcess=await start(ledger);base=serverProcess.owned.base;const restored=await http(base,`/api/orders/${encodeURIComponent(orderId)}`);assert.equal(restored.status,200);assert.equal(restored.json.data.status,'fulfilled');assert.equal(restored.json.data.totalCents,7500);const expectedStock=manifest.profile==='r4-real-development'?6:7;assert.equal((await http(base,'/api/products')).json.data.find(product=>product.id===productId).stock,expectedStock);record('ledger-api','server-restart-persistence',{orderId,stock:expectedStock});await page.goto(base,{waitUntil:'networkidle'});await screenshot('ledger-restarted-overview')
    if(manifest.profile==='r4-real-development'){
      const persistedBytes=fs.readFileSync(ledgerFile),replayed=await http(base,'/api/inventory/reconcile',{method:'POST',body:reconcileBody})
      assert.equal(replayed.status,200);assert.deepEqual(replayed.json.data,reconcileCommitted);assert.equal(replayed.json.revision,reconcileCommitted.revision)
      const rejected=await http(base,'/api/inventory/reconcile',{method:'POST',body:{...reconcileBody,rows:[{productId,stock:5}]}});assert.equal(rejected.status,409);assert.equal(rejected.json.error.code,'IDEMPOTENCY_CONFLICT')
      assert.deepEqual(fs.readFileSync(ledgerFile),persistedBytes,'restart retains key replay before stale CAS and conflict atomicity');record('ledger-api','reconcile-restart-stale-cas-replay',{productId,key:reconcileBody.idempotencyKey});out.r4InventoryRestartPassed=true
    }
    await stop(serverProcess)
    assert.deepEqual(browserErrors,[],'Both project overviews must run in real Chromium without JS/import errors or native prompts')
    out.projects.push({projectId:'ledger-api',passed:true,workflow:['overview','catalog-create','checkout','idempotent-replay','oversell-reject','fulfil','server-restart-persistence'],retainedProductId:productId,retainedOrderId:orderId,browserErrors})
  }catch(error){out.errors.push(errorInfo(error));if(page){try{await screenshot('failure')}catch{}}}
  finally{
    for(const serverProcess of childObjects)if(!serverProcess.owned.closed){try{await stop(serverProcess)}catch(error){out.errors.push({source:'server-cleanup',...errorInfo(error)})}}
    try{await browser?.close()}catch(error){out.errors.push({source:'browser-cleanup',...errorInfo(error)})}
    out.finishedAt=new Date().toISOString();out.cleanupConfirmed=childObjects.every(serverProcess=>serverProcess.owned.closed)&&out.cleanup.every(row=>row.exited&&row.portReleased);out.passed=out.errors.length===0&&out.projects.length===2&&out.projects.every(project=>project.passed)&&out.cleanupConfirmed&&(manifest.profile!=='r4-real-development'||(out.r4SavedViewsPassed===true&&out.r4InventoryPassed===true&&out.r4InventoryRestartPassed===true))
    fs.writeFileSync(path.join(root,currentProjects?'current-project-ui-acceptance.json':'project-ui-acceptance.json'),JSON.stringify(out,null,2)+'\n')
  }
  return out
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(!process.argv[2])throw new Error('Usage: node scripts/longrun/verify-project-uis.mjs <run-root> [--current-projects]');const out=await verify(process.argv[2],{currentProjects:process.argv.includes('--current-projects')});console.log(JSON.stringify({root:out.root,scope:out.scope,passed:out.passed,projects:out.projects,errors:out.errors,cleanupConfirmed:out.cleanupConfirmed,screenshots:out.screenshots},null,2));process.exitCode=out.passed?0:2}
