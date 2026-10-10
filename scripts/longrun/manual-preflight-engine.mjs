import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] ?? '')
if (!root) throw new Error('root required')
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stage = path.resolve(process.argv[3] ?? path.join(engineRoot, '../aether-code/resources/engine/win32-x64'))
const token = fs.readFileSync(path.join(root, '.instance-token'), 'utf8').trim()
const env = { ...process.env, PORT: '12499', HOST: '127.0.0.1', AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token,
  DATA_DIR: path.join(root, 'agent.db'), KNOWLEDGE_DATA_DIR: path.join(root, 'knowledge.db'), WORKSPACE_ROOT: path.join(engineRoot, 'test-projects/longrun-20261009'),
  AETHER_GLOBAL_DIR: path.join(root, 'global'), SKILLS_ROOT: path.join(root, 'skills'), MCP_CONFIG_PATH: path.join(root, 'mcp.json'), QA_LOG_DIR: path.join(root, 'logs'),
  ENABLE_LONG_TERM_MEMORY: 'true', DEFAULT_SECURITY_MODE: 'standard', DISABLE_TELEMETRY: 'true', HISTORY_BACKEND: 'jsonl', MAX_ITERATIONS: '0', LLM_FALLBACK_MODEL: '',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:12501/v1', EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', EMBEDDING_DIMENSIONS: '384', EMBEDDING_API_KEY: '',
  PRESSURE_RUNTIME_METRICS_FILE: path.join(root, 'preflight-runtime.jsonl') }
const out = fs.openSync(path.join(root, 'preflight-engine.out.log'), 'a')
const err = fs.openSync(path.join(root, 'preflight-engine.err.log'), 'a')
const child = spawn(path.join(stage, 'runtime/node.exe'), ['--import', pathToFileURL(path.join(engineRoot, 'scripts/longrun/runtime-probe.mjs')).href, path.join(stage, 'dist/main.js')], { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', out, err] })
child.unref()
fs.writeFileSync(path.join(root, 'preflight-engine.pid'), String(child.pid))
console.log(JSON.stringify({ pid: child.pid, root, stage }))
