// Prepare a new protected development contract without replacing the original.
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {expectedContractTests} from './project-driver.mjs'

const domainStages=[
  '实现 reconcileInventory 的绝对库存、不可变返回、单次 revision 与确定性时间戳。',
  '所有盘点行必须严格校验 safe integer、非空 ID、禁止重复产品。',
  '任意未知产品或非法行整批失败，原 ledger、产品和事件不可改变。',
  'expectedRevision 与审计事件；有效无变化盘点也必须产生一个新 revision 和一个审计事件。',
  'idempotencyKey 规范请求重放与内容冲突；重放优先于过期 CAS，不覆盖后续库存。',
  '完整单事件 rows 审计，key 校验，不复用其它操作的幂等键。',
  '活跃预留保护：盘点库存不能低于未释放且未过期的预留。',
  '保留订单金额 / 收入 / 状态；旧 cancel / commit 与盘点共存。',
  'JSON 可移植性、MAX_SAFE_INTEGER、独立幂等键。',
  '20 产品批次一个 revision，真实 checkout 后幂等重放不得重置库存。',
]
const apiStages=[
  '独立实现 GET /api/inventory/low-stock?threshold=N。阈值严格 safe integer，stock<=threshold，按 sku 稳定排序，查询不改持久文件。',
  '实现 POST /api/inventory/reconcile，真实复用 domain 盘点并与其返回一致。',
  '认证、JSON 和 HTTP method 错误明确，禁止未授权写入。',
  '未知或重复产品整批失败，响应和磁盘数据保持原子性。',
  'expectedRevision 与并发请求；过期版本拒绝且不丢库存修改。',
  '幂等重放与 key 内容冲突，不产生重复审计事件。',
  '真实磁盘和服务重启后保留库存 / 幂等信息。',
  '两个 repository / HTTP server 共享文件的 CAS，不丢并发修改。',
  '活跃预留与 low-stock 查询反映盘点结果。',
  '盘点与旧订单全过程共存，body size 和请求边界准确。',
]
const apiDomainDependencies=[null,1,3,3,4,5,6,5,7,10]
const roleRunners={'ops-domain':'domain','ops-view':'view','ops-storage':'storage','ledger-domain':'domain','ledger-api':'api'}

