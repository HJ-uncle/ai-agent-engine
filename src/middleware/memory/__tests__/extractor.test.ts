import { describe, it, expect } from 'vitest'
import { formatMessages, parseMemories, buildExtractionPrompt, buildMemoryExtractionChunks } from '../extractor.js'
import { estimateRequestInput } from '../../../core/agent-loop/finalization.js'
import type { ExtractedMemory } from '../types.js'

describe('formatMessages', () => {
  it('formats user and assistant messages with role prefix', () => {
    const result = formatMessages([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你的？' },
    ])
    expect(result).toBe('[USER]: 你好\n\n[ASSISTANT]: 你好！有什么可以帮你的？')
  })

  it('filters out system and tool messages', () => {
    const result = formatMessages([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'result' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(result).toBe('[USER]: hello\n\n[ASSISTANT]: hi')
  })

  it('returns empty string for no user/assistant messages', () => {
    const result = formatMessages([
      { role: 'system', content: 'prompt' },
      { role: 'tool', content: 'output' },
    ])
    expect(result).toBe('')
  })

  it('returns empty string for empty array', () => {
    expect(formatMessages([])).toBe('')
  })
})

describe('parseMemories', () => {
  it('parses valid JSON array of memories', () => {
    const json = JSON.stringify([
      { type: 'fact', content: '用户喜欢 TypeScript', importance: 0.8, emotion: 0.5, tags: ['语言偏好'] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('fact')
    expect(result[0].content).toBe('用户喜欢 TypeScript')
    expect(result[0].importance).toBe(0.8)
    expect(result[0].emotion).toBe(0.5)
    expect(result[0].tags).toEqual(['语言偏好'])
  })

  it('parses JSON wrapped in markdown code fence', () => {
    const json = '```json\n' + JSON.stringify([
      { type: 'preference', content: '偏好简洁代码', importance: 0.9, emotion: 0.7, tags: ['代码风格'] },
    ]) + '\n```'
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('preference')
  })

  it('parses JSON wrapped in code fence without language tag', () => {
    const json = '```\n' + JSON.stringify([
      { type: 'decision', content: '选择 SQLite', importance: 0.85, emotion: 0.3, tags: ['架构'] },
    ]) + '\n```'
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseMemories('not json at all')).toEqual([])
    expect(parseMemories('{ broken: yes }')).toEqual([])
  })

  it('returns empty array for non-array JSON', () => {
    expect(parseMemories('{"type":"fact"}')).toEqual([])
    expect(parseMemories('"just a string"')).toEqual([])
    expect(parseMemories('42')).toEqual([])
  })

  it('returns empty array for empty JSON array', () => {
    expect(parseMemories('[]')).toEqual([])
  })

  it('filters out entries with invalid type', () => {
    const json = JSON.stringify([
      { type: 'invalid_type', content: 'test', importance: 0.5, emotion: 0, tags: [] },
      { type: 'fact', content: 'valid one', importance: 0.7, emotion: 0, tags: [] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('fact')
  })

  it('validates all 6 allowed types', () => {
    const types = ['fact', 'preference', 'decision', 'lesson', 'narrative', 'milestone']
    const json = JSON.stringify(types.map((t, i) => ({
      type: t, content: `memory ${i}`, importance: 0.5, emotion: 0, tags: [],
    })))
    expect(parseMemories(json)).toHaveLength(6)
  })

  it('filters out entries with empty content', () => {
    const json = JSON.stringify([
      { type: 'fact', content: '', importance: 0.5, emotion: 0, tags: [] },
      { type: 'fact', content: '  ', importance: 0.5, emotion: 0, tags: [] },
      { type: 'fact', content: 'valid', importance: 0.5, emotion: 0, tags: [] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
  })

  it('filters out entries with importance out of range', () => {
    const json = JSON.stringify([
      { type: 'fact', content: 'too high', importance: 1.5, emotion: 0, tags: [] },
      { type: 'fact', content: 'negative', importance: -0.1, emotion: 0, tags: [] },
      { type: 'fact', content: 'valid', importance: 1.0, emotion: 0, tags: [] },
      { type: 'fact', content: 'valid zero', importance: 0.0, emotion: 0, tags: [] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(2)
  })

  it('filters out entries with emotion out of range', () => {
    const json = JSON.stringify([
      { type: 'fact', content: 'too positive', importance: 0.5, emotion: 2, tags: [] },
      { type: 'fact', content: 'too negative', importance: 0.5, emotion: -1.5, tags: [] },
      { type: 'fact', content: 'valid max', importance: 0.5, emotion: 1, tags: [] },
      { type: 'fact', content: 'valid min', importance: 0.5, emotion: -1, tags: [] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(2)
  })

  it('filters out entries with non-string array tags', () => {
    const json = JSON.stringify([
      { type: 'fact', content: 'bad tags', importance: 0.5, emotion: 0, tags: [42] },
      { type: 'fact', content: 'good tags', importance: 0.5, emotion: 0, tags: ['a', 'b'] },
      { type: 'fact', content: 'no tags arr', importance: 0.5, emotion: 0, tags: 'not-array' },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
  })

  it('filters out null/non-object entries', () => {
    const json = JSON.stringify([
      null,
      'string',
      42,
      { type: 'fact', content: 'valid', importance: 0.5, emotion: 0, tags: [] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(1)
  })

  it('allows optional relatedTo field', () => {
    const json = JSON.stringify([
      { type: 'fact', content: 'A', importance: 0.5, emotion: 0, tags: [], relatedTo: 'B' },
      { type: 'fact', content: 'B', importance: 0.5, emotion: 0, tags: [] },
    ])
    const result = parseMemories(json)
    expect(result).toHaveLength(2)
    expect(result[0].relatedTo).toBe('B')
    expect(result[1].relatedTo).toBeUndefined()
  })
})

describe('buildExtractionPrompt', () => {
  it('contains the history text', () => {
    const prompt = buildExtractionPrompt('[USER]: hello\n[ASSISTANT]: hi')
    expect(prompt).toContain('[USER]: hello')
  })

  it('contains the system extraction instructions', () => {
    const prompt = buildExtractionPrompt('some history')
    expect(prompt).toContain('记忆提取助手')
    expect(prompt).toContain('fact | preference | decision | lesson | narrative | milestone')
  })

  it('contains the JSON output instruction', () => {
    const prompt = buildExtractionPrompt('history')
    expect(prompt).toContain('以 JSON 数组格式输出')
  })

  it('includes the history delimiter markers', () => {
    const prompt = buildExtractionPrompt('test history')
    expect(prompt).toContain('对话历史开始')
    expect(prompt).toContain('对话历史结束')
  })
})

describe('large-turn extraction budget', () => {
  it('preserves an entire multilingual input including late constraints across independently admitted chunks', () => {
    const original = '检查架构与错误修复，保留全部测试证据。😀\n'.repeat(3000) + 'TAIL-CONSTRAINT:账目必须支持幂等写入'
    const contextWindow = 8_000
    const { prompts, maxOutputTokens } = buildMemoryExtractionChunks([{ role: 'user', content: original }], contextWindow)
    expect(prompts.length).toBeGreaterThan(1)
    const rejoined = prompts.map(prompt => prompt.split('--- 对话历史开始 ---\n')[1].split('\n--- 对话历史结束 ---')[0].replace(/^\[USER\]: /, '')).join('')
    expect(rejoined).toBe(original)
    expect(prompts.at(-1)).toContain('TAIL-CONSTRAINT:账目必须支持幂等写入')
    for (const prompt of prompts) {
      expect(estimateRequestInput([{ role: 'user', content: prompt }], undefined, []) + maxOutputTokens).toBeLessThan(contextWindow)
      expect(prompt).not.toMatch(/\uD83D(?!\uDE00)/)
    }
  })

  it('keeps small turns together and never silently submits instructions to an undersized model', () => {
    const result = buildMemoryExtractionChunks([{ role: 'user', content: 'Prefer stable APIs.' }, { role: 'assistant', content: 'Will retain backward compatibility.' }], 100_000)
    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0]).toContain('[USER]: Prefer stable APIs.')
    expect(result.prompts[0]).toContain('[ASSISTANT]: Will retain backward compatibility.')
    expect(() => buildMemoryExtractionChunks([{ role: 'user', content: 'remember' }], 100)).toThrow(/cannot fit/)
  })
})
