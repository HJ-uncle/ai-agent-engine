import type { Message } from '../agent-context/index.js'

/** Transient runtime state belongs after durable history: changing its clock or
 * plan must not invalidate the cacheable system/history prefix. Never persist
 * this message or interpret it as a new user turn. */
export function requestContextMessage(content: string): Message & { role: 'user'; content: string } {
  return { role: 'user', content: '[Current runtime context]\n'
    + 'This is engine-provided state for the ongoing task, not a new user request. Continue the existing task under the system instructions.\n'
    + content }
}

export function requestContextMessages(messages: Message[], content?: string): Message[] {
  return content ? [...messages, requestContextMessage(content)] : [...messages]
}
