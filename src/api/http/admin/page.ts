import { ADMIN_NAV, ADMIN_VIEW, ADMIN_DIALOG } from './console-layout.js'
import { ADMIN_CONSOLE_CSS } from './console-styles.js'
import { ADMIN_CORE_JS } from './console-core.js'
import { ADMIN_ACCOUNTS_JS } from './console-accounts.js'
import { ADMIN_DIRECTORY_JS } from './console-directory.js'
import { ADMIN_WRITE_ONLY_JS } from './console-write-only.js'
import { ADMIN_OVERVIEW_JS } from './console-overview.js'
import { ADMIN_RULES_JS, ADMIN_RULES_CSS } from './rules-ui.js'

/** Shipped with the engine. The public shell contains no service or credential state. */
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">
<title>引擎管理 · Aether</title>
<link rel="icon" type="image/png" href="./icon.png"><link rel="stylesheet" href="./app.css"><script defer src="./app.js"></script>
</head><body>
<header class="bar"><div class="bar-content">
  <div class="brand"><img src="./icon.png" width="26" height="26" alt=""><span>Aether</span></div>
  <div class="bar-right"><span class="connection" id="connection"><i aria-hidden="true"></i><span id="connection-label" role="status">未连接</span></span><button type="button" id="disconnect" class="subtle" hidden>断开连接</button></div>
</div></header>
<main>
  <div class="welcome"><h1>引擎管理</h1><p class="intro">连接引擎，查看服务器状态并管理后台成员和权限。</p></div>
  <noscript><p class="message">请启用 JavaScript 后连接管理服务。</p></noscript>
  <p id="transport-note" class="message" hidden>此地址使用未加密的 HTTP。请改用 HTTPS，或在服务器本机通过 localhost 访问。</p>
  <p id="notice" class="message" role="alert" hidden></p>
  <section id="access" aria-labelledby="access-title">
    <h2 id="access-title">管理员连接</h2>
    <form id="access-form" class="card" autocomplete="off" method="post">
      <fieldset id="fields" disabled><legend class="sr-only">管理员凭据</legend>
        <div class="row"><div class="caption"><label for="admin-secret" id="secret-label">管理员密钥</label><p id="secret-help">向服务管理员获取后台密钥。默认租户恢复管理员也可以使用自己的 API Key。</p></div>
          <input id="admin-secret" type="password" required maxlength="16384" placeholder="输入后台密钥或 API Key" aria-describedby="secret-help" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="row"><div class="caption"><label for="instance-token">实例令牌 <span class="optional">可选</span></label><p id="token-help">仅在服务管理员提供了实例令牌时填写。Aether 本机用户可从「设置 → 引擎管理 → 打开管理后台」直接进入。</p></div>
          <input id="instance-token" type="password" maxlength="4096" placeholder="输入实例令牌" aria-describedby="token-help" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <details class="options" id="auth-options"><summary>其他认证方式</summary><div class="row"><label for="auth-kind">管理员认证方式</label><select id="auth-kind"><option value="api-key">后台密钥或 API Key</option><option value="bearer">Bearer / JWT</option></select></div></details>
        <div class="actions"><button id="connect" type="submit" class="primary">连接</button></div>
      </fieldset>
    </form>
  </section>
  <div id="admin-console" class="workspace-shell" hidden><h1 class="sr-only">引擎管理后台</h1>${ADMIN_NAV}<div class="detail-pane">
  <section id="overview" aria-labelledby="overview-title" hidden>
    <div class="section-head"><div><p class="eyebrow">服务器概览</p><h2 id="overview-title" tabindex="-1">服务状态</h2></div><div class="tools">
      <button type="button" id="refresh" class="icon" aria-label="刷新服务状态" title="刷新服务状态"><svg aria-hidden="true" focusable="false" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7a8 8 0 1 0 .3 9M20 3v5h-5"/></svg></button>
    </div></div>
    <dl class="card readings" id="basic-status">
      <div class="row"><dt>引擎版本</dt><dd id="version"></dd></div>
      <div class="row"><dt>实例令牌</dt><dd id="token-status"></dd></div>
      <div class="row"><dt>用户认证</dt><dd id="auth-status"></dd></div>
      <div class="row"><dt>启动时间</dt><dd id="started-at"></dd></div>
      <div class="row"><dt>运行时长</dt><dd id="uptime"></dd></div>
    </dl>
    <p id="updated" class="footnote" role="status"></p>
    <div id="candidate-home"><details class="setup" id="token-setup"><summary>配置实例令牌</summary>
      <div class="setup-body">
        <p>先在本页生成候选值，再将它保存到服务端启动设置 <code>AETHER_INSTANCE_TOKEN</code> 并重启引擎。客户端连接时填写同一个值。</p>
        <p>生成操作只在本机浏览器进行，不会查看或替换当前令牌。</p>
        <button type="button" id="generate-token" class="secondary" disabled>生成候选令牌</button>
        <div id="candidate-result" hidden><label for="candidate-token">候选令牌</label>
          <div class="candidate-output"><input id="candidate-token" type="text" readonly autocomplete="off" autocapitalize="none" spellcheck="false" dir="ltr" aria-describedby="candidate-note">
            <button type="button" id="copy-token" class="secondary" disabled aria-label="复制候选令牌">复制</button></div>
        </div>
        <p id="candidate-note" role="status" hidden></p>
      </div>
    </details></div><div id="metrics-block" aria-label="服务器与引擎指标"></div>
  </section>${ADMIN_VIEW}</div></div>
  <div id="guide-home"><aside class="guide" id="configuration-guide" aria-labelledby="guide-title"><details><summary id="guide-title">部署与恢复说明（管理员）</summary>
    <p>在服务所在电脑打开终端。以下示例假设从安装目录启动；若启动目录不同，请保留服务的工作目录和环境，改用脚本的完整路径。启动日志也会给出查看令牌的命令。</p>
    <dl class="commands"><div><dt>创建后台管理员</dt><dd><code>node dist/admin-cli.js admin create --data &lt;实际主库&gt; --out &lt;新私有文件&gt;</code></dd></div><div><dt>初始化默认租户管理员</dt><dd><code>node scripts/provision-default-admin.mjs --out &lt;私有目录中的新文件&gt;</code></dd></div>
      <div><dt>查看配置状态</dt><dd><code>node dist/admin-cli.js token status</code></dd></div>
      <div><dt>查看完整令牌</dt><dd><code>node dist/admin-cli.js token show</code></dd></div>
      <div><dt>生成候选令牌</dt><dd><code>node dist/admin-cli.js token generate</code></dd></div></dl>
    <p>建议优先创建独立后台管理员并将后台密钥写入只有自己能读取的新文件。默认租户的业务管理员 API Key 或受信任的管理员 JWT 也能用来恢复后台。服务使用自定义数据库时，在初始化命令后加上 <code>--data &lt;服务实际数据库文件&gt;</code>；脚本不会自动读取 <code>.env</code>。</p><p><code>show</code> 会在当前终端显示明文。<code>generate</code> 只生成候选值；首次未配置时不会自动创建。要启用令牌，须在服务端启动配置中设置 <code>AETHER_INSTANCE_TOKEN</code> 并重启引擎。</p>
  </details></aside></div>
