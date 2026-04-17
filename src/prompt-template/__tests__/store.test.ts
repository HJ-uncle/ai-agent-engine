import { vi } from 'vitest'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'

// ─── Setup in-memory DB ────────────────────────────────────────────────────────

let testDb: Client

vi.mock('../../storage/sqlite/db.js', () => ({
  getDb: () => testDb,
}))

// Import after mock is set up
const { PromptTemplateStore } = await import('../store.js')

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    description TEXT,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(tenant_id, name)
  );
`

function makeCtx(tenantId = 'tenant-1') {
  return { tenantId }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PromptTemplateStore', () => {
  beforeEach(async () => {
    testDb = createClient({ url: ':memory:' })
    await testDb.executeMultiple(CREATE_TABLE_SQL)
  })

  afterEach(() => {
    testDb.close()
  })

  // 1. render replaces {{variable}} placeholders
  it('render replaces {{variable}} placeholders', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    await store.create('greeting', 'Hello, {{name}}! You are {{age}} years old.', undefined, ctx)
    const result = await store.render('greeting', { name: 'Alice', age: '30' }, ctx)

    expect(result).toBe('Hello, Alice! You are 30 years old.')
  })

  // 2. render preserves unknown {{variable}} as-is
  it('render preserves unknown {{variable}} placeholders', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    await store.create('partial', 'Hello, {{name}}! Your score is {{score}}.', undefined, ctx)
    const result = await store.render('partial', { name: 'Bob' }, ctx)

    expect(result).toBe('Hello, Bob! Your score is {{score}}.')
  })

  // 3. render throws when template not found
  it('render throws when template is not found', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    await expect(store.render('nonexistent', {}, ctx)).rejects.toThrow(
      'Prompt template "nonexistent" not found'
    )
  })

  // 4. create then get returns the template
  it('create then get returns the created template', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    await store.create('my-template', 'Template content here', 'A description', ctx)
    const template = await store.get('my-template', ctx)

    expect(template).not.toBeNull()
    expect(template!.name).toBe('my-template')
    expect(template!.content).toBe('Template content here')
    expect(template!.description).toBe('A description')
    expect(template!.isBuiltin).toBe(false)
    expect(template!.tenantId).toBe('tenant-1')
  })

  // 5. update returns true on success
  it('update returns true on success and updates content', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    await store.create('updatable', 'Original content', undefined, ctx)
    const updated = await store.update('updatable', 'New content', ctx)

    expect(updated).toBe(true)
    const template = await store.get('updatable', ctx)
    expect(template!.content).toBe('New content')
  })

  // 6. delete custom template returns true
  it('delete returns true for a custom (non-builtin) template', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    await store.create('deletable', 'To be deleted', undefined, ctx)
    const deleted = await store.delete('deletable', ctx)

    expect(deleted).toBe(true)
    const template = await store.get('deletable', ctx)
    expect(template).toBeNull()
  })

  // 7. delete builtin template returns false
  it('delete returns false for a builtin template', async () => {
    const store = new PromptTemplateStore()
    const ctx = makeCtx()

    // Insert a builtin template directly
    await testDb.execute({
      sql: `INSERT INTO prompt_templates (tenant_id, name, content, is_builtin)
            VALUES ('default', 'system-prompt', 'Built-in content', 1)`,
      args: [],
    })

    // Trying to delete from tenant-1 should not affect 'default' builtin
    const deleted = await store.delete('system-prompt', makeCtx('default'))

    expect(deleted).toBe(false)
  })
})