export function prepare(projectRoot){
  projectRoot=path.resolve(projectRoot)
  const manifest=JSON.parse(fs.readFileSync(path.join(projectRoot,'manifest.json'),'utf8'))
  // Validate all inputs before writing either integration or the profile. A
  // missing contract must not leave a partly generated runnable manifest.
  for(const project of manifest.projects){
    project.path=path.resolve(projectRoot,project.path)
    const relative=path.relative(projectRoot,project.path)
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('R4 project path escapes retained root')
    for(const name of ['tests','contracts','contracts/r4.md']){
      const file=path.join(project.path,name)
      if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||!fs.realpathSync(file).startsWith(fs.realpathSync(projectRoot)+path.sep))throw new Error('Missing or unsafe protected R4 contract: '+file)
    }
    for(const role of project.roles){
      const runner='tests/r4-'+roleRunners[role.id]+'-test.mjs'
      if(!roleRunners[role.id]||JSON.stringify(role.stages.map(stage=>stage.index))!==JSON.stringify(Array.from({length:10},(_,i)=>i+1)))throw new Error('Invalid R4 role/stages: '+role.id)
      for(const stage of [1,10])if(!expectedContractTests(project.path,{args:[runner,String(stage)]}))throw new Error('Missing protected R4 tests: '+runner)
    }
  }
  manifest.profile='r4-real-development'
  for(const project of manifest.projects){
    project.integrationTestCommand={command:'node',args:['tests/r4-integration.mjs','10']}
    for(const role of project.roles){
      role.requiresDevelopment=true
      const runner='tests/r4-'+roleRunners[role.id]+'-test.mjs'
      if(runner.includes('undefined'))throw new Error('Unknown role '+role.id)
      for(const stage of role.stages){
        stage.title='R4 '+stage.title
        stage.testCommand={command:'node',args:[runner,String(stage.index)]}
        stage.testCommandText='node '+stage.testCommand.args.join(' ')
        if(stage.index===1)stage.dependencies=[]
        let demand
        if(role.id==='ops-domain')demand='实现 contracts/r4.md 中保存视图的 createSavedView / updateSavedView / removeSavedView / querySavedView，独立 collection、深拷贝、错误原子、全部过滤边界。S1 实现 CRUD；S10 验收与真实 board 查询的完整组合。'
        else if(role.id==='ops-storage')demand='实现 contracts/r4.md 的 createSavedViewStore(adapter,key,options)：独立 key、真实 CAS、bounded retry、create/update/remove、重建恢复、错误原子，不污染 board。S1 可独立实现，不必依赖另一会话的新 export；S10 验收并发和异常恢复。'
        else if(role.id==='ops-view')demand=stage.index===10?'完成 contracts/r4.md 的真实 mountApp 保存视图全过程：可选 savedViewStore、无 prompt 的保存/改名表单、选择应用过滤、删除恢复、异步失败和 destroy 清理，保持旧 API 兼容。':'先实现 contracts/r4.md 的 renderSavedViewMenu，真实 escaped / accessible controls；保留所有已有 UI 功能。S10 再接入持久 store 和 mountApp 全过程。'
        else if(role.id==='ledger-domain')demand=domainStages[stage.index-1]
        else {demand=apiStages[stage.index-1];if(stage.index>=2)stage.dependencies=[{role:'ledger-domain',stage:apiDomainDependencies[stage.index-1]}]}
        stage.prompt=`保留项目的新开发增量，不重置已存在源码。先阅读 contracts/r4.md 的本角色接口和 ${runner} 中当前累计 check。当前增量：${demand}\n新 runner 会先执行旧角色或项目 stage10 全量基线，然后执行新 R4 S1..S${stage.index}；旧十阶段功能必须完整保留。源码只改本角色 allowedFiles。新合同/测试/manifest-r4 同样禁止修改。S1 的新测试在本轮开始前应完整失败，你必须实际实现功能；不允许只改注释来充数。阶段2..9中已通过的功能可复验，不要为制造改动破坏成熟代码。按照 contracts/r4.md 准确实现，不伪造返回、硬编码验收值、删测试或扩展超出本阶段的需求。`
      }
    }
    const commands=project.roles.map(role=>role.stages.at(-1).testCommand)
    const directives=commands.map(command=>'// baseline-contract: '+command.args.join(' ')).join('\n')
    const integration=`${directives}\nimport {spawn} from 'node:child_process';\nconst commands=${JSON.stringify(commands.map(command=>command.args))};\nfor(const args of commands){const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',resolve)});if(code!==0)process.exit(code??1)}\nconsole.log('R4_RETAINED_BASELINE_AND_NEW_FEATURES_PASSED');\n`
    fs.writeFileSync(path.join(project.path,'tests/r4-integration.mjs'),integration)
  }
  manifest.protectedPaths=[...new Set([...(manifest.protectedPaths??[]),'manifest-r4.json'])]
  const filename=path.join(projectRoot,'manifest-r4.json')
  fs.writeFileSync(filename,JSON.stringify(manifest,null,2)+'\n')
  const counts=manifest.projects.map(project=>({projectId:project.id,roles:project.roles.map(role=>({roleId:role.id,first:expectedContractTests(project.path,role.stages[0].testCommand),final:expectedContractTests(project.path,role.stages.at(-1).testCommand)})),integration:expectedContractTests(project.path,project.integrationTestCommand)}))
  if(counts.some(project=>project.roles.some(role=>!role.first||!role.final)))throw new Error('Missing protected R4 tests; do not start formal load')
  return {filename,counts}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(prepare(process.argv[2]??'test-projects/longrun-20261009'),null,2))