${ADMIN_DIALOG}</main></body></html>`

// Both variants are inert public shells; no account or credential enters the HTML.
export const DESKTOP_ADMIN_HTML = ADMIN_HTML.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-current-session>')

export const ADMIN_CSS = `
:root{color-scheme:light dark;--bg:#f5f5f7;--panel:#fff;--panel-hover:#f0f1f3;--ink:#1d1d1f;--sub:#595b61;--line:#d8d9dd;--rule:#e7e7ea;--accent:#0061c9;--primary:#0061c9;--primary-hover:#004fA6;--good:#23794a;--warning:#9a470a;--warn-bg:#fff5e7;--focus:#0068db;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.5}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--panel:#28282b;--panel-hover:#39393d;--ink:#f4f4f6;--sub:#b5b5bd;--line:#49494e;--rule:#3a3a40;--accent:#79b7ff;--primary:#246bb4;--primary-hover:#3177be;--good:#7dc99b;--warning:#ffc385;--warn-bg:#382d23;--focus:#82bdff}}
*,*::before,*::after{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}[hidden]{display:none!important}button,input,select{font:inherit}button,select,summary{cursor:pointer}button:disabled,fieldset:disabled input,fieldset:disabled select{cursor:default;opacity:.58}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,h2[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
html[data-current-session] #access,html[data-current-session] #guide-home{display:none}.brand img{display:block;object-fit:contain}.bar{border-bottom:1px solid var(--line);background:var(--panel)}.bar-content,main{max-width:732px;margin-inline:auto;padding-inline:26px}.bar-content{height:54px;display:flex;align-items:center;justify-content:space-between;gap:12px}.brand,.connection,.tools{display:flex;align-items:center}.brand{gap:7px;font-size:16px;line-height:1;font-weight:650;letter-spacing:-.035em}.connection{gap:7px;color:var(--sub);font-size:12px}.connection i{width:7px;height:7px;background:currentColor;border-radius:50%;flex:none}.connection.online i{color:var(--good)}
main{padding-top:clamp(28px,6vh,56px);padding-bottom:48px}h1,h2,p,dl,dd{margin:0}h1{font-size:clamp(27px,6vw,36px);line-height:1.16;font-weight:650;letter-spacing:-.055em}.intro{color:var(--sub);margin:8px 0 30px}h2{font-size:15px;font-weight:650;line-height:1.5;letter-spacing:-.015em}section>h2,.section-head{margin:0 3px 9px}.section-head,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.tools{gap:6px}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:clip}.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(165px,47%);gap:10px 22px;align-items:center;min-height:52px;padding:11px 16px}.row+.row,.options,.actions{border-top:1px solid var(--rule)}.caption{min-width:0}.caption>label,.row>label,dt{font-size:14px;font-weight:550}.caption p,.optional,.footnote,.guide p{color:var(--sub);font-size:12px;line-height:1.5}.caption p{margin-top:2px}.optional{margin-left:4px;font-weight:400}.actions{justify-content:flex-end;padding:10px 16px}fieldset{margin:0;padding:0;border:0;min-inline-size:0}
input,select{min-width:0;width:100%;min-height:34px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);padding:5px 9px}input::placeholder{color:var(--sub)}input[aria-invalid=true]{border-color:var(--warning)}select{width:auto;max-width:100%;justify-self:end}button{min-height:32px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--ink);padding:4px 10px;font-size:13px;line-height:1.4;font-weight:550}.primary{min-width:74px;background:var(--primary);color:white}.primary:hover:enabled{background:var(--primary-hover)}.icon{width:32px;padding:0;display:grid;place-items:center}.subtle,.icon{color:var(--accent)}.subtle:hover:enabled,.icon:hover:enabled{background:var(--panel-hover)}
summary{width:fit-content;max-width:100%;color:var(--sub);font-size:13px;padding:9px 0}summary::marker{font-size:10px}summary:hover{color:var(--ink)}.options>summary{margin-left:16px}.options .row{padding-top:0;min-height:40px}.readings .row{min-height:45px}.readings dd{text-align:right;overflow-wrap:anywhere;font-size:14px;font-variant-numeric:tabular-nums}.footnote{margin:8px 3px 0}.guide{margin:24px 2px 0}.guide summary{font-weight:550}.guide p{margin:4px 0 10px}.commands{display:grid;gap:8px;margin:10px 0}.commands div{display:grid;grid-template-columns:7.5rem minmax(0,1fr);align-items:baseline;gap:4px 10px}.commands dt{font-size:12px;color:var(--sub);font-weight:500}.commands dd{min-width:0}code{display:inline-block;max-width:100%;padding:3px 7px;border:1px solid var(--line);border-radius:5px;color:var(--ink);background:var(--panel);font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;user-select:all;overflow-wrap:anywhere}.message{margin:0 0 16px;padding:10px 13px;border:1px solid var(--line);border-inline-start:3px solid var(--warning);border-radius:8px;background:var(--warn-bg);color:var(--ink);font-size:13px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.setup{margin-top:18px;border-top:1px solid var(--line)}.setup>summary{font-weight:550}.setup-body{display:grid;gap:8px;justify-items:start;padding:0 3px 8px}.setup-body p{font-size:13px;color:var(--sub)}.secondary{border-color:var(--line);background:var(--panel);color:var(--accent);white-space:nowrap}.secondary:hover:enabled{background:var(--panel-hover)}#candidate-result{width:100%}#candidate-result label{font-weight:550;font-size:13px}.candidate-output{display:flex;align-items:center;gap:8px;margin-top:4px}.candidate-output input{flex:1;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.candidate-output button{flex:none}#candidate-note{font-size:12px}
@media(max-width:500px){.bar-content,main{padding-inline:17px}.bar-content{height:48px}.intro{margin-bottom:22px}#access .row{grid-template-columns:minmax(0,1fr);gap:7px;padding-inline:13px}#access .options .row{grid-template-columns:minmax(0,1fr) auto;align-items:center}.readings .row{padding-inline:13px;grid-template-columns:minmax(70px,40%) minmax(0,1fr)}.actions{padding-inline:13px}.tools{gap:0}.guide{margin-top:17px}.commands div{grid-template-columns:minmax(0,1fr);gap:3px}}
${ADMIN_CONSOLE_CSS}
${ADMIN_RULES_CSS}
`

// This script runs with a same-origin-only CSP; keep all secrets local to this closure.
export const ADMIN_JS = String.raw`(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const form = el('access-form'), fields = el('fields'), key = el('admin-secret'), token = el('instance-token'), kind = el('auth-kind');
  const access = el('access'), overview = el('overview'), note = el('notice'), transport = el('transport-note');
  const connect = el('connect'), refresh = el('refresh'), disconnect = el('disconnect');
  const setup = el('token-setup'), generate = el('generate-token'), copy = el('copy-token'), candidate = el('candidate-token'), candidateResult = el('candidate-result'), candidateNote = el('candidate-note');
  const desktopSession = document.documentElement.hasAttribute('data-current-session');
  const host = location.hostname.toLowerCase();
  const safe = location.protocol === 'https:' || (location.protocol === 'http:' &&
    (host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)));
  const outputIds = ['version', 'token-status', 'auth-status', 'started-at', 'uptime', 'updated'];
  const labels = { configured: '已配置', 'not-set': '未配置', empty: '配置为空（需在服务端修正）' };
  const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  let session = null, active = null;
  function notify(text) { note.textContent = text; note.hidden = !text; }
  function showConnection(text, online) { el('connection-label').textContent = text; el('connection').classList.toggle('online', online); }
  function updateKind() {
    const bearer = kind.value === 'bearer';
    el('secret-label').textContent = bearer ? '管理员 Bearer 令牌' : '管理员密钥';
    key.placeholder = bearer ? '输入服务签发的令牌' : '输入后台密钥或 API Key';
    el('secret-help').textContent = bearer ? '使用受信方签发的默认租户（default）管理员令牌。' : '向服务管理员获取后台密钥。默认租户恢复管理员也可以使用自己的 API Key。';
  }
  function clearInvalid() { key.removeAttribute('aria-invalid'); token.removeAttribute('aria-invalid'); }
  function announceCandidate(text) { candidateNote.textContent = text; candidateNote.hidden = !text; }
  function clearCandidate() {
    candidate.value = ''; candidateResult.hidden = true; setup.open = false;
    generate.textContent = '生成候选令牌'; announceCandidate('');
  }
  function candidateControls(waiting) {
    generate.disabled = !safe || !session || !can('status.read') || waiting;
    copy.disabled = generate.disabled || !candidate.value;
  }
  function busy(value) {
    candidateControls(value);
    fields.disabled = !safe || value; refresh.disabled = value;
    connect.textContent = value ? '正在连接…' : '连接';
    form.setAttribute('aria-busy', String(value && !session)); overview.setAttribute('aria-busy', String(value && !!session));
  }
  function forget() {
    const previous = active; active = null; if (previous) previous.abort();
    clearAccess();
  }
  function clearAccess(authKind = 'api-key') {
    session = null; form.reset(); key.value = ''; token.value = ''; kind.value = authKind;
    el('auth-options').open = authKind === 'bearer'; updateKind(); clearInvalid();
    resetConsole();
    overview.hidden = true; access.hidden = desktopSession; transport.hidden = safe;
    notify(''); busy(false); showConnection('未连接', false);
  }
  function badField(field, message) { notify(message); field.setAttribute('aria-invalid', 'true'); field.focus(); }
  function duration(seconds) {
    const s = Math.floor(seconds), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h >= 24) return Math.floor(h / 24) + ' 天 ' + h % 24 + ' 小时';
    if (h) return h + ' 小时 ' + m % 60 + ' 分钟';
    return m ? m + ' 分钟' : s + ' 秒';
  }
  function valid(data) {
    return data && typeof data.version === 'string' && data.version.trim() && data.version.length <= 160 &&
      typeof data.instanceToken === 'string' && Object.hasOwn(labels, data.instanceToken) && typeof data.authenticationRequired === 'boolean' &&
      Number.isFinite(data.uptimeSeconds) && data.uptimeSeconds >= 0 && typeof data.startedAt === 'string' && Number.isFinite(Date.parse(data.startedAt));
  }
  function display(data) {
    el('version').textContent = data.version;
    el('token-status').textContent = labels[data.instanceToken];
    el('auth-status').textContent = data.authenticationRequired ? '已启用' : '未启用';
    el('started-at').textContent = date.format(new Date(data.startedAt));
    el('uptime').textContent = duration(data.uptimeSeconds);
    el('updated').textContent = '上次更新：' + clock.format(new Date()) + ' · 手动刷新';
  }
  ${ADMIN_CORE_JS}
  ${ADMIN_DIRECTORY_JS}
  ${ADMIN_ACCOUNTS_JS}
  ${ADMIN_WRITE_ONLY_JS}
  ${ADMIN_OVERVIEW_JS}
  ${ADMIN_RULES_JS}
  async function request(credentials) {
    if (!safe || active || session) return;
    const controller=new AbortController();active=controller;let focusField=null,offlineLabel='未连接';
    notify('');clearInvalid();busy(true);showConnection('正在连接',false);
    try {
      // Legacy recovery credentials retain the observable /status handshake. A dedicated member can sign in without status.read.
      let snapshot;
      if(credentials.kind!=='desktop'&&(credentials.kind==='bearer'||!credentials.key.startsWith('aether_admin_'))){
        snapshot=await http(credentials,'status',{},controller.signal);if(!valid(snapshot))throw new Error('服务返回了无法识别的状态。');
      }
      const who=await http(credentials,'me',{},controller.signal);
      if(controller.signal.aborted||active!==controller)return;
      setIdentity(who);session=credentials;key.value='';token.value='';access.hidden=true;showConnection('已连接',true);
      await showPage(firstPage(),{preloaded:snapshot,focus:true});
    } catch(e){if(controller.signal.aborted||active!==controller)return;
      if(credentials.kind==='desktop'){
        offlineLabel=e.status===403?'无后台权限':e.status===401?'需要登录':'连接失败';
        notify(e.status===403?'当前账号没有此引擎的后台权限。请联系该服务的管理员。':e.status===401?'当前登录已失效。请返回桌面设置重新登录，再打开管理后台。':e.message);
        disconnect.hidden=false;disconnect.focus();return;
      }
      focusField=e.instance?token:key;
      if(e.status===401||e.status===403)focusField.setAttribute('aria-invalid','true');
      notify(e.status===403?'需要后台成员密钥，或默认租户（default）的管理员权限。普通账号与其他租户不能查看此状态。':e.message);
    } finally{if(active===controller){active=null;busy(false);if(!session){showConnection(offlineLabel,false);focusField?.focus();}}}
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!safe || session || active) return;
    const admin = key.value.trim(), instance = token.value.trim();
    if (!admin || /[^\x21-\x7e]/.test(admin)) { badField(key, '请输入有效的管理员凭据，不能包含空格。'); return; }
    if (/[^\x20-\x7e\x80-\xff]/.test(instance)) { badField(token, '实例令牌包含无法用于连接的字符，请检查后重试。'); return; }
    void request({ key: admin, token: instance, kind: kind.value });
  });
  kind.addEventListener('change', () => { key.value = ''; clearInvalid(); notify(''); updateKind(); });
  form.addEventListener('input', () => { clearInvalid(); notify(''); });
  generate.addEventListener('click', () => {
    if (!safe || !session || !can('status.read') || active) return;
    try {
      const bytes = new Uint8Array(32); window.crypto.getRandomValues(bytes);
      candidate.value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      candidateResult.hidden = false; generate.textContent = '重新生成'; candidateControls(false);
      announceCandidate('已生成候选值，请妥善保存。');
    } catch (_) { announceCandidate('浏览器无法安全生成令牌。可在服务所在电脑运行下方的生成命令。'); }
  });
  copy.addEventListener('click', async () => {
    if (!safe || !session || !can('status.read') || active || !candidate.value) return;
    const value = candidate.value, owner = session;
    try {
      await navigator.clipboard.writeText(value);
      if (session === owner && candidate.value === value) announceCandidate('已复制候选令牌。');
    } catch (_) {
      if (session !== owner || candidate.value !== value) return;
      candidate.focus(); candidate.select();
      announceCandidate('已选中候选令牌，请使用系统复制操作。');
    }
  });
  refresh.addEventListener('click',manualRefresh);
  disconnect.addEventListener('click', () => { if(desktopSession){ window.close(); return; } forget(); key.focus(); });
  window.addEventListener('pagehide', forget);
  window.addEventListener('pageshow', event => { if (event.persisted) forget(); });
  window.addEventListener('popstate', forget);
  forget();
  if(desktopSession&&safe){disconnect.textContent='关闭后台';void request({kind:'desktop'});}
})();`
