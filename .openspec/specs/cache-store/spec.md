# cache-store Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Cache Write

The CacheStore SHALL provide a `set(key, value, ttlSeconds)` method that stores a value with a time-to-live expiry.

#### Scenario: Successful cache write
- **WHEN** `set(key, value, ttlSeconds)` is called with a positive `ttlSeconds`
- **THEN** the store SHALL persist the key-value pair along with an expiry timestamp equal to `now + ttlSeconds`

#### Scenario: Overwrite existing entry
- **WHEN** `set(key, value, ttlSeconds)` is called for a key that already exists (even if not yet expired)
- **THEN** the store SHALL overwrite the existing value and reset the expiry timestamp

#### Scenario: Zero or negative TTL
- **WHEN** `set(key, value, ttlSeconds)` is called with `ttlSeconds <= 0`
- **THEN** the store SHALL either reject the call with an `InvalidTTLError` or treat it as an immediate expiry (returning `null` on next `get`)

---

### Requirement: Cache Read

The CacheStore SHALL provide a `get(key)` method that returns the cached value if it exists and has not expired.

#### Scenario: Cache hit — not expired
- **WHEN** `get(key)` is called within the TTL window for a stored key
- **THEN** the method SHALL return the stored value

#### Scenario: Cache miss — expired entry
- **WHEN** `get(key)` is called after the entry's TTL has elapsed
- **THEN** the method SHALL return `null` and SHALL NOT return the stale value

#### Scenario: Cache miss — key not found
- **WHEN** `get(key)` is called for a key that was never stored
- **THEN** the method SHALL return `null` and SHALL NOT throw an error

---

### Requirement: Cache Eviction

The CacheStore SHALL remove expired entries either periodically (scheduled cleanup) or lazily (on read/write operations).

#### Scenario: Lazy eviction on read
- **WHEN** `get(key)` is called for an expired entry
- **THEN** the store MAY delete the expired entry from storage during the read operation (lazy eviction)

#### Scenario: Periodic eviction
- **WHEN** the store is configured with a `cleanupIntervalSeconds` value
- **THEN** the store SHALL run a background cleanup job at that interval to delete all expired entries from storage

---

### Requirement: CacheStore Interface Abstraction

The system SHALL define a `CacheStore` interface and provide `SQLiteCacheStore` as the default implementation, allowing alternative implementations to be substituted.

#### Scenario: Custom implementation substitution
- **WHEN** a custom `CacheStore` implementation (e.g., Redis-backed) is registered in the dependency injection container
- **THEN** the system SHALL use the custom implementation without modifying any calling code

#### Scenario: Default SQLiteCacheStore
- **WHEN** no custom `CacheStore` is configured
- **THEN** the system SHALL use `SQLiteCacheStore` as the default implementation

---

### Requirement: Cache Key Generation

Cache keys for LLM response caching SHALL be derived from a hash of the model name and prompt content.

#### Scenario: Deterministic key generation
- **WHEN** two requests use the same model and identical prompt content
- **THEN** `hash(model + prompt)` SHALL produce the same cache key, enabling cache hits

#### Scenario: Different model produces different key
- **WHEN** two requests use different model names but identical prompt content
- **THEN** `hash(model + prompt)` SHALL produce different cache keys, preventing cross-model cache collisions

#### Scenario: Different prompt produces different key
- **WHEN** two requests use the same model but different prompt content
- **THEN** the generated cache keys SHALL differ

