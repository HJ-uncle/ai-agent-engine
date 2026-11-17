# Conversation History Specification

## Purpose

Define logical history, physical persistence, compression, rollback and result withdrawal in the implemented session system. Source audit: 2026-11-17.

## Requirements

### Requirement: Layered persistent storage

The default history backend SHALL be JSONL. HISTORY_BACKEND=sqlite remains an alternate implementation. DATA_DIR SHALL be interpreted as a main database file path, not as a directory.

#### Scenario: Default history write

- **WHEN** a tenant/session appends history
- **THEN** it SHALL use sessions/<tenant>/<session>.jsonl under the main database parent
- **AND** keep SQLite runtime identity, admission/coordination records and indices separate from bulk history.
- **WHEN** a large supported history payload exceeds the externalization threshold
- **THEN** it MAY be stored by content hash in compressed blobs, and restoration SHALL require those referenced blobs.

Current default physical history caching is bounded by both 64 sessions and 64 MiB. A cache is not the durable source. Child bulk payloads also use a separate gzip store adjacent to the main database; child metadata and receipts remain in SQLite.

### Requirement: Logical compression without archive deletion

Compression SHALL produce a current model-history view with a summary and retained recent messages. JSONL archival rows SHALL NOT be assumed deleted merely because the model sees fewer messages.

#### Scenario: Concurrent supplementation

- **WHEN** history changes while a summary is being generated outside the history lock
- **THEN** revision/sequence comparison SHALL reject the stale rewrite
- **AND** newly admitted inputs SHALL NOT be overwritten by that summary.

### Requirement: Transactional rollback scope and receipts

POST /conversation/rollback SHALL use a root user-message anchor and a requestKey. It SHALL freeze exact turns, attempts and file change IDs in a durable rollback journal.

#### Scenario: File conflict

- **WHEN** one target cannot be reverted or confirmed already reverted
- **THEN** rollback SHALL report historyTruncated=false
- **AND** SHALL NOT falsely present the selected history as successfully removed.

#### Scenario: Successful rollback

- **WHEN** owned producers stop and all selected file reversions are confirmed
- **THEN** the journal SHALL progress pending → files_reverted → succeeded
- **AND** remove the exact selected root/child history and revoke associated published assets.
- **WHEN** a succeeded requestKey is retried
- **THEN** its receipt SHALL NOT cancel a newer branch.

File reversion checks current hashes, later changes and canonical targets. Command observations require reviewed IDs. Only owned, unchanged, empty created directories can be removed. Arbitrary external shell effects are not transactionally reversible.

### Requirement: Distinguish truncation and asset access

POST /conversation/truncate SHALL be documented as history-only. It is not a substitute for file rollback. Published result reads SHALL enforce revoked source assets even when a retained physical copy exists.

#### Scenario: Partial source rollback

- **WHEN** a delivered source change is withdrawn
- **THEN** dependent attachments SHALL be revoked
- **AND** retained answer evidence SHALL NOT imply that withdrawn files can still be opened.

## Source map

[History factory](../../../src/storage/conversation/factory.ts), [JSONL](../../../src/storage/conversation/jsonl-history.ts), [blobs](../../../src/storage/conversation/history-blobs.ts), [rollback route](../../../src/api/http/routes/conversation.ts), [changes](../../../src/storage/changes/index.ts), [results](../../../src/storage/results/index.ts), [maintenance guide](../../../docs/operations/session-storage-maintenance.md). This audit did not operate on production sessions.
