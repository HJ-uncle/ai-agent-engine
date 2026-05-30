# conversation-history Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Message Appending

The ConversationHistory SHALL provide an `append(message, ctx)` method that stores a message in the conversation history scoped to the current tenant and session.

#### Scenario: Successful message append
- **WHEN** `append(message, ctx)` is called with a valid message object containing `role` and `content`
- **THEN** the store SHALL persist the message with a monotonically increasing sequence number under `(ctx.tenantId, ctx.sessionId)`

#### Scenario: Tenant and session isolation
- **WHEN** two sessions with different `tenantId` or `sessionId` append messages with the same content
- **THEN** each session's history SHALL be independent and `getHistory(ctx)` for one SHALL NOT include messages from the other

---

### Requirement: History Retrieval

The ConversationHistory SHALL provide a `getHistory(ctx)` method that returns all messages for the current session in chronological order.

#### Scenario: Return messages in order
- **WHEN** `getHistory(ctx)` is called after appending N messages
- **THEN** the method SHALL return an array of N messages in the order they were appended

#### Scenario: Empty history
- **WHEN** `getHistory(ctx)` is called for a session with no messages
- **THEN** the method SHALL return an empty array

---

### Requirement: Sliding Window Truncation

When the total token count of the conversation history exceeds `maxTokens`, the ConversationHistory SHALL retain the most recent messages and truncate earlier ones.

#### Scenario: Truncation triggered
- **WHEN** appending a new message causes the total history token count to exceed `maxTokens`
- **THEN** the store SHALL remove the oldest messages (excluding the system prompt) until the total token count is at or below `maxTokens`

#### Scenario: System prompt preserved
- **WHEN** truncation is triggered and a system prompt message exists at index 0
- **THEN** the system prompt SHALL NOT be removed regardless of the token budget

#### Scenario: Single message exceeds maxTokens
- **WHEN** a single user message exceeds `maxTokens` on its own
- **THEN** the store SHALL retain at minimum the last user message and SHALL NOT produce an empty history

---

### Requirement: Summary Compression

The ConversationHistory SHALL provide a `summarize(ctx)` method that compresses earlier messages into a LLM-generated summary, replacing them in the history.

#### Scenario: Successful summarization
- **WHEN** `summarize(ctx)` is called with N messages in history
- **THEN** the system SHALL call the LLM to generate a summary of the earliest M messages, replace those M messages with a single summary message, and retain the most recent messages unchanged

#### Scenario: Summary message format
- **WHEN** a summary is generated
- **THEN** the summary message SHALL have `role: "system"` and `content` beginning with `"[Summary]:"` followed by the generated text

#### Scenario: History too short to summarize
- **WHEN** `summarize(ctx)` is called with fewer than 3 messages
- **THEN** the method SHALL return without modification and SHALL NOT call the LLM

---

### Requirement: History Clearing

The ConversationHistory SHALL provide a `clear(ctx)` method that removes all messages for the current session.

#### Scenario: Successful clear
- **WHEN** `clear(ctx)` is called
- **THEN** all messages for the current `(tenantId, sessionId)` SHALL be deleted and subsequent `getHistory(ctx)` SHALL return an empty array

#### Scenario: Clear idempotency
- **WHEN** `clear(ctx)` is called on a session that already has no messages
- **THEN** the method SHALL complete without error

