import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const timeoutSource = fs.readFileSync(new URL('../../multi-agent-console/src/web/components/mcp-timeout.ts', import.meta.url), 'utf8')
const { parseMcpTimeout } = await import('data:text/javascript;base64,' + Buffer.from(compile(timeoutSource)).toString('base64'))

function submitFunction(relative, start, end, name) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
  const offset = source.indexOf(start)
  assert.ok(offset >= 0)
  const stop = source.indexOf(end, offset)
  assert.ok(stop > offset)
  const code = compile(source.slice(offset, stop))
  return new Function('env', 'with (env) { ' + code + '; return ' + name + '; }')
}
const legacySubmit = submitFunction('../../multi-agent-console/src/web/components/McpPanel.tsx', '  const submit = async () => {', '\n  return (', 'submit')
const settingsSubmit = submitFunction('../../multi-agent-console/src/web/components/settings/McpSettings.tsx', '  const handleSubmit = async () => {', '  // ── 启用', 'handleSubmit')

async function captured(factory, values, editing = null) {
  const calls = [], errors = []
  const mcpApi = { create: async input => { calls.push({kind:'create',input}); return input }, update: async (id,input,query) => { calls.push({kind:'update',id,input,query});return input } }
  const message = {success(){},error(e){errors.push(e)}}
  await factory({form:{validateFields:async()=>values},editing,parseMcpTimeout,mcpApi,setLoading(){},setModalOpen(){},load(){},antMsg:message,message,onSaved(){}})()
  return {calls,errors}
}
const fixture = {name:'timeout-server',id:'timeout-server',transportType:'stdio',command:'node',args:'',enabled:true,scope:'global'}

test('console timeout parser preserves zero, defaults and engine integer range',()=>{
  for (const value of [null,undefined,'','   ']) assert.equal(parseMcpTimeout(value),undefined)
  for (const value of [0,'0','15000',2147483647]) assert.equal(parseMcpTimeout(value),Number(value))
  for (const value of [-1,'1.5','NaN',2147483648,'1e3']) assert.throws(()=>parseMcpTimeout(value),/请求超时/)
})

for (const [name, factory] of [['legacy MCP panel',legacySubmit],['settings MCP editor',settingsSubmit]]) {
  test(name+' submits zero/positive values and resets an edit with null',async()=>{
    for (const timeoutMs of ['0','45000']) {
      const result=await captured(factory,{...fixture,timeoutMs})
      assert.deepEqual(result.errors,[])
      assert.equal(result.calls.length,1)
      assert.equal(result.calls[0].input.timeoutMs,Number(timeoutMs))
    }
    const blank=await captured(factory,{...fixture,timeoutMs:''})
    assert.deepEqual(blank.errors,[])
    assert.equal(Object.hasOwn(blank.calls[0].input,'timeoutMs'),false)
    const editing={...fixture,timeoutMs:45000,scope:'global'}
    const reset=await captured(factory,{...fixture,timeoutMs:''},editing)
    assert.deepEqual(reset.errors,[])
    assert.equal(reset.calls[0].input.timeoutMs,null)
    assert.deepEqual(reset.calls[0].query,{scope:'global'})
  })
  test(name+' does not send invalid timeout values',async()=>{
    const result=await captured(factory,{...fixture,timeoutMs:'-1'})
    assert.equal(result.calls.length,0)
    assert.equal(result.errors.length,1)
    assert.match(result.errors[0],/请求超时/)
  })
}
