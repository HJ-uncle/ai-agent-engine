/** Personal spaces and their quotas are separate from console operators and RBAC members. */
export const ADMIN_ACCOUNTS_JS = String.raw`
async function editAccountQuota(ctx,item){
  const content=node('div',null,'dialog-body'), limit=inputControl('account-quota',String(item.limit),'number');
  limit.min=String(item.used);limit.max='100';limit.step='1';limit.required=true;
  content.append(node('p',item.name+' · 已使用 '+item.used+' 个名额。停用的子账号仍保留名额。','hint'),entry('子账号上限',limit));
  if(await modal({title:'调整子账号配额',content,confirmLabel:'保存',commit:async()=>{
    const n=limit.valueAsNumber;if(!Number.isInteger(n)||n<item.used||n>100)throw new Error('请输入已使用名额至 100 之间的整数。');
    await ctx.api('account-families/'+idPath(item.id)+'/quota',{method:'PATCH',body:{limit:n,expectedLimit:item.limit}});
  }}))await queueNotice(ctx,'子账号配额已更新。');
}
async function issueAccountCode(ctx){
  let issued;const ok=await modal({title:'签发主账号开通码？',description:'此码可创建一个主账号，七天内有效。使用后或过期后不能再次使用。',confirmLabel:'签发',commit:async()=>{issued=await ctx.api('activation-codes',{method:'POST',body:{}});}});
  if(!ok||ctx.signal.aborted||!issued)return;
  if(typeof issued.code!=='string'||!/^aether_activate_[A-Za-z0-9_-]{43}$/.test(issued.code))throw new Error('签发结果无效，请查看开通码记录。');
  const value=inputControl('issued-activation-code',issued.code);value.className='key-output';value.readOnly=true;value.dir='ltr';
  const box=node('div',null,'dialog-body'),feedback=node('p','','hint');feedback.setAttribute('role','status');
  const copy=button('复制开通码',async()=>{try{await navigator.clipboard.writeText(value.value);if(value.isConnected)feedback.textContent='已复制。';}catch{if(value.isConnected){value.focus();value.select();feedback.textContent='已选中，请使用系统复制操作。';}}});
  box.append(node('p','请通过可信渠道交给注册人。关闭后无法再次查看。'),entry('主账号开通码（只显示一次）',value),copy,feedback);issued=null;
  try {await modal({title:'主账号开通码已签发',content:box,single:true,confirmLabel:'完成'});}finally{value.value='';}
  if(!ctx.signal.aborted)await ctx.reload();
}
async function loadAccountCodes(ctx){
  const state=pagerState('activation-codes'),params=new URLSearchParams({limit:'20'});const cursor=state.cursors[state.index];if(cursor)params.set('cursor',cursor);
  const data=await ctx.api('activation-codes?'+params);if(ctx.signal.aborted)return;
  if(!Array.isArray(data.items)||(data.nextCursor!==null&&typeof data.nextCursor!=='string'))throw new Error('服务返回的开通码记录无效。');
  const title=node('h3','开通码记录'),box=node('div',null,'list-card');box.setAttribute('aria-label','开通码记录');ctx.body.append(title);
  for(const item of data.items){const status={available:'待使用',revoked:'已撤销',used:'已使用',expired:'已过期'}[item.status];if(!status)throw new Error('开通码状态无效。');
    const {row,tools}=recordRow(status+' · '+formatDate(item.createdAt),'记录标识：'+item.id+' · 有效期至 '+formatDate(item.expiresAt));
    if(item.status==='available')tools.append(labeledAction(ctx,'撤销',async()=>{if(await modal({title:'撤销这个开通码？',description:'撤销后，它将不能再用于注册主账号。',confirmLabel:'撤销',danger:true,commit:()=>ctx.api('activation-codes/'+idPath(item.id),{method:'DELETE'})}))await queueNotice(ctx,'开通码已撤销。');},'row-action danger-text'));
    box.append(row);}
  ctx.body.append(data.items.length?box:panel('没有开通码记录','可签发一份有效期为七天的单次开通码。'));
  if(state.index||data.nextCursor){const paging=node('div',null,'pager'),previous=button('上一页',()=>{if(state.index){state.index--;void ctx.reload();}}),next=button('下一页',()=>{if(data.nextCursor){state.cursors.splice(state.index+1,Infinity,data.nextCursor);state.index++;void ctx.reload();}});previous.disabled=!state.index;next.disabled=!data.nextCursor;paging.append(previous,next);ctx.body.append(paging);}
}
registerAdminPage('accounts',async ctx=>{
  ctx.body.replaceChildren();const hasRead=ctx.can('accounts.read'),hasCodes=ctx.can('accounts.activation');
  if(hasCodes){const issue=labeledAction(ctx,'签发开通码',()=>issueAccountCode(ctx),'primary');issue.id='issue-activation-code';ctx.actions.append(issue);}
  if(hasRead){await listing(ctx,{id:'families',path:'account-families',title:'主账号配额',heading:true,placeholder:'主账号名称或完整标识',empty:'尚无主账号',blank:'使用开通码注册主账号后，可以在此查看和调整配额。',row:item=>{
    const {row,tools}=recordRow(item.name,item.id+' · 子账号 '+item.used+' / '+item.limit);if(ctx.can('accounts.quota'))tools.append(labeledAction(ctx,'调整配额',()=>editAccountQuota(ctx,item)));return row;}});}
  else if(ctx.can('accounts.quota')){ctx.body.append(panel('无主账号目录读取权限','请联系管理员同时授予“查看主账号及配额”，以便在此选择主账号。'));}
  if(hasCodes&&!ctx.signal.aborted)await loadAccountCodes(ctx);
});
`
