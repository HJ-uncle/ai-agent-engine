# memory-store Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Key-Value Memory Storage

The MemoryStore SHALL provide a `remember(key, value, ctx)` method that persists a value under a given key, scoped to the current tenant and session.

#### Scenario: Store a memory entry
- **WHEN** `remember(key, value, ctx)` is called with a non-empty key
- **THEN** the store SHALL persist the value associated with `(ctx.tenantId, ctx.sessionId, key)` and overwrite any existing value for the same composite key

#### Scenario: Tenant and session isolation
- **WHEN** two calls to `remember(key, value, ctx)` are made with the same key but different `tenantId` or `sessionId`
- **THEN** the store SHALL store them as independent entries and SHALL NOT allow cross-session retrieval

---

### Requirement: Memory Retrieval

The MemoryStore SHALL provide a `recall(key, ctx)` method that returns the stored value for a given key within the current session context.

#### Scenario: Successful recall
- **WHEN** `recall(key, ctx)` is called with a key that was previously stored in the same `tenantId+sessionId`
- **THEN** the store SHALL return the stored value

#### Scenario: Key not found
- **WHEN** `recall(key, ctx)` is called with a key that does not exist in the current session
- **THEN** the store SHALL return `null` and SHALL NOT throw an error

---

### Requirement: Memory Listing

The MemoryStore SHALL provide a `list(ctx)` method that returns all keys stored in the current session.

#### Scenario: List existing keys
- **WHEN** `list(ctx)` is called after storing N entries under the same `tenantId+sessionId`
- **THEN** the method SHALL return an array of exactly N key strings

#### Scenario: List on empty session
- **WHEN** `list(ctx)` is called for a session with no stored entries
- **THEN** the method SHALL return an empty array

---

### Requirement: Memory Deletion

The MemoryStore SHALL provide a `forget(key, ctx)` method that removes a specific memory entry.

#### Scenario: Successful deletion
- **WHEN** `forget(key, ctx)` is called for an existing key
- **THEN** the store SHALL remove the entry and subsequent `recall(key, ctx)` SHALL return `null`

#### Scenario: Delete non-existent key
- **WHEN** `forget(key, ctx)` is called for a key that does not exist
- **THEN** the store SHALL complete without error (idempotent operation)

---

### Requirement: SQLite Persistence

The MemoryStore SHALL persist all memory entries to SQLite so that data survives service restarts.

#### Scenario: Data survives restart
- **WHEN** `remember(key, value, ctx)` is called and the service is subsequently restarted
- **THEN** `recall(key, ctx)` after restart SHALL return the same value that was stored before the restart

#### Scenario: Concurrent write safety
- **WHEN** multiple `remember` calls are made concurrently for the same session
- **THEN** the SQLite store SHALL serialize writes using WAL mode and SHALL NOT produce data corruption

