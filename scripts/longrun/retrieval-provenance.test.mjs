import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRetrieval,memoryRetrievalSource } from './continuation-driver.mjs'

test('current-second new memories and edits cannot qualify as old durable retrieval',()=>{
  const root=1791576100500,second=Math.floor(root/1000),probes=[{id:'p',expectedPatterns:['quota 37']}],answer='[HISTORY_RETRIEVAL] {"p":{"answer":"quota 37","sourceIds":["node"]}}'
  const events=[{toolCall:{name:'recall',id:'t'}},{toolResult:{id:'t',success:true,output:'[node] quota 37'}}]
  const qualifies=node=>evaluateRetrieval(probes,answer,events,[memoryRetrievalSource({id:'node',summary:'quota 37',...node})],root).passed
  assert.equal(qualifies({createdAt:second,updatedAt:second}),false)
  assert.equal(qualifies({createdAt:second-100,updatedAt:second}),false)
  assert.equal(qualifies({createdAt:second-100,updatedAt:second-2}),true)
  assert.equal(qualifies({createdAt:undefined,updatedAt:undefined}),false)
})
