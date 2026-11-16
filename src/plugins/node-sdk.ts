/** Loaded before plugin code. IPC contains requests/results only, never engine credentials. */
export function nodePluginSdk(context: Record<string, unknown>): string {
  return `const context = ${JSON.stringify(context).replace(/</g, '\\u003c')};
const pending = new Map(); let seq = 0;
const sdkError=(message,name='Error')=>{const error=new Error(message);error.name=name;error.stack=name+': '+message;return error};
const call = (capability, method, args = {}, options = {}) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(sdkError('宿主能力不可用'));
  if (options.signal?.aborted) return reject(sdkError('调用已取消','AbortError'));
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') return reject(new TypeError('onEvent 必须是函数'));
  const id = String(++seq);
  const cancel = () => {
    if (!pending.has(id)) return;
    if (process.connected) process.send({aetherCapability:1,id,cancel:true},()=>{});
    settle(id, sdkError('调用已取消','AbortError'));
  };
  pending.set(id, {resolve, reject, onEvent:options.onEvent, cleanup:()=>options.signal?.removeEventListener('abort',cancel)}); process.channel?.ref();
  options.signal?.addEventListener('abort', cancel, {once:true});
  process.send({aetherCapability:1,id,capability,method,args}, error => {
    if(error)settle(id,sdkError('宿主连接已关闭'));
  });
});
function settle(id,error,result){const item=pending.get(id);if(!item)return;pending.delete(id);item.cleanup();if(error)item.reject(error);else item.resolve(result);if(!pending.size)process.channel?.unref()}
process.on('message', async message => {
  if(message?.aetherCapability!==1)return;
  const item=pending.get(message.id);if(!item)return;
  if(message.event){
    try{
      await item.onEvent?.(message.event);
      if(process.connected && pending.has(message.id))process.send({aetherCapability:1,id:message.id,ack:message.sequence},()=>{});
    }catch(error){
      if(process.connected)process.send({aetherCapability:1,id:message.id,cancel:true},()=>{});
      settle(message.id,error instanceof Error?error:sdkError('流事件处理失败'));
    }
    return;
  }
  settle(message.id,message.error?sdkError(message.error):undefined,message.result);
});
process.on('disconnect',()=>{for(const id of pending.keys())settle(id,sdkError('宿主连接已关闭'))});
process.channel?.unref();
const bind=(capability,method)=>(args={})=>call(capability,method,args);
const methods={skills:['skills.read',{list:'list',get:'get'}],session:['session.read',{messages:'messages'}],models:['models.read',{list:'list'}]};
const sdk={call,context:async()=>({...context})};
for(const [name,[capability,actions]]of Object.entries(methods))sdk[name]=Object.freeze(Object.fromEntries(Object.entries(actions).map(([name,method])=>[name,bind(capability,method)])));
sdk.workspace=Object.freeze({list:bind('workspace.read','list'),read:bind('workspace.read','read'),write:bind('workspace.write','write')});
sdk.knowledge=Object.freeze({list:bind('knowledge.read','list'),get:bind('knowledge.read','get'),search:bind('knowledge.read','search'),create:bind('knowledge.write','create'),update:bind('knowledge.write','update')});
sdk.ai=Object.freeze({run:bind('ai.run','run'),stream:(args,options)=>call('ai.run','stream',args,options)});
sdk.mcp=Object.freeze({list:bind('mcp.read','list'),tools:bind('mcp.read','tools'),call:bind('mcp.invoke','call')});
sdk.settings=Object.freeze({get:bind('settings.read','get'),set:bind('settings.write','set')});
sdk.agents=Object.freeze({list:bind('agents.read','list'),tools:bind('agents.read','tools'),status:bind('agents.read','status'),run:bind('agents.manage','run'),stream:(args,options)=>call('agents.manage','stream',args,options),cancel:bind('agents.manage','cancel')});
Object.defineProperty(globalThis,'$AE',{value:Object.freeze(sdk),writable:false,configurable:false});
`
}
