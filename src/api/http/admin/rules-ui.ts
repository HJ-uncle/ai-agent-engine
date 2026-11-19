import { ruleMetrics } from './rules-store.js'

/** Small self-contained console view; all record values stay in text nodes. */
export const ADMIN_RULES_JS = String.raw`registerAdminPage('rules', async ({ body, actions, api, can, reload, signal, confirm, announce }) => {
  const make = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const action = (text, fn, cls = 'secondary') => { const b = make('button', text, cls); b.type = 'button'; b.onclick = async () => { if (b.disabled || signal.aborted) return; b.disabled = true; try { await fn(); } catch(e) { if (!signal.aborted) announce(e.message || '操作失败。'); } finally { b.disabled = false; } }; return b; };
  const readable=can('rules.read'), canCheck=readable&&can('metrics.read');
  const { items, metrics } = readable ? await api('rules') : {items:[],metrics:${JSON.stringify(ruleMetrics)}}; if (signal.aborted) return;
  const writable = can('rules.manage'), formSlot = make('div'), results = make('div'), pager = make('div', null, 'pager');
  const filters = make('div', null, 'filter-form'), search = make('input'), list = make('div', null, 'card'), sampleNote = make('p', null, 'hint');
  search.type = 'search'; search.placeholder = '搜索规则名称或指标'; search.setAttribute('aria-label','搜索监控规则'); filters.append(search);
  let page = 0, byId = new Map(); const size = 10;
  const field = (title, control) => { const l = make('label',title,'filter-control'); l.append(control); return l; };
  const fmt = x => new Intl.NumberFormat('zh-CN',{ maximumFractionDigits: 2 }).format(x);
  const paint = () => {
    const q = search.value.trim().toLocaleLowerCase(), shown = items.filter(r => (r.name+' '+metrics[r.metric].label).toLocaleLowerCase().includes(q));
    page = Math.min(page, Math.max(0,Math.ceil(shown.length/size)-1)); list.replaceChildren(); pager.replaceChildren();
    if (!shown.length) list.append(make('p',items.length ? '没有匹配的规则。' : '还没有监控规则。可以添加一条主机 CPU 或内存阈值规则。', 'data-row'));
    for (const r of shown.slice(page*size,(page+1)*size)) {
      const metric = metrics[r.metric], row = make('div',null,'data-row'), info=make('div'), name=make('strong',r.name), v=byId.get(r.id);
      const state = !r.enabled ? '已停用' : !v || v.revision !== r.revision ? '未检查' : ({ normal:'正常', triggered:'已达阈值', unavailable:'指标不可用', disabled:'已停用' }[v.state] || '未检查');
      info.append(name,make('p',metric.label+' ≥ '+fmt(r.threshold)+' '+metric.unit,'hint')); row.append(info);
      const tools=make('div',null,'row-buttons'); tools.append(make('span',state+(v && v.revision===r.revision && v.value != null ? ' · '+fmt(v.value)+' '+metric.unit : ''),'tag'));
      if(writable){ tools.append(action('编辑',() => edit(r)),action('删除',async()=>{ if (!await confirm({title:'删除监控规则？',description:'「'+r.name+'」将从当前实例移除。',confirmLabel:'删除',danger:true}) || signal.aborted) return; await api('rules/'+r.id+'?revision='+r.revision,{method:'DELETE'}); announce('已删除规则。'); await reload(); },'danger')); }
      row.append(tools); list.append(row);
    }
    const back=action('上一页',()=>{page--; paint();}),next=action('下一页',()=>{page++;paint();}); back.disabled=page<=0;next.disabled=(page+1)*size>=shown.length;
    if(shown.length>size) pager.append(back,make('span','第 '+(page+1)+' / '+Math.ceil(shown.length/size)+' 页','hint'),next);
  };
  const edit = r => {
    const form=make('form',null,'card rule-editor'),heading=make('h3',r?'编辑监控规则':'新建监控规则'), name=make('input'), metric=make('select'), threshold=make('input'), enabled=make('select'), error=make('p',null,'message');
    name.required=true; name.maxLength=72; name.value=r?.name || ''; threshold.type='number'; threshold.required=true;
    for(const [id,entry] of Object.entries(metrics)){const option=make('option',entry.label);option.value=id;metric.append(option);} metric.value=r?.metric||'hostCpu';
    const updateUnit=()=>{threshold.step=metric.value==='queuePending'?'1':'any'; threshold.min=metric.value==='queuePending'?'1':'0.000001';threshold.max=String(metrics[metric.value].max);}; metric.onchange=updateUnit;updateUnit();threshold.value=r?.unread?'':String(r?.threshold??80);
    for(const [id,label] of [['1','已启用'],['0','已停用']]){const o=make('option',label);o.value=id;enabled.append(o);}enabled.value=r?.enabled===false?'0':'1';
    const submit=make('button','保存','primary');submit.type='submit'; const cancel=action('取消',()=>{formSlot.replaceChildren();if(readable)search.focus();else actions.querySelector('button')?.focus();});
    const footer=make('div',null,'panel-tools');footer.append(cancel,submit); error.hidden=true;error.setAttribute('role','alert');
    if(r?.unread)form.append(make('p','无法读取已有设置。请核对标识 '+r.id+' 和版本 '+r.revision+'，并填写修改后的完整规则。','hint'));
    form.append(heading,field('规则名称',name),field('指标',metric),field('阈值（达到或超过时触发）',threshold),field('状态',enabled),error,footer);
    let saving=false;form.onsubmit=async ev=>{ev.preventDefault();if(saving||signal.aborted)return;saving=true;submit.disabled=true;cancel.disabled=true;
      try { const data={name:name.value.trim(),metric:metric.value,threshold:Number(threshold.value),enabled:enabled.value==='1'}; if(r)data.revision=r.revision;const saved=await api(r?'rules/'+r.id:'rules',{method:r?'PATCH':'POST',body:data});if(!signal.aborted){announce(!readable&&saved?'监控规则已保存。标识：'+saved.id+'，版本：'+saved.revision:'监控规则已保存。');await reload();} }
      catch(e){if(!signal.aborted){error.hidden=false;error.textContent=e.message;}}finally{saving=false;submit.disabled=false;cancel.disabled=false;}};
    formSlot.replaceChildren(form);name.focus();
  };
  if(writable) actions.append(action('新建规则',()=>edit(null),'primary'));
  if(canCheck) filters.append(action('检查当前指标',async()=>{const r=await api('rules/evaluation');if(signal.aborted)return;byId=new Map(r.items.map(i=>[i.id,i]));sampleNote.textContent='检查于 '+new Date(r.sampledAt).toLocaleTimeString('zh-CN')+' · 仅反映本次采样。';paint();}));
  sampleNote.textContent=canCheck?'点击检查时读取一次服务器指标；本页不在后台轮询或发送通知。':'检查规则是否达到阈值，需要「查看运行指标」权限。';
  const io=make('details',null,'guide'), summary=make('summary','规则备份与恢复'), note=make('p','备份只包含监控规则。恢复会补充缺少的规则，保留已有规则；遇到冲突不会写入。','hint'), backup=make('div',null,'panel-tools');
  if(readable)backup.append(action('导出 JSON',async()=>{const snapshot=await api('rules/archive');if(signal.aborted)return;const json=JSON.stringify(snapshot,null,2);const url=URL.createObjectURL(new Blob([json],{type:'application/json'})),a=make('a');a.href=url;a.download='aether-monitor-rules.json';body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);announce('已生成监控规则备份。');}));
  if(writable){const file=make('input');file.type='file';file.accept='.json,application/json';file.hidden=true;file.onchange=async()=>{const f=file.files?.[0];file.value='';if(!f||signal.aborted)return;try{if(f.size>65536)throw Error('备份文件不能超过 64 KiB。');const data=JSON.parse(await f.text());if(data?.format!=='aether.monitor-rules'||data.version!==1||!Array.isArray(data.rules)||data.rules.length>100)throw Error('文件不是有效的 Aether 监控规则备份。');if(signal.aborted||!await confirm({title:'恢复监控规则？',description:'将检查备份中的 '+data.rules.length+' 条规则，当前实例的其他规则会保留。',confirmLabel:'恢复规则'}))return;const result=await api('rules/restore',{method:'POST',body:data});if(!signal.aborted){await reload();announce('已恢复 '+result.added+' 条规则，'+result.unchanged+' 条未变化。');}}catch(e){if(!signal.aborted)announce(e instanceof SyntaxError?'文件不是有效 JSON。':e.message);}};backup.append(file,action('选择备份恢复',()=>file.click()));}
  io.append(summary,note,backup);
  if(!readable){actions.append(action('管理指定规则',()=>writeOnlyRuleTarget({api,signal,announce,reload,confirm},edit)));summary.textContent='从备份恢复';body.append(make('p','此角色不能查看已有规则。可以新建规则、恢复备份，或用已知标识和版本管理指定规则。','panel-note'),formSlot,io);return;}
  results.append(list,pager); body.append(filters,sampleNote,formSlot,results,io);search.oninput=()=>{page=0;paint();};paint();
});`

export const ADMIN_RULES_CSS = `.rule-editor{display:grid;gap:10px;padding:15px;margin:12px 0}.rule-editor .filter-control{display:grid;max-width:32rem;gap:4px;font-size:13px}.rule-editor h3{font-size:16px}.rule-editor select{width:100%;justify-self:start}.rule-editor .panel-tools{justify-content:end}#view-content>.hint{margin:8px 0}#view-content>.guide{margin:16px 0}#view-content>.guide p{margin:8px 0}.data-row .danger{color:var(--danger)}`
