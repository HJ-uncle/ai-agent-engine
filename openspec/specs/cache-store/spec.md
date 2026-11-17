# Cache Store Specification

## Purpose

Describe the current SQLite string cache primitive. This is not the model provider's prompt-cache implementation. Source audit: 2026-11-17.

## Requirements

### Requirement: String values and replacement

SQLiteCacheStore SHALL persist string values by key with an expiry timestamp in epoch seconds. set SHALL insert or replace the value and expiry for the same key.

#### Scenario: Existing key

- **WHEN** set is called again for an existing key
- **THEN** the stored value and TTL deadline SHALL be replaced
- **AND** the key SHALL NOT accumulate multiple versions.

### Requirement: Lazy expiration

get SHALL delete that key if expires_at is less than the current epoch second, then return its unexpired value or null.

#### Scenario: Expiry boundary

- **WHEN** expires_at equals the current epoch second
- **THEN** the current implementation SHALL still consider the entry valid.
- **WHEN** expires_at is earlier than the current second
- **THEN** get SHALL return null after lazy deletion.

A TTL of zero can remain visible during the same second. This implementation has no background expiration sweep or automatic per-tenant key prefix.

### Requirement: Explicit deletion and callers

delete SHALL remove the named key and be harmless if it is absent. Callers SHALL define namespacing and decide where caching is appropriate.

#### Scenario: LLM caching claim

- **WHEN** this primitive exists in the repository
- **THEN** documentation SHALL NOT infer that all model responses are automatically cached, that prompts have stable prefixes or that provider cache hit rates are controlled by this table.

## Source map

[SQLite cache](../../../src/storage/cache-store/sqlite-cache.ts), [interface](../../../src/storage/cache-store/types.ts). No scheduled eviction, cache-aside integration or dependency-injection behavior is promised beyond actual callers.
