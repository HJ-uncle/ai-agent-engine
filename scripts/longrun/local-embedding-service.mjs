// Standalone test service, with real cached multilingual ONNX weights. No chat credentials.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeRoot = path.join(engineRoot, '.tmp/local-embedding-runtime')
const require = createRequire(path.join(runtimeRoot, 'package.json'))
const imported = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href)
const { pipeline, env } = imported.default ?? imported
env.cacheDir = path.join(runtimeRoot, 'model-cache')
const model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
fs.mkdirSync(env.cacheDir, { recursive: true })
const startedAt = new Date().toISOString()
env.allowRemoteModels = process.argv.includes('--prepare')
const extractor = await pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
const embed = async input => (await extractor(input, { pooling: 'mean', normalize: true })).tolist()
const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0)
const texts = ['用户决定结算金额全部使用整数分，禁止浮点货币。', 'Settlement money must be stored in integer cents instead of floating point.', 'The task board uses dark mode and blue icons.']
const proof = await embed(texts)
const semantic = { at: new Date().toISOString(), startedAt, model, dimensions: proof[0]?.length, sameConceptCrossLanguage: cosine(proof[0], proof[1]), unrelatedConcept: cosine(proof[0], proof[2]), finite: proof.every(vector => vector.length === 384 && vector.every(Number.isFinite)), backend: 'real multilingual ONNX inference; no fabricated vectors' }
semantic.passed = semantic.finite && semantic.sameConceptCrossLanguage > semantic.unrelatedConcept + 0.1
fs.writeFileSync(path.join(runtimeRoot, 'semantic-preflight.json'), JSON.stringify(semantic, null, 2) + '\n')
console.log(JSON.stringify(semantic))
if (!semantic.passed) throw new Error('Local semantic embedding preflight failed')
if (process.argv.includes('--prepare')) process.exit(0)
env.allowRemoteModels = false // Every subsequent request/restart uses retained model weights.
let queue = Promise.resolve(), requests = 0, errors = 0
const server = http.createServer(async (request, response) => {
  const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  if (request.method === 'GET' && request.url === '/health') return json(200, { ok: true, model, dimensions: 384, requests, errors })
  if (request.method !== 'POST' || request.url !== '/v1/embeddings') return json(404, { error: { message: 'Unknown route' } })
  try {
    let text = ''
    for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Embedding request too large') }
    const body = JSON.parse(text), input = Array.isArray(body.input) ? body.input : [body.input]
    if (body.model !== model || !input.length || input.length > 32 || input.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid model/input batch')
    const work = queue.then(() => embed(input)); queue = work.then(() => undefined, () => undefined)
    const vectors = await work; requests++
    json(200, { object: 'list', model, data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })), usage: { prompt_tokens: 0, total_tokens: 0 } })
  } catch (error) { errors++; json(400, { error: { message: error.message } }) }
})
const port = Number(process.env.CONTINUATION_EMBEDDING_PORT || 12501)
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port, model, dimensions: 384, offlineAfterPreparation: true })))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
