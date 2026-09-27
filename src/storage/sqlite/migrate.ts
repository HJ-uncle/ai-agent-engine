import { getDb, closeDb } from './db.js'
import { up } from './migrations/001_initial.js'
import { up as up002 } from './migrations/002_add_message_id.js'
import { up as up003 } from './migrations/003_drop_deleted_at.js'
import { up as up004 } from './migrations/004_add_agents.js'
import { up as up005 } from './migrations/005_add_token_usage.js'
import { up as up006 } from './migrations/006_add_todos_cron.js'
import { up as up007 } from './migrations/007_add_models_management.js'
import { up as up008 } from './migrations/008_add_agent_allowed_tools.js'
import { up as up009 } from './migrations/009_add_sessions.js'
import { up as up010 } from './migrations/010_add_system_config.js'
import { up as up011 } from './migrations/011_add_security_and_perf.js'
import { up as up012 } from './migrations/012_add_message_model_id.js'
import { up as up013 } from './migrations/013_add_user_name.js'
import { up as up014 } from './migrations/014_add_model_capabilities.js'
import { up as up015 } from './migrations/015_add_metadata.js'
import { up as up016 } from './migrations/016_add_tenant_configs.js'
import { up as up017 } from './migrations/017_add_skill_imports.js'
import { up as up018 } from './migrations/018_skill_imports_scope.js'

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

    try {
      await up002(db)
      console.log('✓ Migration 002_add_message_id complete')
    } catch (err: any) {
      if (err.message && err.message.includes('duplicate column name')) {
        console.log('✓ Migration 002_add_message_id already applied')
      } else {
        throw err
      }
    }

    try {
      await up003(db)
      console.log('✓ Migration 003_drop_deleted_at complete')
    } catch (err: any) {
      console.log('✓ Migration 003_drop_deleted_at failed/skipped:', err.message)
    }

    try {
      await up004(db)
      console.log('✓ Migration 004_add_agents complete')
    } catch (err: any) {
      if (err.message && err.message.includes('duplicate column name')) {
        console.log('✓ Migration 004_add_agents already applied')
      } else {
        throw err
      }
    }

    try {
      await up005(db)
      console.log('✓ Migration 005_add_token_usage complete')
    } catch (err: any) {
      if (err.message && err.message.includes('duplicate column name')) {
        console.log('✓ Migration 005_add_token_usage already applied')
      } else {
        throw err
      }
    }

    try {
      await up006(db)
      console.log('✓ Migration 006_add_todos_cron complete')
    } catch (err: any) {
      if (err.message && err.message.includes('already exists')) {
        console.log('✓ Migration 006_add_todos_cron already applied')
      } else {
        throw err
      }
    }

    try {
      await up007(db)
      console.log('✓ Migration 007_add_models_management complete')
    } catch (err: any) {
      console.log('✓ Migration 007_add_models_management skipped:', err.message)
    }

    try {
      await up008(db)
      console.log('✓ Migration 008_add_agent_allowed_tools complete')
    } catch (err: any) {
      console.log('✓ Migration 008_add_agent_allowed_tools skipped:', err.message)
    }

    try {
      await up009(db)
      console.log('✓ Migration 009_add_sessions complete')
    } catch (err: any) {
      console.log('✓ Migration 009_add_sessions skipped:', err.message)
    }

    try {
      await up010(db)
      console.log('✓ Migration 010_add_system_config complete')
    } catch (err: any) {
      console.log('✓ Migration 010_add_system_config skipped:', err.message)
    }

    try {
      await up011(db)
      console.log('✓ Migration 011_add_security_and_perf complete')
    } catch (err: any) {
      console.log('✓ Migration 011_add_security_and_perf skipped:', err.message)
    }

    try {
      await up012(db)
      console.log('✓ Migration 012_add_message_model_id complete')
    } catch (err: any) {
      console.log('✓ Migration 012_add_message_model_id skipped:', err.message)
    }

    try {
      await up013(db)
      console.log('✓ Migration 013_add_user_name complete')
    } catch (err: any) {
      console.log('✓ Migration 013_add_user_name skipped:', err.message)
    }

    try {
      await up014(db)
      console.log('✓ Migration 014_add_model_capabilities complete')
    } catch (err: any) {
      console.log('✓ Migration 014_add_model_capabilities skipped:', err.message)
    }

    try {
      await up015(db)
      console.log('✓ Migration 015_add_metadata complete')
    } catch (err: any) {
      console.log('✓ Migration 015_add_metadata skipped:', err.message)
    }

    try {
      await up016(db)
      console.log('✓ Migration 016_add_tenant_configs complete')
    } catch (err: any) {
      console.log('✓ Migration 016_add_tenant_configs skipped:', err.message)
    }

    try {
      await up017(db)
      console.log('✓ Migration 017_add_skill_imports complete')
    } catch (err: any) {
      console.log('✓ Migration 017_add_skill_imports skipped:', err.message)
    }

    try {
      await up018(db)
      console.log('✓ Migration 018_skill_imports_scope complete')
    } catch (err: any) {
      console.log('✓ Migration 018_skill_imports_scope skipped:', err.message)
    }

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
