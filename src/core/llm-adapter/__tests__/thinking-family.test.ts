import { describe, expect, it } from 'vitest'
import { resolveThinkingFamily } from '../thinking-family.js'

const aliyun = 'https://fixture.aliyuncs.invalid/apps/anthropic'
describe('thinking family identity before gateway inference', () => {
  it.each(['deepseek', 'openai', 'anthropic', 'qwen', undefined])('keeps an explicit DeepSeek model on %s and an Aliyun gateway', provider => {
    expect(resolveThinkingFamily('deepseek-v4.1-flash-1017', provider, aliyun)).toBe('deepseek')
  })
  it.each(['qwen3.8-flash', 'qwq-32b'])('keeps the real %s model family on another vendor endpoint', model => {
    expect(resolveThinkingFamily(model, 'deepseek', 'https://api.deepseek.invalid/v1')).toBe('qwen')
  })
  it('uses an explicit vendor for an unnamed model before endpoint fallback', () => {
    expect(resolveThinkingFamily('deployment-alias', 'deepseek', aliyun)).toBe('deepseek')
    expect(resolveThinkingFamily('deployment-alias', 'qwen', 'https://api.deepseek.invalid/v1')).toBe('qwen')
  })
  it.each(['custom', 'openai', 'anthropic', undefined])('preserves Aliyun unnamed-model compatibility with %s transport', provider => {
    expect(resolveThinkingFamily('deployment-alias', provider, aliyun)).toBe('qwen')
  })
  it.each(['claude-sonnet-4', 'gpt-4o', 'o3-mini', 'kimi-k2.6', 'MiniMax-M2.5', 'glm-5.3', 'gemini-pro'])('does not reinterpret known %s models as Qwen from their host', model => {
    expect(resolveThinkingFamily(model, 'custom', aliyun)).toBeUndefined()
  })
})
