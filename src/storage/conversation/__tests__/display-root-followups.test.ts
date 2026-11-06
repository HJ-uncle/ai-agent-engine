import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationDisplayOptions, Message } from '../../../core/agent-context/types.js'
import { initDb, closeDb } from '../../sqlite/db.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import { SQLiteConversationHistory } from '../history.js'
import { DisplayHistoryAnchorNotFoundError } from '../display-history.js'

type DisplayMessage = Message & { conversationId?: string }
const fixture = path.dirname(process.env.DATA_DIR!)
let scope: { tenantId: string; sessionId: string }, serial = 0
beforeAll(async () => { await initDb() })
beforeEach(() => { const id = ++serial; scope = { tenantId: 'root-followups-' + id, sessionId: 'session-' + id } })
afterAll(async () => {
  await closeDb()
  if (path.dirname(path.resolve(fixture)) !== path.resolve('.e2e-tmp', 'vitest-runtime')) throw new Error('Unsafe display fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
const invocation = (root = 'root-one') => 'rootinv:' + createHash('sha256').update(JSON.stringify([root, 'attempt-one'])).digest('hex')
function user(id = 'seed', rootRunId = 'root-one', turnId = 'turn-one'): DisplayMessage {
  return { id, role: 'user', content: 'Original root request ' + id, conversationId: turnId, metadata: { rootRunId, turnId } }
}
function followup(id: string, overrides: Record<string, unknown> = {}): DisplayMessage {
  return { id, role: 'user', content: 'Complete followup body ' + id, conversationId: 'turn-one', metadata: {
    rootRunId: 'root-one', turnId: 'turn-one', collaborationDelivery: { version: 1, source: 'user-controller',
      rootRunId: 'root-one', recipientInvocationRunId: invocation(), messageId: 'mail-' + id, ...overrides } } }
}
function answer(id: string): DisplayMessage { return { id, role: 'assistant', content: 'Complete assistant body ' + id } }
async function setup(backend: 'sqlite' | 'jsonl', messages: DisplayMessage[]) {
  const history = backend === 'jsonl' ? new JSONLConversationHistory() : new SQLiteConversationHistory()
  if (backend === 'sqlite') {
    for (const [index, message] of messages.entries()) await history.append({ ...message, createdAt: 1_000_000 + index * 1000 }, scope)
  } else {
    const file = path.join(fixture, 'sessions', scope.tenantId, scope.sessionId + '.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, messages.map((message, index) => JSON.stringify({ uuid: message.id, parentUuid: null,
      type: message.role, timestamp: new Date(1_000_000 + index * 1000).toISOString(), ...scope, isSidechain: false,
      dbSeq: index + 1, conversationId: message.conversationId, payload: { ...message, createdAt: 1_000_000 + index * 1000 } })).join('\n') + '\n')
  }
  return { history, read: (options: ConversationDisplayOptions = {}) => history.getDisplayHistory(scope, options) }
}

