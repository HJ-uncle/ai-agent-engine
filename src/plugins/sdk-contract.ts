/** Shared discovery copy is short enough for one normal tool response. */
export const PLUGIN_SDK_QUICKSTART = {
  workflow: '1. plugin_get_template 获取目录与本摘要；2. plugin_scaffold 从模板生成完整工程；3. 按返回工程路径编辑并在开发模式打开。无需抄写模板、安装或发布即可预览。修改源码后刷新。发布/导出是开发完成后的独立步骤。',
  recommendedTemplate: 'session-review：当前会话消息选择 + 平台模型 AI + 插件设置 + 导出；desktop-timer：服务和页面；json-tool：纯工具。',
  sdk: '$AE.session.messages({offset?,limit?,ids?}) → {messages,total,nextOffset}; $AE.models.list() → {models}; $AE.ai.run({modelId,prompt,systemPrompt?}) → {text,model,usage}; $AE.skills.list()/get({id}); $AE.workspace.list({path?})/read({path})/write({path,content}); $AE.knowledge.list()/search({query})/get({id})/create({filename,content,knowledgeBaseId?})/update({id,content}); $AE.mcp.list()/call({serverId,tool,arguments}); $AE.settings.get()/set({value}); $AE.agents.list({cursor?,limit?})/run({modelId,task,description?,resumeRunId?})/status({runId})/cancel({runId}). modelId 优先传 models.list() 返回的配置 id，同名模型可能有多个配置。',
  aiOrAgent: '分析已提供的文本用 ai.stream(args,{onEvent,signal})：边生成边返回正文，最终Promise返回完整结果；ai.run等待完整结果，不执行工具。多步工具任务用 agents.stream(args,{onEvent,signal})，或 agents.run后台运行后查status。onEvent接收text-delta(text)、started、tool-start/tool-end、pending、complete(result)、error；signal取消，错误会拒绝Promise。页面中的pending由宿主显示用户确认/问答，答复后原stream继续；Node流在需要用户时返回blocked快照与pending，不能自行批准。agents.manage/read本身不授予业务工具；授予 engine.tools 后使用平台真实工具与子代理，按需加载；agents.tools查询实际可用性。',
  agentConfiguration: 'agents.run/stream支持identity:{name?,description?}、systemPrompt、task（本轮用户提示词）、skillIds、mcpServerIds。skills.list和mcp.list/tools发现真实ID与参数。选择Skill需skills.read，选择MCP需mcp.read与mcp.invoke；Skill全文注入、MCP工具按真实schema挂载。显式数组选择挂载范围，[]不挂载；首次省略时不自动挂载外部Skill或MCP。续跑省略配置继承原任务，可在续跑时更新配置，实际执行仍检查用户当前授权与禁用工具。系统提示词不会提高工具权限。',
  agentTools: 'agents.tools({skillIds?,mcpServerIds?,disabledTools?,customTools?})返回tools，每项含name、description、parameters、source、enabled、available、reason。engine.tools只提供文件、命令、交互与计划、搜索、子代理、Skill六类33个内置工具，首轮通常提供16个，其余按需加载。Office、浏览器、工作台、成果和管理工具不挂载；其他$AE接口供插件代码调用，不自动包装为ae_*工具。需要会话消息/设置等数据时由插件先读取并传入task。disabledTools按准确工具名禁用，执行也会拦截；用户禁用名单优先。显式mcpServerIds和customTools仍可挂载外部能力。customTools:[{name,tool}]引用本插件manifest.tools中的工具，使用真实description/inputSchema和Node入口；name冲突或不存在的tool会报错。续跑可更新名单。',
  agentWorkflow: '申请 agents.manage、agents.read、models.read 和任务需要的能力（例如 engine.tools、session.read、workspace.read、workspace.write）。const run = await $AE.agents.run({modelId,task}); 保存 run.runId；它只是接纳快照。用 await $AE.agents.status({runId:run.runId}) 查询，queued/running/cancelling 仍在进行；succeeded 后读取 result；blocked且pending非空表示等待用户，不是成功。按需 await $AE.agents.cancel({runId:run.runId})。任务结束且没有待答复请求后 await $AE.agents.run({modelId,task:"继续检查",resumeRunId:run.runId})，得到新 runId 并复用 childSessionId；工作区必须匹配，配置可更新，权限由用户当前授权决定。页面流内用户答复也会产生新runId，更新保存started事件中的ID。',
  validation: 'npm test 中的 Node 用例只验证工具输入输出，不代表页面可用。含页面的插件还需验证点击操作 → invoke 回执的 result → AI/Agent 返回 → 页面渲染 → 导出；对结果按实际结构访问字段。用固定模型回复验证页面必须标明模拟边界，不能当作真实模型验收。',
  permissions: 'manifest.permissions.requested 声明所需 capability：session.read、models.read、ai.run、skills.read、workspace.read/write、knowledge.read/write、mcp.read/invoke、settings.read/write、agents.read/manage、engine.tools、ui.dialogs/notifications/clipboard/editor/composer、events.subscribe、background.run。用户授权后调用才生效；页面上下文绑定当前会话，不能通过 args 改成别的会话。',
  boundaries: '模型密钥由平台保管；不要要求用户在插件里重填。settings 是插件自身设置。受信插件页面与宿主启动的 Node 工具共享 $AE 平台能力和 context()；invoke()/download()/navigate()/services 仅页面可用。Node 工具仍遵循 stdin/stdout 协议；独立 npm test 不注入平台 SDK。能力不可用时明确报错，不能擅自把自动读取改成手工粘贴或伪造 AI 结果。',
} as const

