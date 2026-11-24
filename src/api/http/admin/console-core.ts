/** Browser code embedded in app.js. No window-level credential or storage access. */
export const ADMIN_CORE_JS = String.raw`
const pages = new Map(), pageState = new Map();
const pageInfo = {
  overview:['服务器概览','连接状态与最近一次采样。'], members:['后台成员','管理谁可以登录这个后台，以及他们使用的密钥。'],
  accounts:['个人账号','签发主账号开通码，调整每个主账号可使用的子账号名额。'],
  roles:['角色与权限','为成员分配完成工作所需的权限。'], audit:['审计日志','查看后台操作的执行人、目标和结果。'],
  rules:['监控规则','管理监控条件，并用最近一次采样检查越限情况。'], settings:['实例设置与连接','配对客户端，并查看服务端启动设置。'],
  none:['暂无可访问的页面','此身份已经连接，但尚未获得可查看的管理权限。请联系管理员。'] };
let profile = null, section = 'overview', viewController = null, identityRequest = null, modalState = null;
const shell = el('admin-console'), nav = el('management-nav'), navToggle = el('nav-toggle'), consoleNote = el('console-message');
const guide = el('configuration-guide'), guideHome = el('guide-home'), setupHome = el('candidate-home');
function node(tag,text,className) { const n=document.createElement(tag);if(text!==undefined&&text!==null)n.textContent=String(text);if(className)n.className=className;return n; }
function button(label,handler,cls='secondary') { const b=node('button',label,cls);b.type='button';b.addEventListener('click',handler);return b; }
function announce(message) { consoleNote.textContent=message||'';consoleNote.hidden=!message; }
function can(what) { return !!profile && profile.permissions.includes(what); }
function allowedPage(which) { if(which==='accounts')return can('accounts.read')||can('accounts.activation')||can('accounts.quota'); if(which==='overview')return can('status.read')||can('metrics.read');if(which==='settings')return can('status.read');if(which==='members')return can('members.read')||can('members.write')||can('credentials.write');if(which==='roles')return can('roles.read')||can('roles.write');if(which==='rules')return can('rules.read')||can('rules.manage');return can(which+'.read'); }
function registerAdminPage(id,render) { pages.set(id,render); }
function currentState(id,create) { if(!pageState.has(id))pageState.set(id,create());return pageState.get(id); }
function abortError() {return new DOMException('请求已取消','AbortError');}
function idPath(id) { if(typeof id!=='string'||!/^[a-z0-9][a-z0-9_.:-]{0,95}$/i.test(id))throw new Error('服务返回的条目标识无效。');return encodeURIComponent(id); }
function formatDate(value) {const t=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(t)?date.format(new Date(t)):'—';}
function failStatus(status,body) {
  const raw=typeof body?.message==='string'?body.message:'';
  const instance=status===401&&/^invalid or missing instance token$/i.test(raw.trim());
  let message=instance?'实例令牌缺失或不匹配。请填写此服务启动时配置的令牌。':({400:'内容或筛选条件无效，请检查后再试。',401:'管理员凭据无效或已过期。请重新输入。',403:'当前角色没有执行此操作的权限。',404:'条目不存在或已删除。',409:'操作与当前配置冲突，请刷新后重试。',429:'请求过于频繁，请稍后重试。'}[status]||'服务暂时无法完成此操作。');
  // Only display bounded, human-written validation messages; never render request values, SQL, stacks or credentials.
  if([400,403,409,422].includes(status)&&raw.length<=140&&/^[\p{Script=Han}\p{N}\s，。；、：（）至]+$/u.test(raw))message=raw;
  const error=new Error(message);error.status=status;error.code=body?.code;error.instance=instance;return error;
}
async function http(credentials,path,options={},signal) {
  if(!safe||!credentials||signal?.aborted)throw abortError();
  if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||path.includes('#'))throw new Error('无效的管理地址。');
  const target=new URL('./'+path,location.href),adminRoot=new URL('./',location.href);
  if(target.origin!==location.origin||!target.pathname.startsWith(adminRoot.pathname))throw new Error('无效的管理地址。');
  const ctrl=new AbortController();let timed=false;const stop=()=>ctrl.abort();signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timed=true;ctrl.abort();},12000);
  try {
    const headers={Accept:'application/json'};
    if(credentials.kind==='bearer')headers.Authorization='Bearer '+credentials.key;
    else if(credentials.kind!=='desktop'&&credentials.key.startsWith('aether_admin_'))headers['X-Aether-Admin-Key']=credentials.key;
    else if(credentials.kind!=='desktop')headers['X-API-Key']=credentials.key;
    if(credentials.token)headers['X-Aether-Instance-Token']=credentials.token;
    if(options.body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(target,{method:options.method||'GET',headers,body:options.body===undefined?undefined:JSON.stringify(options.body),signal:ctrl.signal,mode:'same-origin',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
    const data=await response.json().catch(()=>null);if(signal?.aborted)throw abortError();if(!response.ok)throw failStatus(response.status,data);if(!data||data.code!==200)throw new Error('服务返回了无法识别的结果。');return data.data;
  } catch(e) { if(signal?.aborted)throw abortError();if(timed)throw new Error('请求超时，请手动重试。');if(e instanceof TypeError)throw new Error('无法连接管理服务，请检查地址和网络。');throw e; }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}
function validProfile(p) {return p&&typeof p.id==='string'&&typeof p.name==='string'&&typeof p.roleId==='string'&&typeof p.recovery==='boolean'&&Array.isArray(p.permissions)&&p.permissions.every(v=>typeof v==='string');}
function discardSamples() {outputIds.forEach(id=>{el(id).textContent='';});el('metrics-block').replaceChildren();clearCandidate();}
function setIdentity(data) {
  if(!validProfile(data))throw new Error('服务未返回有效的成员与权限。');
  const changed=!profile||profile.id!==data.id||profile.roleId!==data.roleId||profile.recovery!==data.recovery||profile.permissions.length!==data.permissions.length||profile.permissions.some(p=>!data.permissions.includes(p));
  if(changed){pageState.clear();discardSamples();}
  profile=data;candidateControls(!session||!!active);el('viewer-name').textContent=data.name;el('viewer-role').textContent=data.recovery?'恢复管理员':(typeof data.roleName==='string'&&data.roleName.trim()||roleName(data.roleId,'自定义角色'));
  for(const b of nav.querySelectorAll('[data-page]'))b.hidden=!allowedPage(b.dataset.page);
  return changed;
}
const roleName = (id,fallback=id||'—')=>({ 'super-admin':'主管理员',viewer:'只读管理员',auditor:'审计管理员' }[id]||fallback);
function firstPage() {return Object.keys(pageInfo).find(allowedPage)||'none';}
function showMenu(show) {nav.parentElement.classList.toggle('expanded',show);navToggle.setAttribute('aria-expanded',String(show));navToggle.setAttribute('aria-label',show?'收起管理导航':'展开管理导航');}
function eraseDialog() {const d=el('admin-dialog');for(const i of d.querySelectorAll('input,textarea')){if(i.type==='checkbox')i.checked=false;else i.value='';}el('dialog-body').replaceChildren();el('dialog-title').textContent='';el('dialog-error').textContent='';el('dialog-error').hidden=true;}
function endModal(answer=false,force=false) {const m=modalState;if(!m)return;if(m.saving&&!force)return;modalState=null;const d=el('admin-dialog');if(d.open)d.close();eraseDialog();m.resolve(answer);}
function modal(options) {endModal(false,true);const d=el('admin-dialog'),form=el('admin-dialog-form'),body=el('dialog-body'),cancel=el('dialog-cancel'),accept=el('dialog-accept');form.reset();eraseDialog();el('dialog-title').textContent=options.title;if(options.content)body.append(options.content);else if(options.description)body.append(node('p',options.description));cancel.textContent=options.cancelLabel||'取消';cancel.hidden=!!options.single;accept.textContent=options.confirmLabel||'保存';accept.className=options.danger?'danger':'primary';accept.disabled=false;cancel.disabled=false;
  return new Promise(resolve=>{modalState={resolve,options,saving:false};d.showModal();const focus=options.danger?cancel:body.querySelector('input:not([readonly]):not(:disabled),select:not(:disabled),textarea:not(:disabled)')||accept;focus.focus();}); }
function confirmAction(options) {return modal({ ...options, confirmLabel:options.confirmLabel||'确认' });}
el('dialog-cancel').addEventListener('click',()=>endModal());el('admin-dialog').addEventListener('cancel',e=>{e.preventDefault();endModal();});
el('admin-dialog-form').addEventListener('submit',async e=>{e.preventDefault();const m=modalState;if(!m||m.saving)return;m.saving=true;el('dialog-error').hidden=true;const accept=el('dialog-accept');accept.disabled=true;el('dialog-cancel').disabled=true;try{if(m.options.commit)await m.options.commit();if(modalState===m)endModal(true,true);}catch(err){if(modalState!==m||err.name==='AbortError')return;const n=el('dialog-error');n.hidden=false;n.textContent=err.message||'操作失败，请重试。';n.setAttribute('tabindex','-1');n.focus();}finally{if(modalState===m){m.saving=false;accept.disabled=false;el('dialog-cancel').disabled=false;}}});
function resetConsole() {if(viewController)viewController.abort();viewController=null;identityRequest=null;endModal(false,true);shell.hidden=true;document.body.classList.remove('console-open');el('disconnect').hidden=true;showMenu(false);profile=null;pageState.clear();section='overview';announce('');setupHome.append(setup);guideHome.append(guide);guide.querySelector('details').open=false;el('view-content').replaceChildren();el('page-actions').replaceChildren();discardSamples();for(const id of ['viewer-name','viewer-role','view-title','view-intro','nav-current'])el(id).textContent='';el('admin-page').hidden=true;for(const b of nav.querySelectorAll('[data-page]')){b.hidden=true;b.removeAttribute('aria-current');}}
function expired(err) {const previousKind=session?.kind;forget();if(desktopSession){notify('当前登录已失效。请返回桌面设置重新打开管理后台。');disconnect.hidden=false;disconnect.focus();return;}if(previousKind==='bearer'){kind.value='bearer';el('auth-options').open=true;updateKind();}notify(err.message);const element=err.instance?token:key;element.setAttribute('aria-invalid','true');element.focus();}
async function boundApi(path,options,ctrl) {if(!session||ctrl.signal.aborted)throw abortError();try{return await http(session,path,options,ctrl.signal);}catch(e){if(!ctrl.signal.aborted&&e.status===401)expired(e);else if(!ctrl.signal.aborted&&e.status===403&&options?.method&&options.method!=='GET')void refreshIdentity(true);throw e;}}
function panel(title,text,action) {const box=node('div',null,'panel-note');box.append(node('strong',title));if(text)box.append(node('p',text));if(action)box.append(action);return box;}
function entry(label,control) {const wrap=node('div',null,'dialog-field'),caption=node('label',label);caption.htmlFor=control.id;wrap.append(caption,control);return wrap;}
function inputControl(id,value='',type='text') {const i=node('input');i.id=id;i.type=type;i.value=value;i.autocomplete='off';return i;}
function selectControl(id,items,current) {const s=node('select');s.id=id;for(const [v,label] of items){const option=node('option',label);option.value=v;s.append(option);}if(current!==undefined)s.value=current;return s;}
function recordRow(title,detail) {const row=node('div',null,'data-row'),info=node('div',null,'record'),strong=node('strong',title),tools=node('div',null,'row-buttons');row.setAttribute('role','group');row.setAttribute('aria-label',String(title));info.append(strong);if(detail)info.append(node('small',detail));row.append(info,tools);return {row,info,tools};}
async function showPage(which,options={}) {
  if(!session||!profile)return;
  const focused=document.activeElement,restoreFocus=which===section&&!options.focus&&(el('view-content').contains(focused)||el('page-actions').contains(focused))?focused.id:'';
  if(!allowedPage(which))which=firstPage();if(viewController)viewController.abort();endModal(false,true);const ctrl=new AbortController();viewController=ctrl;section=which;showMenu(false);announce('');
  setupHome.append(setup);if(guide.parentElement!==guideHome)guideHome.append(guide);shell.hidden=false;document.body.classList.add('console-open');el('disconnect').hidden=false;
  const isOverview=which==='overview';overview.hidden=!isOverview;el('admin-page').hidden=isOverview;for(const b of nav.querySelectorAll('[data-page]')){if(b.dataset.page===which)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}el('nav-current').textContent=pageInfo[which][0];
  const body=node('div'),actions=node('div',null,'header-actions');el('page-actions').replaceChildren(actions);el('view-content').replaceChildren(body);el('view-title').textContent=pageInfo[which][0];el('view-intro').textContent=pageInfo[which][1];if(options.focus)(isOverview?el('overview-title'):el('view-title')).focus();
  const owner=session;let replacement=null,carryNotice='';
  const ctx={body,actions,api:(path,opts={})=>boundApi(path,opts,ctrl),can,signal:ctrl.signal,confirm:confirmAction,
    reload:()=>{if(ctrl.signal.aborted)return Promise.resolve();const pending=showPage(which,{notice:carryNotice});replacement=viewController;return pending;},
    announce:text=>{if(!ctrl.signal.aborted){carryNotice=text;announce(text);queueMicrotask(()=>{if(carryNotice===text)carryNotice='';});}else if(replacement&&replacement===viewController&&session===owner&&!replacement.signal.aborted)announce(text);}};
  const boundRegion=isOverview?overview:body, loading=node('p','正在读取…','view-loading'), update=el('view-refresh');
  boundRegion.setAttribute('aria-busy','true');update.disabled=true;if(!isOverview&&which!=='settings'&&which!=='none')body.append(loading);
  try {
    if(isOverview)await overviewContent(ctx,options.preloaded);
    else if(which==='none')body.append(panel('此身份没有可访问的页面','请联系管理员分配角色或权限。'));
    else {const render=pages.get(which);if(!render)throw new Error('此项暂不可用。');await render(ctx);}
    if(!ctrl.signal.aborted){if(options.notice)announce(options.notice);if(restoreFocus&&document.activeElement===document.body)el(restoreFocus)?.focus({preventScroll:true});}
  } catch(err){
    if(ctrl.signal.aborted||err.name==='AbortError')return;
    if(err.status===403){
      // A revoked permission must never leave the previous snapshot, action buttons or generated token visible.
      pageState.clear();discardSamples();actions.replaceChildren();overview.hidden=true;el('admin-page').hidden=false;notify('');
      body.replaceChildren(panel('没有访问权限',err.message,button('重新读取权限',()=>refreshIdentity())));
      if(!options.checkedRights)await refreshIdentity(true);
    }else if(isOverview){showConnection('待刷新',false);notify(err.message+(el('version').textContent?' 当前显示上次成功读取的数据。':' 请手动刷新重试。'));}
    else{actions.replaceChildren();body.replaceChildren(panel('未能载入',err.message,button('重试',()=>ctx.reload())));}
  }finally{loading.remove();if(!ctrl.signal.aborted){boundRegion.setAttribute('aria-busy','false');update.disabled=false;}}
}
function refreshIdentity(onlyIfChanged=false) {
  const ctrl=viewController;if(!session||!ctrl||ctrl.signal.aborted)return Promise.resolve();
  if(identityRequest?.ctrl===ctrl)return identityRequest.promise;
  const attempt={ctrl};identityRequest=attempt;
  const update=el('view-refresh');update.disabled=true;refresh.disabled=true;
  attempt.promise=(async()=>{try{
    const info=await boundApi('me',{},ctrl);if(ctrl.signal.aborted)return;
    const changed=setIdentity(info);if(changed||!onlyIfChanged)await showPage(allowedPage(section)?section:firstPage(),{focus:changed,checkedRights:true});
  }catch(e){if(!ctrl.signal.aborted)announce(e.message);}
  finally{if(!ctrl.signal.aborted){update.disabled=false;refresh.disabled=false;}if(identityRequest===attempt)identityRequest=null;}})();
  return attempt.promise;
}
function manualRefresh() {
  if(!session)return;
  if(section==='members'||section==='roles')pageState.delete('role-catalog');
  if(session.kind==='desktop'||(session.kind!=='bearer'&&session.key.startsWith('aether_admin_')))void refreshIdentity();else void showPage(section);
}
nav.addEventListener('click',e=>{const b=e.target.closest('button[data-page]');if(b&&nav.contains(b)&&!b.hidden)void showPage(b.dataset.page,{focus:true});});navToggle.addEventListener('click',()=>showMenu(navToggle.getAttribute('aria-expanded')!=='true'));el('view-refresh').addEventListener('click',manualRefresh);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&nav.parentElement.classList.contains('expanded')){showMenu(false);navToggle.focus();}if(!session||modalState||!(e.metaKey||e.ctrlKey)||e.altKey||e.key.toLowerCase()!=='f')return;const input=el('view-content').querySelector('input[type=search]');if(input){e.preventDefault();input.focus();input.select();}});
`