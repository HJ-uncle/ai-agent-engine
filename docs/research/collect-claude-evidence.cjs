// Read-only audit of the user-specified local distribution. No model requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const base = process.argv[2];
const out = path.join(__dirname, 'claude-2.1.266-evidence');
fs.mkdirSync(out, { recursive: true });
const exe = path.join(base, 'bin', 'claude.exe');
const bytes = fs.readFileSync(exe);
const source = bytes.toString('latin1');
const stat = fs.statSync(exe);
const manifest = { collectedAt: new Date().toISOString(), base, size: stat.size,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  scope: 'Public help, supplied tool declarations and short static string excerpts only; presence is not proof of availability.' };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const commands = [[], ['agents'], ['auth'], ['auto-mode'], ['gateway'], ['import'], ['mcp'],
  ['plugin'], ['plugin', 'marketplace'], ['project'], ['ultrareview'], ['attach'], ['logs'],
  ['respawn'], ['rm'], ['stop'], ['mcp', 'add'], ['mcp', 'serve'], ['plugin', 'install'],
  ['plugin', 'validate'], ['project', 'purge'], ['doctor'], ['install'], ['setup-token'], ['update'],
  ['auth', 'login'], ['auth', 'status'], ['mcp', 'login'], ['mcp', 'add-json'],
  ['mcp', 'add-from-claude-desktop'], ['mcp', 'get'], ['mcp', 'list'], ['mcp', 'remove'],
  ['mcp', 'reset-project-choices'], ['plugin', 'details'], ['plugin', 'eval'], ['plugin', 'init'],
  ['plugin', 'disable'], ['plugin', 'enable'], ['plugin', 'list'], ['plugin', 'prune'],
  ['plugin', 'tag'], ['plugin', 'uninstall'], ['plugin', 'update'], ['plugin', 'marketplace', 'add'],
  ['plugin', 'marketplace', 'list'], ['plugin', 'marketplace', 'remove'], ['plugin', 'marketplace', 'update'],
  ['auto-mode', 'defaults'], ['auto-mode', 'critique'], ['auto-mode', 'reset']];
