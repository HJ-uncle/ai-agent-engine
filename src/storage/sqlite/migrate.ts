import { getDb, closeDb } from './db.js'
import { up } from './migrations/001_initial.js'

const BUILTIN_TEMPLATES = [
  {
    name: 'assistant',
    content: `You are a helpful AI assistant. You have access to various tools to help complete tasks.
When using tools, always explain what you're doing and why.
Be concise but thorough in your responses.`,
    description: 'General-purpose helpful assistant',
  },
  {
    name: 'coder',
    content: `You are an expert software engineer. You write clean, efficient, and well-documented code.
You have access to file system tools to read, create, and modify code files.
Always explain your code decisions and follow best practices.`,
    description: 'Software engineering assistant',
  },
  {
    name: 'analyst',
    content: `You are a data analyst and researcher. You excel at finding patterns, summarizing information,
and providing actionable insights. Use tools to gather and process information systematically.`,
    description: 'Data analysis and research assistant',
  },
]

async function migrate() {
  console.log('Running database migrations...')
  const db = getDb()

  try {
    await up(db)
    console.log('✓ Migration 001_initial complete')

    // Seed built-in prompt templates
    for (const tpl of BUILTIN_TEMPLATES) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO prompt_templates (tenant_id, name, content, description, is_builtin)
              VALUES ('default', ?, ?, ?, 1)`,
        args: [tpl.name, tpl.content, tpl.description],
      })
    }
    console.log('✓ Built-in prompt templates seeded')

    console.log('Migration complete!')
  } finally {
    closeDb()
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
