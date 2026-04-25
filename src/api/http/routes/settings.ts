import { FastifyInstance } from 'fastify'
import * as fs from 'fs/promises'
import * as path from 'path'
import { success } from '../response.js'

const ENV_PATH = path.resolve(process.cwd(), '.env')

async function readEnvFile(): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(ENV_PATH, 'utf-8')
    const lines = content.split('\n')
    const env: Record<string, string> = {}
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) {
          env[key.trim()] = rest.join('=').trim()
        }
      }
    }
    return env
  } catch (err) {
    return {}
  }
}

async function writeEnvFile(updates: Record<string, string>): Promise<void> {
  let content = ''
  try {
    content = await fs.readFile(ENV_PATH, 'utf-8')
  } catch (err) {
    // File might not exist
  }

  const lines = content.split('\n')
  const newLines: string[] = []
  const updatedKeys = new Set<string>()

  for (let line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key] = trimmed.split('=')
      const trimmedKey = key?.trim()
      if (trimmedKey && updates[trimmedKey] !== undefined) {
        newLines.push(`${trimmedKey}=${updates[trimmedKey]}`)
        updatedKeys.add(trimmedKey)
        // Also update process.env for immediate effect where possible
        process.env[trimmedKey] = updates[trimmedKey]
        continue
      }
    }
    newLines.push(line)
  }

  // Append new keys
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${value}`)
      process.env[key] = value
    }
  }

  await fs.writeFile(ENV_PATH, newLines.join('\n'), 'utf-8')
}

export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get('/settings', async (request, reply) => {
    const env = await readEnvFile()
    
    // Only return the requested settings to the frontend
    const settings = {
      LLM_PROVIDER: env.LLM_PROVIDER || process.env.LLM_PROVIDER || 'openai',
      LLM_PRIMARY_MODEL: env.LLM_PRIMARY_MODEL || process.env.LLM_PRIMARY_MODEL || 'deepseek-chat',
      OPENAI_API_KEY: env.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
      OPENAI_BASE_URL: env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      DATABASE_URL: env.DATABASE_URL || process.env.DATABASE_URL || 'file:./data/agent.db',
      MAX_ITERATIONS: parseInt(env.MAX_ITERATIONS || process.env.MAX_ITERATIONS || '50', 10),
      TOKEN_BUDGET: parseInt(env.TOKEN_BUDGET || process.env.TOKEN_BUDGET || '80000', 10),
      SKILLS_ROOT: env.SKILLS_ROOT || process.env.SKILLS_ROOT || './skills',
    }

    return reply.code(200).send(success(settings))
  })

  fastify.put<{ Body: Record<string, string | number> }>('/settings', async (request, reply) => {
    const updates = request.body
    
    // Convert all values to strings for .env
    const stringUpdates: Record<string, string> = {}
    for (const [k, v] of Object.entries(updates)) {
      stringUpdates[k] = String(v)
    }

    await writeEnvFile(stringUpdates)

    return reply.code(200).send(success({ updated: true }))
  })
}