const commandResults = [];
for (const command of commands) {
  const args = [...command, '--help'];
  const run = spawnSync(exe, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const name = command.length ? command.join('-') : 'main';
  fs.writeFileSync(path.join(out, `${name}-help.txt`), (run.stdout || '') + (run.stderr || ''));
  commandResults.push({ command: args, status: run.status, error: run.error?.message });
}
fs.writeFileSync(path.join(out, 'help-status.json'), JSON.stringify(commandResults, null, 2));
const declaration = fs.readFileSync(path.join(out, 'sdk-tools.d.ts'), 'utf8');
const ast = ts.createSourceFile('sdk-tools.d.ts', declaration, ts.ScriptTarget.Latest, true);
const interfaces = ast.statements.filter(x => ts.isInterfaceDeclaration(x) && x.name.text.endsWith('Input'));
const schemaInventory = interfaces.map(x => ({ name: x.name.text,
  line: ast.getLineAndCharacterOfPosition(x.getStart(ast)).line + 1,
  fields: x.members.map(m => ({name: m.name?.getText(ast), optional: !!m.questionToken,
    type: m.type?.getText(ast), description: m.jsDoc?.map(d => d.comment).join('\n')})) }));
fs.writeFileSync(path.join(out, 'tool-input-index.json'), JSON.stringify(schemaInventory, null, 2));
const patterns = ['PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','UserPromptSubmit',
  'SessionStart','SessionEnd','StopFailure','SubagentStart','SubagentStop','TeammateIdle','TaskCompleted',
  'PreCompact','PostCompact','ConfigChange','InstructionsLoaded','WorktreeCreate','WorktreeRemove',
  'ElicitationResult','Elicitation','Notification','Setup','CwdChanged','FileChanged',
  'SendMessage','TeamCreate','TeamDelete','PowerShell','ToolSearch','SendUserMessage','LSP',
  'allowedDomains','excludedCommands','enableWeakerNestedSandbox','allowManagedHooksOnly',
  'allowManagedPermissionRulesOnly','allowManagedMcpServersOnly','autoMemoryEnabled',
  'autoMemoryDirectory','enableAllProjectMcpServers','permissions','sandbox',
  'claudeMdExcludes','mcpServers','lspServers','disableAllHooks','statusLine','outputStyle',
  'attribution','cleanupPeriodDays','companyAnnouncements','disableBypassPermissionsMode',
  'managed-settings.json','CLAUDE.local.md','.claude/rules','SKILL.md','.claude-plugin',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS','CLAUDE_CODE_ENABLE_TELEMETRY','OTEL_EXPORTER',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY',
  'rewind','checkpoint','file-history','context','compact','Remote Control','computer_use',
  'chrome-devtools','voice','keybindings','fastMode','ultrathink','bridge','remote-control',
  'prompt-cache','cache_control','tool_reference','defer_loading','web_search',
  'thinking','memento','worktree.sparsePaths','sparsePaths','terminal-bench',
  'PostToolBatch','PermissionDenied','PostModelSwitch','DirectoryAdded','Stop',
  'textDocument/definition','textDocument/references','textDocument/hover','documentSymbol',
  'incomingCalls','outgoingCalls','bubblewrap','sandbox-exec','Windows sandbox',
  'forceLoginMethod','forceLoginOrgUUID','strictKnownMarketplaces','allowedMcpServers','deniedMcpServers',
  'voiceEnabled','/voice','/rewind','/context','/compact','/memory','/goal','/loop','/skills',
  '/review','/diff','/debug','/permissions','/hooks','/mcp','/plugins','/terminal-setup',
  '/resume','/fork','/export','/remote-control','/doctor','/insights','/fast','/model',
  '## Hook Events','### Hook Events','### Available Tools','apiKeyHelper','awsAuthRefresh',
  'asyncRewake','type: "prompt"','type: "agent"','type: "http"','type: "command"',
  'system-prompt-snapshot','DISABLE_NONESSENTIAL_TRAFFIC','mcpToolSearch','ENABLE_TOOL_SEARCH',
  'toolAnnotations','readOnlyHint','destructiveHint','parallelTool','isConcurrencySafe',
  'checkpointing','fileHistory','rewindFiles','claudeMd','skills-dir','memory.md'];
const excerpts = patterns.map(pattern => {
  const candidates=[]; let position=0;
  while (true) { const offset=source.indexOf(pattern,position); if(offset<0) break;
    const text=source.slice(Math.max(0,offset-160),offset+pattern.length+280);
    const nonprintable=(text.match(/[^\x09\x0a\x0d\x20-\x7e]/g)||[]).length;
    candidates.push({byteOffset:offset,text:text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g,'?'),quality:1-nonprintable/text.length});
    position=offset+pattern.length;
  }
  const hits=candidates.filter(x=>x.quality>0.97).slice(0,4);
  return {pattern,present:candidates.length>0,totalOccurrences:candidates.length,hits:hits.length?hits:candidates.slice(0,2)};
});
fs.writeFileSync(path.join(out, 'binary-excerpts.json'), JSON.stringify(excerpts,null,2));
const envNames = [...new Set(source.match(/\b(?:CLAUDE_CODE|ANTHROPIC|OTEL)_[A-Z][A-Z0-9_]{2,100}\b/g)||[])].sort();
fs.writeFileSync(path.join(out, 'binary-env-names.txt'), envNames.join('\n')+'\n');
const hookStart=source.indexOf('["PreToolUse","PostToolUse","PostToolUseFailure"');
const hooks=hookStart<0?null:{byteOffset:hookStart,excerpt:source.slice(hookStart,source.indexOf(']',hookStart)+1)};
const landmarks=['## 2.1.266','## 2.1.265','name:"voice"','name:"rewind"','name:"context"','name:"memory"','name:"sandbox"','name:"hooks"','name:"skills"','name:"goal"','name:"loop"','name:"fast"','name:"insights"','name:"keybindings"','name:"terminal-setup"'];
const landmarkExcerpts=landmarks.map(pattern=>{const offset=source.indexOf(pattern);return {pattern,byteOffset:offset,excerpt:offset<0?null:source.slice(Math.max(0,offset-80),offset+1200).replace(/[^\x09\x0a\x0d\x20-\x7e]/g,'?')};});
fs.writeFileSync(path.join(out,'binary-landmarks.json'),JSON.stringify({hooks,landmarkExcerpts},null,2));
console.log(JSON.stringify({manifest,helpCommands:commandResults.length,helpFailures:commandResults.filter(x=>x.status!==0),inputInterfaces:schemaInventory.length,binaryPatterns:excerpts.length,absentPatterns:excerpts.filter(x=>!x.present).map(x=>x.pattern),envNameCount:envNames.length},null,2));
