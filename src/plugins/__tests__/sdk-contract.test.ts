import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { pluginSdkTypes } from '../sdk-contract.js'

/** Compile a plugin consumer in memory, including the generated declaration file. */
function diagnostics(consumer: string): string[] {
  const root = path.resolve('.e2e-tmp/plugin-api-reference/engine-audit')
  const declaration = path.join(root, 'aether-sdk.d.ts')
  const usage = path.join(root, 'consumer.ts')
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  }
  const files = new Map([[declaration, pluginSdkTypes], [usage, consumer]])
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = files.get(path.resolve(fileName))
    return source === undefined ? original(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, languageVersion, true)
  }
  const program = ts.createProgram([declaration, usage], options, host)
  return ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
}

describe('generated plugin SDK consumer contract', () => {
  it('types streaming, cancellation, Agent configuration and MCP discovery', () => {
    expect(diagnostics(`
      async function review() {
        const controller = new AbortController();
        const models = await $AE.models.list();
        const canSee = models.models[0].capabilities.vision === true;
        const result = await $AE.ai.stream({modelId:'configured',messages:[{role:'user',content:[
          {type:'text',text:'检查'},
          {type:'image_url',image_url:{url:'data:image/png;base64,iVBORw==',detail:'low'}}
        ]}], thinking:false, reasoningEffort:undefined, temperature:0.2, responseFormat:'json'}, {
          signal:controller.signal,
          async onEvent(event) {
            if(event.type==='text-delta') { const text:string=event.text; }
            if(event.type==='complete') { const text:string=event.result.text; }
            if(event.type==='error') { const message:string=event.error.message; }
          }
        });
        const tokens:number|undefined = result.usage.outputTokens;
        const configuration:AetherPluginAgentConfiguration = {
          disabledTools:['execute_cmd'], customTools:[{name:'inspect_requirement',tool:'review'}]
        };
        const catalogue = await $AE.agents.tools(configuration);
        const definition:AetherPluginAgentTool = catalogue.tools[0];
        const available:boolean = definition.enabled && definition.available;
        const parameters:Record<string,unknown> = definition.parameters;
        const source:'engine'|'skill'|'mcp'|'plugin' = definition.source;
        // @ts-expect-error Tool functions are not serialized across the host boundary.
        await $AE.agents.tools({customTools:[{name:'unsafe',execute:()=>42}]});
        const run = await $AE.agents.stream({modelId:'configured',task:'检查',
          ...configuration, identity:{name:'需求分析师',description:'定位遗漏'},systemPrompt:'使用可验证证据',skillIds:[],mcpServerIds:[]}, {
          onEvent(event) {
            if(event.type==='complete') { const id:string=event.result.runId; }
            if(event.type==='pending') {
              const request:AetherPluginAgentPending = event.pending;
              const kind:'ask'|'permission' = request.kind;
              // @ts-expect-error The sealed execution action is never a plugin API field.
              const action = request.pendingAction;
            }
          }
        });
        const waiting:AetherPluginAgentPending[] = run.pending;
        // @ts-expect-error Only the user's host can answer permission requests.
        await $AE.agents.respond({runId:run.runId,output:'approved'});
        const {tools} = await $AE.mcp.tools({serverId:'test'});
        const schema:Record<string,unknown> = tools[0].inputSchema;
        // @ts-expect-error Stream is a final-result Promise, not a fake async iterator.
        for await (const event of $AE.ai.stream({modelId:'configured',prompt:'x'})) {}
        // @ts-expect-error Tools are mounted by server IDs, not arbitrary credentials.
        await $AE.agents.run({modelId:'configured',task:'x',mcpServers:[{url:'x',apiKey:'x'}]});
      }
    `)).toEqual([])
  })
  it('accepts public history projections with optional IDs and string archive revisions', () => {
    expect(diagnostics(`
      type Page = Awaited<ReturnType<typeof $AE.session.messages>>;
      const page: Page = {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Review this' }], metadata: null },
          { id: 'tool-result', role: 'tool', content: 'done', toolCallId: 'call-1', toolName: 'review',
            createdAt: 1, tokens: 2, usage: null, modelId: 'configured-model' },
          { role: 'assistant', content: '', reasoningContent: 'analysis',
            toolCall: { id: 'call-1', name: 'review', args: { mode: 'strict' } } },
        ], total: 3, nextOffset: null, revision: 'archive:1',
      };
      const empty: Page = { messages: [], total: 0, nextOffset: null };
      async function selectedMessages() {
        const current = await $AE.session.messages({ offset: 0, limit: 50 });
        const revision: string | undefined = current.revision;
        const ids = current.messages.flatMap(message => message.id ? [message.id] : []);
        return $AE.session.messages({ ids });
      }
    `)).toEqual([])
  })

  it('requires optional-field handling and rejects invented or mistyped history fields', () => {
    expect(diagnostics(`
      async function consume() {
        const page = await $AE.session.messages();
        const message = page.messages[0];
        // @ts-expect-error A historical message can have no ID.
        const requiredId: string = message.id;
        // @ts-expect-error Archive revisions are strings, not numeric plugin revisions.
        const numericRevision: number | undefined = page.revision;
        // @ts-expect-error The model-input copy is not part of the public projection.
        const privateInput = message.modelInputContent;
        // @ts-expect-error Metadata needs runtime narrowing before property access.
        const attachments = message.metadata.attachments;
      }
      // @ts-expect-error Public message roles are a finite union.
      const badRole: AetherPluginSessionMessage = { role: 'developer', content: 'x' };
      // @ts-expect-error Message content is text or content blocks.
      const badContent: AetherPluginSessionMessage = { role: 'user', content: false };
    `)).toEqual([])
  })

  it('exposes the page readiness field without advertising page-only context on Node', () => {
    expect(diagnostics(`
      async function contexts() {
        const node = await $AE.context();
        const sessionId: string | null = node.sessionId;
        // @ts-expect-error Node tools do not receive the page readiness field.
        const nodeReady = node.engineReady;
        const page = await window.$AE.context();
        const pageReady: boolean = page.engineReady;
        const selectedText: string | undefined = page.selectionText;
      }
    `)).toEqual([])
  })

  it('types the complete asynchronous Agent lifecycle for plugin consumers', () => {
    expect(diagnostics(`
      async function review() {
        const { models } = await $AE.models.list();
        const run = await $AE.agents.run({ modelId: models[0].id, task: '读取工作区并检查需求。' });
        const current = await $AE.agents.status({ runId: run.runId });
        if (current.status === 'succeeded') {
          const result: string = current.result;
          const toolCount: number = current.toolCount;
          const tokens: number | undefined = current.usage.inputTokens;
          const next = await $AE.agents.run({ modelId: models[0].id, task: '继续', resumeRunId: run.runId });
          const childSessionId: string = next.childSessionId;
        }
        const { runs } = await $AE.agents.list({ limit: 20 });
        const status: AetherPluginAgentRun['status'] = runs[0].status;
        const cancelled: AetherPluginAgentRun = await $AE.agents.cancel({ runId: run.runId });
        // @ts-expect-error There is no nested scorecard or model-defined output contract on Agent snapshots.
        const dimensions = current.scorecard.dimensions;
        // @ts-expect-error A result is text, not a list of tool calls.
        const tools: unknown[] = current.result;
        // @ts-expect-error The API accepts runId, not taskId.
        await $AE.agents.status({ taskId: run.runId });
        // @ts-expect-error Cancellation and failure also have to be handled by consumers.
        const done: 'succeeded' = current.status;
      }
    `)).toEqual([])
  })
})
