/** Independent write grants must work without fetching a directory the current member may not read. */
export const ADMIN_WRITE_ONLY_JS = String.raw`
async function knownIdentifiers(ctx, title, labels) {
  const content=node('div',null,'dialog-body');
  content.append(node('p','请输入管理员提供的标识。不要输入后台密钥或实例令牌。','hint'));
  const fields=labels.map(([id,label])=>{const input=inputControl(id);input.required=true;input.maxLength=96;input.spellcheck=false;input.autocapitalize='none';content.append(entry(label,input));return input;});
  let values;
  const ok=await modal({title,content,confirmLabel:'继续',commit:()=>{values=fields.map(input=>input.value.trim());if(values.some(v=>isSensitiveSearch(v)||!/^[a-z0-9][a-z0-9_.:-]{0,95}$/i.test(v)))throw new Error('请输入有效的条目标识，不要使用密钥。');}});
  return ok&&!ctx.signal.aborted?values:null;
}
function writeOnlyDirectory(ctx,kind) {
  const member=kind==='members',subject=member?'成员':'角色', group=node('div',null,'panel-tools direct-actions');
  const add=(id,label,fn)=>{const b=labeledAction(ctx,label,fn,'secondary');b.id=id;group.append(b);};
  if(ctx.can(kind+'.write'))add('direct-'+kind,'管理指定'+subject,()=>changeKnown(ctx,kind,subject));
  if(member&&ctx.can('credentials.write')){
    add('direct-issue','签发密钥',async()=>{const ids=await knownIdentifiers(ctx,'为指定成员签发密钥',[['target-member-id','成员标识']]);if(ids)await issueForMember(ctx,ids[0],ids[0]);});
    add('direct-revoke','撤销密钥',async()=>{const ids=await knownIdentifiers(ctx,'撤销指定密钥',[['target-member-id','成员标识'],['target-key-id','密钥标识']]);if(!ids)return;const [m,k]=ids;const ok=await modal({title:'撤销这把密钥？',description:'成员 '+m+' 的密钥 '+k+' 将立即停止使用。',danger:true,confirmLabel:'撤销密钥',commit:()=>ctx.api('members/'+idPath(m)+'/credentials/'+idPath(k),{method:'DELETE'})});if(ok&&!ctx.signal.aborted)await queueNotice(ctx,'密钥已撤销。');});
  }
  ctx.body.replaceChildren(panel('没有查看'+subject+'列表的权限','可执行已获授权的操作。处理已有'+subject+'时，请先从管理员处取得准确标识。'),group);
}
async function changeKnown(ctx,kind,subject){
  const ids=await knownIdentifiers(ctx,'管理指定'+subject,[['target-record-id',subject+'标识']]);if(!ids)return;
  const id=ids[0],isMember=kind==='members',path=kind+'/'+idPath(id);
  if(!isMember&&(['super-admin','viewer','auditor'].includes(id)||id===profile.roleId)){ctx.announce('内置角色或自己正在使用的角色不能修改。');return;}
  const self=isMember&&id===profile.id, options=[['rename','更改名称']];
  if(!self){if(isMember)options.push(['role','分配角色'],['enable','启用成员'],['disable','禁用成员']);else options.push(['permissions','替换权限']);options.push(['delete','删除'+subject]);}
  const content=node('div',null,'dialog-body'),select=selectControl('direct-operation',options,'rename'),input=inputControl('direct-value');input.maxLength=80;
  const field=entry('新名称',input),caption=field.querySelector('label'),matrix=node('fieldset',null,'dialog-field'),checks=node('div',null,'matrix');matrix.append(node('legend','替换后的权限'),checks,node('p','当前权限不可查看。保存后，选中的权限将完全替换现有权限。','hint'));
  const toggle=()=>{const v=select.value;field.hidden=v!=='rename'&&v!=='role';input.disabled=field.hidden;input.required=!field.hidden;caption.textContent=v==='role'?'新角色标识':'新名称';input.maxLength=v==='role'?96:80;matrix.hidden=v!=='permissions';};
  select.addEventListener('change',()=>{input.value='';toggle();});toggle();
  for(const [p,label] of Object.entries(permissionLabels)){if(!ctx.can(p))continue;const l=node('label'),cb=node('input');cb.type='checkbox';cb.value=p;l.append(cb,node('span',label));checks.append(l);}
  content.append(node('p',subject+'标识：'+id,'hint'),entry('操作',select),field,matrix);
  let operation='',value='',permissions=[];
  const proceed=await modal({title:'管理指定'+subject,content,confirmLabel:'继续',commit:()=>{operation=select.value;value=input.value.trim();if(!field.hidden&&(!value||isSensitiveSearch(value)))throw new Error('请输入有效内容，不要使用密钥。');if(operation==='role'&&!/^[a-z0-9][a-z0-9_.:-]{0,95}$/i.test(value))throw new Error('请输入有效角色标识。');permissions=[...checks.querySelectorAll('input:checked')].map(c=>c.value);}});
  if(!proceed||ctx.signal.aborted)return;
  if(operation==='delete'){await removeRecord(ctx,path,id,'删除此'+subject+'后无法恢复。',subject+'已删除。');return;}
  const changes=operation==='rename'?{name:value}:operation==='role'?{roleId:value}:operation==='permissions'?{permissions}:{enabled:operation==='enable'};
  const summary=operation==='permissions'?'设置为 '+permissions.length+' 项权限，取代已有权限。':operation==='rename'?'新名称：'+value:operation==='role'?'新角色标识：'+value:operation==='enable'?'将启用该成员。':'将禁用该成员及其现有登录密钥。';
  const ok=await modal({title:'确认'+(options.find(o=>o[0]===operation)?.[1]||'更改')+'？',description:subject+' '+id+'。'+summary,danger:['disable','permissions','role'].includes(operation),confirmLabel:'确认更改',commit:()=>ctx.api(path,{method:'PATCH',body:changes})});
  if(ok&&!ctx.signal.aborted)await queueNotice(ctx,subject+'已更新。');
}
async function writeOnlyRuleTarget(ctx,edit){
  const content=node('div',null,'dialog-body'),id=inputControl('target-rule-id'),revision=inputControl('target-rule-revision','','number'),choice=selectControl('target-rule-operation',[['edit','编辑规则'],['enable','启用规则'],['disable','暂停规则'],['delete','删除规则']]);
  id.required=true;id.maxLength=36;id.spellcheck=false;revision.required=true;revision.min='1';revision.max='2147483647';revision.step='1';
  content.append(entry('规则标识',id),entry('当前版本',revision),entry('操作',choice),node('p','使用创建或修改该规则时返回的版本号，以免覆盖其他人的更新。','hint'));
  let target,version,op;
  const chose=await modal({title:'管理指定规则',content,confirmLabel:'继续',commit:()=>{target=id.value.trim();version=Number(revision.value);op=choice.value;if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(target)||!Number.isSafeInteger(version)||version<1||version>2147483647)throw new Error('请输入有效的规则标识和版本号。');}});
  if(!chose||ctx.signal.aborted)return;if(op==='edit'){edit({id:target,revision:version,unread:true});return;}
  const label=op==='enable'?'启用规则':op==='disable'?'暂停规则':'删除规则';
  let saved;const ok=await modal({title:label+'？',description:'规则 '+target+'，版本 '+version+'。',danger:op!=='enable',confirmLabel:label,commit:async()=>{saved=op==='delete'?await ctx.api('rules/'+target+'?revision='+version,{method:'DELETE'}):await ctx.api('rules/'+target,{method:'PATCH',body:{revision:version,enabled:op==='enable'}});}});
  if(ok&&!ctx.signal.aborted){ctx.announce(op==='delete'?'规则已删除。':'规则已更新。标识：'+target+'，版本：'+saved.revision);await ctx.reload();}
}
`
