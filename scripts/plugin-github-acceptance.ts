/** Opt-in real GitHub acceptance. Uses a new directory below PLUGIN_ACCEPTANCE_ROOT, never application data. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PluginImporter } from '../src/plugins/importer.js'
import { PluginService } from '../src/plugins/service.js'
import { runPlugin } from '../src/plugins/runtime.js'

type Node = { type: string; children?: Node[]; value?: string; checked?: boolean | null }
const contains = (tree: Node, predicate: (node: Node) => boolean): boolean => predicate(tree) || Boolean(tree.children?.some(node => contains(node, predicate)))
const cases = [
  {
    repository: 'remarkjs/remark-gfm', commit: '109972e8a773bf5dac1d6d2da0776557f36971aa',
    input: { markdown: '| Name | Done |\n| --- | --- |\n| Import | yes |\n\n- [x] verified\n\n~~old~~\n' },
    check(result: { markdown: string; tree: Node }) { assert(contains(result.tree, node => node.type === 'table')); assert(contains(result.tree, node => node.type === 'listItem' && node.checked === true)); assert(contains(result.tree, node => node.type === 'delete')) },
  },
  {
    repository: 'remarkjs/remark-frontmatter', commit: '1125009e530386bc8c2ba497087f7f2a3ae99ddf',
    input: { markdown: '---\ntitle: Aether plugin acceptance\n---\n\n# Hello\n' },
    check(result: { markdown: string; tree: Node }) { assert(contains(result.tree, node => node.type === 'yaml' && node.value === 'title: Aether plugin acceptance')); assert(result.markdown.startsWith('---\n')) },
  },
  {
    repository: 'remarkjs/remark-breaks', commit: '71f4ff3ca9f08b685dccf2fdb9882d8bbaea3388',
    input: { markdown: 'alpha\nbeta\n' },
    check(result: { markdown: string; tree: Node }) { assert(contains(result.tree, node => node.type === 'break')); assert(result.markdown.includes('alpha\\\nbeta')) },
  },
]

async function main(): Promise<void> {
  const requested = process.env.PLUGIN_ACCEPTANCE_ROOT
  if (!requested || !path.isAbsolute(requested)) throw new Error('Set PLUGIN_ACCEPTANCE_ROOT to an absolute scratch-directory path')
  const base = path.resolve(requested), actualData = path.dirname(path.resolve(process.env.DATA_DIR ?? './data/agent.db'))
  const relativeData = path.relative(actualData, base)
  if (!relativeData || (!relativeData.startsWith('..') && !path.isAbsolute(relativeData))) throw new Error('Acceptance root must be outside application data')
  const directory = path.join(base, 'run-' + randomUUID()), storage = path.join(directory, 'plugin-store'), tenant = 'github-acceptance'
  await fs.mkdir(directory, { recursive: true })
  const service = new PluginService(storage), importer = new PluginImporter(service)
  const report: { status: string; startedAt: string; completedAt?: string; storage: string; results: Record<string, unknown>[]; error?: string } = { status: 'running', startedAt: new Date().toISOString(), storage, results: [] }
  const reportFile = path.join(directory, 'evidence.json')
  const save = (): Promise<void> => fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  await save()
  console.log(`Acceptance evidence: ${reportFile}`)
  try {
    for (const sample of cases) {
      console.log(`Preparing ${sample.repository}@${sample.commit}`)
      const preview = await importer.previewImport(tenant, { type: 'github', repository: sample.repository, ref: sample.commit, format: 'remark' })
      assert.equal(preview.source.resolvedCommit, sample.commit)
      assert.equal(preview.status, 'prepared')
      // Inspection must not silently enable or publish a plugin.
      assert(!(await service.list(tenant)).some(plugin => plugin.id === preview.manifest?.id))
      console.log(`Installing ${sample.repository} with lifecycle scripts disabled`)
      const draft = await importer.installImport(tenant, preview.jobId)
      assert.equal(draft.enabled, false); assert.equal(draft.publishedRevision, undefined)
      const published = await service.publish(tenant, draft.id, draft.revision)
      const snapshot = await service.snapshot(tenant, draft.id, published.publishedRevision!)
      const run = await runPlugin(snapshot, 'process_markdown', sample.input, { tenantId: tenant, timeoutMs: 30000 })
      sample.check(run.result as { markdown: string; tree: Node })
      // A newly constructed service must reload the immutable revision and installed dependencies from disk.
      const restarted = new PluginService(storage), reloaded = await restarted.get(tenant, draft.id)
      const afterRestart = await restarted.snapshot(tenant, draft.id, reloaded.publishedRevision!)
      assert.equal(afterRestart.hash, snapshot.hash)
      const restartedRun = await runPlugin(afterRestart, 'process_markdown', sample.input, { tenantId: tenant, timeoutMs: 30000 })
      sample.check(restartedRun.result as { markdown: string; tree: Node })
      assert.deepEqual(restartedRun.result, run.result)
      const lock = await fs.readFile(path.join(snapshot.directory, 'package-lock.json'))
      report.results.push({ repository: sample.repository, resolvedCommit: preview.source.resolvedCommit, source: preview.source, jobId: preview.jobId,
        pluginId: draft.id, revision: snapshot.revision, hash: snapshot.hash, dependencyLockSha256: createHash('sha256').update(lock).digest('hex'),
        vendorEntrySha256: createHash('sha256').update(await fs.readFile(path.join(snapshot.directory, 'vendor', 'index.js'))).digest('hex'),
        input: sample.input, output: run.result, durationMs: run.durationMs, assertions: 'passed', restart: { assertions: 'passed', hash: afterRestart.hash, output: restartedRun.result, durationMs: restartedRun.durationMs } })
      await save()
      console.log(`Passed ${sample.repository}: revision ${snapshot.revision}, ${snapshot.hash}`)
    }
    report.status = 'passed'; report.completedAt = new Date().toISOString(); await save()
    console.log(`All ${report.results.length} real GitHub plugin cases passed. Evidence: ${reportFile}`)
  } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.stack ?? error.message : String(error); report.completedAt = new Date().toISOString(); await save(); throw error }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