export const pluginSdkTypes = `/** Injected into trusted plugin pages and host-launched Node tools, not standalone npm test.
 * The global exposes shared platform methods. Page-only methods are typed on window.$AE.
 */
type Args = Record<string, unknown>;
interface AetherPluginContext {
 sessionId:string|null; workspacePath:string|null; pluginId:string; revision:number;
 messageId?:string; messageRole?:string; filePath?:string; selectionText?:string; targetId?:string;
}
interface AetherPluginSessionMessage {
 id?:string; role:'user'|'assistant'|'tool'|'system'; content:string|unknown[];
 createdAt?:number; metadata?:unknown; reasoningContent?:string;
 toolCall?:{id:string;name:string;args:Args}; toolCallId?:string; toolName?:string;
 tokens?:number; usage?:Record<string,number>|null; modelId?:string;
}
interface AetherPluginAgentRun {
 runId:string; childSessionId:string; pluginId:string; sessionId:string;
 status:'queued'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled'|'blocked'|'interrupted';
 description:string; modelId:string; createdAt:number; updatedAt:number; result:string;
 usage:{inputTokens?:number;outputTokens?:number;totalTokens?:number;cacheReadTokens?:number;cacheWriteTokens?:number;estimated?:boolean;unknown?:boolean};
 toolCount:number; pending:AetherPluginAgentPending[]; error?:{code:string;message:string};
}
interface AetherPluginAgentPending {
 requestId:string; toolCallId:string; toolName:string; args:Args; kind:'ask'|'permission'; status:'pending'|'answered';
 question?:string; options?:unknown[]; messageId?:string; output?:string; description?:string;
 displaySummary?:{source:'durable_approval';fields:Array<'args'|'question'|'description'|'options'>;originalArgsBytes?:number;omittedArgumentKeys?:number};
 sourceChangeWait?:Args;
}
interface AetherPluginAIInput {
 modelId:string; prompt?:string; messages?:Array<{role:'user'|'assistant';content:string}>; systemPrompt?:string; maxTokens?:number;
}
interface AetherPluginAIResult {
 text:string; model:string; usage:{inputTokens?:number;outputTokens?:number};
}
interface AetherPluginAgentConfiguration {
 identity?:{name?:string;description?:string}; systemPrompt?:string; skillIds?:string[]; mcpServerIds?:string[];
 disabledTools?:string[]; customTools?:Array<{name:string;tool:string}>;
}
interface AetherPluginAgentTool {
 name:string; description:string; parameters:Args; source:"engine"|"skill"|"mcp"|"plugin";
 enabled:boolean; available:boolean; reason?:string;
}
interface AetherPluginAgentInput extends AetherPluginAgentConfiguration {
 modelId:string; task:string; description?:string; resumeRunId?:string;
}
type AetherPluginStreamEvent<R=unknown> =
 | {type:'started';runId?:string;childSessionId?:string;model?:string}
 | {type:'text-delta';text:string;runId?:string}
 | {type:'tool-start'|'tool-end';toolName:string;toolCallId?:string;runId?:string;success?:boolean;durationMs?:number}
 | {type:'pending';runId:string;childSessionId:string;pending:AetherPluginAgentPending}
 | {type:'complete';result:R}
 | {type:'error';error:{code:string;message:string}};
interface AetherPluginStreamOptions<R=unknown> {
 signal?:AbortSignal; onEvent?:(event:AetherPluginStreamEvent<R>)=>void|Promise<void>;
}
interface AetherPluginSDK {
 context():Promise<AetherPluginContext>;
 call(capability:string,method:string,args?:Args):Promise<unknown>;
 models:{list():Promise<{models:Array<{id:string;modelId:string;name:string;provider:string}>}>};
 ai:{run(args:AetherPluginAIInput):Promise<AetherPluginAIResult>;stream(args:AetherPluginAIInput,options?:AetherPluginStreamOptions<AetherPluginAIResult>):Promise<AetherPluginAIResult>};
 session:{messages(args?:{offset?:number;limit?:number;ids?:string[]}):Promise<{messages:AetherPluginSessionMessage[];total:number;nextOffset:number|null;revision?:string}>};
 skills:{list():Promise<{skills:Args[]}>;get(args:{id:string}):Promise<{id:string;name:string;content:string}>};
 workspace:{list(args?:{path?:string}):Promise<{entries:Args[]}>;read(args:{path:string}):Promise<{path:string;content:string;size:number}>;write(args:{path:string;content:string}):Promise<{path:string;written:boolean}>};
 knowledge:{list():Promise<{bases:Args[]}>;search(args:{query:string;limit?:number;knowledgeBaseIds?:string[]}):Promise<{results:Args[]}>;get(args:{id:string}):Promise<unknown>;create(args:{filename:string;content:string;knowledgeBaseId?:string}):Promise<unknown>;update(args:{id:string;content:string;expectedRevision?:number}):Promise<unknown>};
 mcp:{list():Promise<{servers:Args[]}>;tools(args:{serverId:string}):Promise<{tools:Array<{name:string;description?:string;inputSchema:Args}>}>;call(args:{serverId:string;tool:string;arguments?:Args}):Promise<{output:string}>};
 settings:{get():Promise<Args>;set(args:{value:Args}):Promise<Args>};
 agents:{tools(args?:AetherPluginAgentConfiguration):Promise<{tools:AetherPluginAgentTool[]}>;list(args?:{cursor?:string;limit?:number}):Promise<{runs:AetherPluginAgentRun[];nextCursor:string|null}>;run(args:AetherPluginAgentInput):Promise<AetherPluginAgentRun>;stream(args:AetherPluginAgentInput,options?:AetherPluginStreamOptions<AetherPluginAgentRun>):Promise<AetherPluginAgentRun>;status(args:{runId:string}):Promise<AetherPluginAgentRun>;cancel(args:{runId:string}):Promise<AetherPluginAgentRun>};
}
interface AetherPluginPageSDK extends AetherPluginSDK {
 context():Promise<AetherPluginContext & {engineReady:boolean}>;
 commands:{execute(command:string,args?:Args):Promise<unknown>};
 events:{subscribe(eventName:string,listener:(event:{id:string;type:string;sessionId:string|null;payload:Args;timestamp:number;sequence:number})=>void):Promise<string>;unsubscribe(id:string):Promise<void>};
 ui:{dialog(input:{kind?:'info'|'warning'|'error'|'question';title:string;message:string;buttons?:string[]}):Promise<{response:number;canceled:boolean}>;
 notify(input:{title:string;body:string}):Promise<{shown:boolean}>;
 clipboard:{read():Promise<{text?:string}>;write(text:string):Promise<{written?:boolean}>};
 editor:{get():Promise<unknown>;replaceSelection(text:string):Promise<unknown>;reveal(input:{line?:number;column?:number}):Promise<unknown>};
 composer:{get():Promise<unknown>;set(text:string):Promise<unknown>;insert(text:string):Promise<unknown>;submit():Promise<unknown>}};
 invoke(tool:string,args?:Args):Promise<{result:unknown;artifacts:unknown[]}>;
 navigate(page:string):Promise<unknown>;
 download(input:{fileName:string;content:string;encoding?:'utf8'|'base64'}):Promise<{saved:boolean;bytes?:number}>;
 services:{get():Promise<unknown>;start(id:string,args?:Args):Promise<unknown>;stop(id:string):Promise<unknown>;refresh(id:string):Promise<unknown>;subscribe(listener:(value:unknown)=>void):()=>void};
}
interface Window { readonly $AE: AetherPluginPageSDK; }
declare const $AE: AetherPluginSDK;
`
