import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Run before test-module imports. A legacy test that forgot to configure a DB
// must never fall back to the operator's ./data/agent.db. Deliberate per-test
// fixtures may override these paths afterwards; this file must not import or
// initialize DB singletons before they do so.
const fixture = path.resolve('.e2e-tmp', 'vitest-runtime', randomUUID())
process.env.DATA_DIR = path.join(fixture, 'agent.db')
process.env.WORKSPACE_ROOT = path.join(fixture, 'workspace')
process.env.MEMORY_DB_PATH = path.join(fixture, 'memory', 'memory.db')