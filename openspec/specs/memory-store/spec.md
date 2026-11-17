# Memory Store Specification

## Purpose

Describe persistent semantic/graph memory and request-scoped recall policy. The current product uses SQLiteMemoryManager, not the old hypothetical key/value remember(key,value) interface. Source audit: 2026-11-17.

## Requirements

### Requirement: Explicit scopes and disabled defaults

Memory SHALL separate global and session scopes within the authenticated tenant. Missing preferences SHALL default globalEnabled and sessionDefaultEnabled to false. A session override can inherit, enable or disable its session scope.

#### Scenario: No memory authorization

- **WHEN** the effective request policy contains no enabled scopes
- **THEN** recall SHALL inject no memory and memory tools SHALL NOT gain an implicit scope.
- **WHEN** both scopes are effective
- **THEN** they SHALL be ordered session then global, with writes preferring the private session scope.

ENABLE_LONG_TERM_MEMORY is a capability switch, not proof that every session has opted in.

### Requirement: Durable graph storage

Nodes, edges, settings and embeddings SHALL use the dedicated memory database next to the main database under memory/memory.db. Memory is not an in-RAM-only cache.

#### Scenario: Memory connection

- **WHEN** the memory process connection is created
- **THEN** it SHALL use the configured separate SQLite process client with bounded cache (current 2000 KiB) and mmap disabled.
- **AND** tenant/session scope SHALL remain part of reads and mutations.

### Requirement: Dynamic bounded recall

Recall SHALL evaluate the request query and authorized populated scopes. It MAY use a helper model, configured embeddings, keyword fallback and graph expansion.

#### Scenario: Skip or failure

- **WHEN** the query is an exact recognized greeting, required credentials/data are absent, or no scope is authorized
- **THEN** no recall block SHALL be generated.
- **WHEN** recall processing fails
- **THEN** it SHALL fail soft to an empty block rather than invent memory.

Current vector retrieval takes up to 10 anchors with distance 0.65; keyword fallback examines up to 50 hits and retains up to 15 anchors; graph expansion is bounded to 40 nodes/depth 2. These are retrieval settings, not quality guarantees.

### Requirement: Request-tail injection and independent extraction

Dynamic recall SHALL be included in the bounded requestContext tail, not continually rewrite the stable memory policy in the system prompt.

#### Scenario: Combined recall and references

- **WHEN** server recall and client-provided memory references are present
- **THEN** they SHALL share a budget of min(2000, floor(contextWindow × 0.08)) tokens
- **AND** framing and clipped excerpts SHALL count toward the same budget
- **AND** server recall SHALL receive priority.

Post-completion extraction is separate from read-time recall and may invoke additional model/embedding calls. No zero-overhead, fixed-cache-hit or automatic cross-session disclosure guarantee is made.

## Source map

[Settings](../../../src/storage/memory/settings.ts), [manager](../../../src/storage/memory/memory-manager.ts), [database](../../../src/storage/memory/db.ts), [policy](../../../src/middleware/memory/policy.ts), [extractor](../../../src/middleware/memory/extractor.ts), [embedding](../../../src/storage/memory/embedding.ts). Request-context implementation and regression tests are referenced in the [runtime guide](../../../docs/runtime-guide.md). No live memory/model comparison was rerun for this documentation update.