describe.each(['sqlite', 'jsonl'] as const)('%s opt-in root followup display', backend => {
  it('counts a root with multiple followups as one complete turn and preserves every body in physical order', async () => {
    const first = { ...followup('follow-one'), content: 'Large exact human continuation '.repeat(8000) }
    const second = { ...followup('follow-two'), content: [{ type: 'text', text: 'Second complete continuation' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }
    const rootMessages = [user(), answer('before-followup'), first, { id: 'tool', role: 'tool' as const, content: 'tool evidence' }, second, answer('final')]
    const { read } = await setup(backend, [...rootMessages, user('next-root', 'root-two', 'turn-two'), answer('next-answer')])
    const grouped = await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 1 })
    expect(grouped).toMatchObject({ schemaVersion: 1, grouping: 'root', loadedTurnIds: ['seed'] })
    expect(grouped.turns.map(turn => turn.userMessageId)).toEqual(['seed', 'next-root'])
    expect(grouped.messages.map(message => message.id)).toEqual(rootMessages.map(message => message.id))
    // Preserve the backend's existing multipart representation (legacy SQLite stores it as JSON text).
    const expectedBodies = rootMessages.map(message => backend === 'sqlite' && Array.isArray(message.content) ? JSON.stringify(message.content) : message.content)
    const bodyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    expect(grouped.messages.map(message => bodyHash(message.content))).toEqual(expectedBodies.map(bodyHash))
    const latest = await read({ groupRootFollowups: true, limit: 1 })
    expect(latest.loadedTurnIds).toEqual(['next-root'])
    expect(latest.messages.map(message => message.id)).toEqual(['next-root', 'next-answer'])
    const normalAnchor = await read({ groupRootFollowups: true, anchorMessageId: 'next-root', limit: 1 })
    expect(normalAnchor.messages).toEqual(latest.messages)
    await expect(read({ groupRootFollowups: true, anchorMessageId: 'follow-one', limit: 1 })).rejects.toBeInstanceOf(DisplayHistoryAnchorNotFoundError)
  })

  it('leaves default and explicit false requests on their existing user-message navigation and paging contract', async () => {
    const { read } = await setup(backend, [user(), answer('before'), followup('one'), answer('middle'), followup('two'), answer('end')])
    const legacy = await read({ anchorMessageId: 'one', limit: 1 })
    expect(legacy).not.toHaveProperty('grouping')
    expect(legacy.turns.map(turn => turn.userMessageId)).toEqual(['seed', 'one', 'two'])
    expect(legacy.loadedTurnIds).toEqual(['one'])
    expect(legacy.messages.map(message => message.id)).toEqual(['one', 'middle'])
    expect(await read({ anchorMessageId: 'one', limit: 1, groupRootFollowups: false })).toEqual(legacy)
    const latest = await read({ groupRootFollowups: true, limit: 1 })
    expect(latest.loadedTurnIds).toEqual(['seed'])
    expect(latest.messages.map(message => message.id)).toEqual(['seed', 'before', 'one', 'middle', 'two', 'end'])
  })

  it('keeps cross-run, malformed, orphan and future-parent followups as independent visible turns', async () => {
    const orphan = followup('before-parent')
    const crossRun = followup('different-inner-root', { rootRunId: 'other-root' })
    const wrongTurn = followup('different-turn'); wrongTurn.metadata.turnId = 'other-turn'
    const wrongConversation = { ...followup('different-conversation'), conversationId: 'other-conversation' }
    const noParent = followup('missing-root', { rootRunId: 'missing-root' }); noParent.metadata.rootRunId = 'missing-root'
    const invalid = [orphan, user(), crossRun, wrongTurn, wrongConversation, noParent, followup('empty-invocation', { recipientInvocationRunId: '' }),
      followup('future-version', { version: 2 }), followup('peer-origin', { source: 'peer' })]
    const { read } = await setup(backend, [...invalid, answer('last-answer')])
    const grouped = await read({ groupRootFollowups: true, anchorMessageId: 'before-parent', limit: 10 })
    expect(grouped.turns.map(turn => turn.userMessageId)).toEqual(invalid.map(message => message.id))
    expect(grouped.messages.map(message => message.id)).toEqual([...invalid.map(message => message.id), 'last-answer'])
    const orphanPage = await read({ groupRootFollowups: true, anchorMessageId: 'missing-root', limit: 1 })
    expect(orphanPage.messages.map(message => message.id)).toEqual(['missing-root'])
  })

  it('keeps a late earlier-root followup independent after a new ordinary user and preserves segment order', async () => {
    const { read } = await setup(backend, [user(), answer('first-answer'), user('other', 'root-two', 'turn-two'), answer('other-answer'),
      followup('later-root-one'), answer('later-answer')])
    const first = await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 1 })
    expect(first.turns.map(turn => turn.userMessageId)).toEqual(['seed', 'other', 'later-root-one'])
    expect(first.messages.map(message => message.id)).toEqual(['seed', 'first-answer'])
    const other = await read({ groupRootFollowups: true, anchorMessageId: 'other', limit: 1 })
    expect(other.messages.map(message => message.id)).toEqual(['other', 'other-answer'])
    const late = await read({ groupRootFollowups: true, limit: 1 })
    expect(late.loadedTurnIds).toEqual(['later-root-one'])
    expect(late.messages.map(message => message.id)).toEqual(['later-root-one', 'later-answer'])
    const all = await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 3 })
    expect(all.messages.map(message => message.id)).toEqual(['seed', 'first-answer', 'other', 'other-answer', 'later-root-one', 'later-answer'])
  })

  it.each(['missing messageId', 'empty messageId', 'conflicting followup runId', 'conflicting seed runId'])
    ('keeps %s independent so the frontend accepts the complete page', async conflict => {
      const seed = user(), supplement = followup('follow')
      if (conflict === 'missing messageId') delete supplement.metadata.collaborationDelivery.messageId
      if (conflict === 'empty messageId') supplement.metadata.collaborationDelivery.messageId = ''
      if (conflict === 'conflicting followup runId') supplement.metadata.runId = 'different-run'
      if (conflict === 'conflicting seed runId') seed.metadata.runId = 'different-run'
      const { read } = await setup(backend, [seed, answer('before'), supplement, answer('after')])
      const page = await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 2 })
      expect(page.turns.map(turn => turn.userMessageId)).toEqual(['seed', 'follow'])
      expect(page.loadedTurnIds).toEqual(['seed', 'follow'])
      expect(page.messages.map(message => message.id)).toEqual(['seed', 'before', 'follow', 'after'])
      expect((await read({ groupRootFollowups: true, limit: 1 })).messages.map(message => message.id)).toEqual(['follow', 'after'])
    })

  it('groups matching optional runId aliases but does not cross an intervening independent followup', async () => {
    const seed = user(), valid = followup('valid')
    seed.metadata.runId = 'root-one'; valid.metadata.runId = 'root-one'
    const { read } = await setup(backend, [seed, valid, answer('valid-answer'), followup('invalid', { messageId: '' }),
      answer('invalid-answer'), followup('later-valid'), answer('later-answer')])
    const all = await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 3 })
    expect(all.turns.map(turn => turn.userMessageId)).toEqual(['seed', 'invalid', 'later-valid'])
    expect(all.messages.map(message => message.id)).toEqual(['seed', 'valid', 'valid-answer', 'invalid', 'invalid-answer', 'later-valid', 'later-answer'])
    expect((await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 1 })).messages.map(message => message.id)).toEqual(['seed', 'valid', 'valid-answer'])
  })

  it('does not choose between conflicting root anchors or hide an ordinary user without admission metadata', async () => {
    const ordinary: DisplayMessage = { id: 'ordinary', role: 'user', content: 'New ordinary user request', conversationId: 'turn-one' }
    const { read } = await setup(backend, [user(), user('duplicate-anchor'), ordinary, followup('ambiguous'), answer('end')])
    const result = await read({ groupRootFollowups: true, anchorMessageId: 'seed', limit: 10 })
    expect(result.turns.map(turn => turn.userMessageId)).toEqual(['seed', 'duplicate-anchor', 'ordinary', 'ambiguous'])
    expect(result.messages.map(message => message.id)).toEqual(['seed', 'duplicate-anchor', 'ordinary', 'ambiguous', 'end'])
  })

  it('does not attach followups to a deleted seed and uses edited metadata for grouping', async () => {
    const { history, read } = await setup(backend, [user(), followup('follow'), answer('end')])
    expect((await read({ groupRootFollowups: true, limit: 1 })).loadedTurnIds).toEqual(['seed'])
    await history.updateMessageContent('follow', scope.tenantId, 'Edited followup body', 4, {
      ...followup('follow').metadata, collaborationDelivery: { ...followup('follow').metadata.collaborationDelivery, rootRunId: 'conflict' } })
    const edited = await read({ groupRootFollowups: true, limit: 1 })
    expect(edited.loadedTurnIds).toEqual(['follow']); expect(edited.messages[0].content).toBe('Edited followup body')
    await history.updateMessageContent('follow', scope.tenantId, 'Edited followup body', 4, followup('follow').metadata)
    expect((await read({ groupRootFollowups: true, limit: 1 })).loadedTurnIds).toEqual(['seed'])
    await history.deleteMessage('seed', scope.tenantId)
    const orphan = await read({ groupRootFollowups: true, limit: 1 })
    expect(orphan.turns.map(turn => turn.userMessageId)).toEqual(['follow'])
    expect(orphan.messages.map(message => message.id)).toEqual(['follow', 'end'])
  })
})
