/** Read-only audit of real model evidence, published revisions and artifact bytes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { collectToolEvidence, durableArtifactEvidence } from './plugin-real-world-evidence.mjs'
import { unzipSync } from 'fflate'
import { PluginService } from '../../dist/plugins/service.js'

const roots=process.argv.slice(2).map(p=>resolve(p))
if(!roots.length)throw new Error('Pass isolated run directories to audit')
for(const root of roots){
  assert(root.includes(sep+'.e2e-tmp'+sep+'plugin-real-world-20261112'+sep+'ai'+sep),'Only isolated task evidence may be audited')
  const report=JSON.parse(readFileSync(join(root,'report.json'),'utf8')),audit={root,checkedAt:new Date().toISOString(),scenarios:{}},service=new PluginService(join(root,'state/plugins'))
  for(const state of Object.values(report.scenarios)){
    const directory=join(root,state.id),allFiles=readdirSync(directory),known=new Set(),stages=[]
    for(const stage of state.stages.filter(s=>s.status==='passed')){
      const matching=allFiles.filter(f=>new RegExp(`^stage-${stage.index}(?:-.*)?-trace\\.json$`).test(f)||f===`stage-${stage.index}-trace.json`).sort((a,b)=>statSync(join(directory,a)).mtimeMs-statSync(join(directory,b)).mtimeMs)
      assert(matching.length,`No stage trace for ${state.id}/${stage.index}`)
      const calls=new Map()
      for(const call of collectToolEvidence(directory,f=>f.startsWith(`stage-${stage.index}-`)))calls.set(call.id,call)
      const fresh=[...calls.values()].filter(c=>!known.has(c.id));for(const id of calls.keys())known.add(id)
      const successful=fresh.filter(c=>c.success)
      const startRevision=stage.index?stages.at(-1).endRevision:0,endRevision=stage.revision
      assert(endRevision>startRevision,'Stage must advance the plugin revision')
      const updates=successful.filter(c=>c.name===(stage.index?'plugin_update':'plugin_create'))
      assert(updates.length,`Stage ${stage.index} did not perform a new successful authoring mutation`)
      const publications=successful.filter(c=>c.name==='plugin_publish'&&c.args.expectedRevision===endRevision)
      assert(publications.length,`Stage ${stage.index} did not publish its own final revision`)
      const tests=successful.filter(c=>c.name==='plugin_test')
      const approvals=allFiles.filter(f=>f.startsWith(`stage-${stage.index}-`)&&/-approval-\d+\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(directory,f),'utf8')))
      const testedRevisions=tests.map(t=>({toolCallId:t.id,revision:t.args.revision??t.output?.revision??approvals.find(a=>a.toolCallId===t.id)?.pendingAction?.operation?.input?.revision}))
      const sourceSnapshot=await service.snapshot('default',state.id,endRevision,{allowDraft:true});assert.equal(sourceSnapshot.hash,stage.hash,'Stage archive must still match the accepted revision hash')
      const finalModelTestPassed=testedRevisions.some(t=>t.revision===endRevision)
      const failedFinalModelBatches=fresh.filter(c=>c.name==='plugin_test'&&c.success===false&&c.status==='failed'&&(c.args.revision??approvals.find(a=>a.toolCallId===c.id)?.pendingAction?.operation?.input?.revision)===endRevision).map(c=>({toolCallId:c.id,revision:endRevision,success:false,error:c.error??'Model test batch reported failure',caseNames:c.args.cases?.map(item=>item.name)}))
      let finalRevisionTesting={layer:'model-plugin-test',revision:endRevision,status:'passed'}
      if(!finalModelTestPassed){
        const independent=allFiles.filter(f=>f.startsWith(`stage-${stage.index}-`)&&f.endsWith('-business.json')).map(file=>({file,results:JSON.parse(readFileSync(join(directory,file),'utf8'))})).find(({results})=>results.length===stage.caseCount&&results.every(r=>r.status==='passed')&&results.some(r=>r.output?.plugin)&&results.filter(r=>r.output).every(r=>r.output.plugin?.revision===endRevision&&r.output.plugin?.hash===stage.hash))
        assert(independent,`Stage ${stage.index} has neither a successful final model batch nor complete exact-revision independent HTTP tests`)
        finalRevisionTesting={layer:'independent-http-business',revision:endRevision,hash:stage.hash,file:join(directory,independent.file),caseCount:independent.results.length,status:'passed',modelBatchStatus:failedFinalModelBatches.length?'failed':'not-final-revision',note:'Model batch outcomes remain unchanged. Final revision acceptance is evidenced separately by complete independent host business assertions.'}
      }
      stages.push({index:stage.index,startRevision,endRevision,createdOrUpdated:updates.map(c=>c.id),tests:testedRevisions,failedFinalModelBatches,finalRevisionTesting,sourceArchive:{directory:sourceSnapshot.directory,hash:sourceSnapshot.hash,revision:endRevision},publication:publications.map(c=>c.id),freshToolCalls:fresh.length,independentCaseCount:stage.caseCount,status:'passed'})
    }
    const artifactFiles=[]
    const useTraces=allFiles.filter(f=>/^selected-use-trace(?:-.*)?\.json$/.test(f))
    for(const file of useTraces)for(const call of JSON.parse(readFileSync(join(directory,file),'utf8'))){
      if(!call.success||!call.name.startsWith('plugin_'+state.id.replaceAll('-','_')+'_'))continue
      let durable
      if(call.artifactEvidence){
        const published=await service.snapshot('default',state.id,call.artifactEvidence.plugin.revision,{allowDraft:false})
        durable=durableArtifactEvidence(call,{workspace:join(root,'workspace'),plugin:{id:state.id,revision:published.revision,hash:published.hash}})
        assert.deepEqual(durable,call.artifactEvidence,'Saved fallback evidence must still match actual files and published source')
        assert.equal(call.output,undefined,'Truncated model response must not be relabeled as complete tool output')
      }
      for(const receipt of durable?.artifacts??call.output?.artifacts??[]){
        const target=resolve(receipt.path),workspace=join(root,'workspace')
        assert(target.startsWith(workspace+sep),'Artifact escapes isolated workspace')
        const bytes=readFileSync(target),sha256=createHash('sha256').update(bytes).digest('hex')
        assert.equal(bytes.byteLength,receipt.byteLength);assert.equal(sha256,receipt.sha256??receipt.expectedHash?.replace(/^sha256:/,''))
        artifactFiles.push({path:target,bytes:bytes.byteLength,sha256,toolCallId:call.id,status:'passed',businessEvidenceSource:durable?'durable-json-artifact':'tool-output',outputTruncated:Boolean(durable)})
      }
    }
    const portableWarnings=[];let archiveVerification=null
    if(state.export?.project){
      const expected=JSON.parse(readFileSync(join(state.export.project,'aether-plugin.json'),'utf8'))
      const zip=readFileSync(state.export.zipPath);assert.equal(createHash('sha256').update(zip).digest('hex'),state.export.sha256)
      const archived=unzipSync(zip),entries=[]
      for(const [file,bytes]of Object.entries(archived)){
        assert(!file.includes('\\')&&!file.split('/').some(p=>!p||p==='.'||p==='..'),'Unsafe ZIP entry')
        const target=resolve(state.export.project,file);assert(target.startsWith(resolve(state.export.project)+sep),'ZIP entry escaped project')
        const extracted=readFileSync(target);assert.equal(Buffer.compare(Buffer.from(bytes),extracted),0,'ZIP bytes differ from standalone-test project')
        entries.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
      }
      archiveVerification={revision:state.export.revision,sha256:state.export.sha256,zipPath:state.export.zipPath,project:state.export.project,entries,extractedProjectMatchesActualZip:true,status:'passed'}
      writeFileSync(join(directory,`archive-verification-r${state.export.revision}.json`),JSON.stringify(archiveVerification,null,2)+'\n')
      function inspect(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name==='.e2e-tmp'||entry.name==='node_modules')continue;const path=join(dir,entry.name);if(entry.isDirectory())inspect(path);else{const content=readFileSync(path,'utf8');if([root,root.replaceAll('\\','/'),root.replaceAll('\\','\\\\')].some(p=>content.includes(p)))portableWarnings.push({file:path,reason:'machine-specific acceptance path'});if(/[/\\]scripts[/\\]/.test(path)&&/\btmpdir\s*\(/.test(content))portableWarnings.push({file:path,reason:'OS temp fixture instead of project .e2e-tmp'})}}}
      inspect(state.export.project)
      assert.equal(expected.id,state.id)
    }
    audit.scenarios[state.id]={status:state.status,stages,artifactFiles,portableWarnings,archiveVerification,export:state.export??null}
  }
  writeFileSync(join(root,'independent-evidence-audit.json'),JSON.stringify(audit,null,2)+'\n')
  console.log(JSON.stringify({root,scenarios:Object.fromEntries(Object.entries(audit.scenarios).map(([id,s])=>[id,{stages:s.stages.length,artifactFiles:s.artifactFiles.length,portableWarnings:s.portableWarnings.length}]))}))
}
