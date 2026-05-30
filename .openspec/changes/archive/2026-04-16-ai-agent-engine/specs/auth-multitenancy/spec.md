## ADDED Requirements

### Requirement: API Key Authentication

The system SHALL support API Key authentication via the `X-API-Key` request header. The server SHALL validate the key and reject invalid or missing keys.

#### Scenario: Valid API key accepted
- **WHEN** an HTTP request includes a valid `X-API-Key` header matching a stored key
- **THEN** the authentication middleware SHALL allow the request and populate `ctx.tenantId` from the key's associated tenant record

#### Scenario: Missing API key rejected
- **WHEN** an HTTP request does not include the `X-API-Key` header and API Key authentication is enabled
- **THEN** the middleware SHALL return HTTP 401 with error code `MISSING_API_KEY`

#### Scenario: Invalid API key rejected
- **WHEN** an HTTP request includes an `X-API-Key` header with a value that does not match any stored key
- **THEN** the middleware SHALL return HTTP 401 with error code `INVALID_API_KEY`

---

### Requirement: JWT Authentication

The system SHALL support JWT Bearer token authentication. The server SHALL validate the token signature and expiry before granting access.

#### Scenario: Valid JWT accepted
- **WHEN** an HTTP request includes `Authorization: Bearer <token>` with a token whose signature is valid and `exp` claim is in the future
- **THEN** the middleware SHALL allow the request and extract `tenantId` from the JWT claims

#### Scenario: Expired JWT rejected
- **WHEN** an HTTP request includes a JWT whose `exp` claim is in the past
- **THEN** the middleware SHALL return HTTP 401 with error code `TOKEN_EXPIRED`

#### Scenario: Invalid JWT signature rejected
- **WHEN** an HTTP request includes a JWT with an invalid or tampered signature
- **THEN** the middleware SHALL return HTTP 401 with error code `INVALID_TOKEN`

---

### Requirement: Data Isolation by Tenant

All storage operations (MemoryStore, ConversationHistory, KnowledgeBase, etc.) SHALL automatically scope queries and writes to the authenticated `tenantId`.

#### Scenario: Tenant scoped write
- **WHEN** an authenticated request with `tenantId = "A"` writes data to any store
- **THEN** the data SHALL be stored with `tenantId = "A"` and SHALL NOT be visible to queries from `tenantId = "B"`

#### Scenario: Cross-tenant access prevented at middleware level
- **WHEN** a request attempts to supply a different `tenantId` in the request body than the one derived from the authenticated credential
- **THEN** the middleware SHALL override the request-supplied `tenantId` with the credential-derived value and log the discrepancy

---

### Requirement: P0 Compatibility Mode

In P0 (initial phase), the system SHALL provide a default `tenantId = "default"` and SHALL allow authentication middleware to be disabled via configuration, enabling zero-auth local development.

#### Scenario: Auth middleware disabled
- **WHEN** the configuration sets `auth.enabled: false`
- **THEN** the middleware SHALL skip all authentication checks and populate `ctx.tenantId = "default"` for every request

#### Scenario: Default tenant in P0
- **WHEN** `auth.enabled: false` and a request arrives without any credential headers
- **THEN** the request SHALL be processed as if `tenantId = "default"` with full access, and no 401 SHALL be returned
