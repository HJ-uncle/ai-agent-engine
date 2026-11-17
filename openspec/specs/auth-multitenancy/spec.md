# Authentication and tenant boundaries

Implementation review: 2026-11-17. This specification describes the current trust boundaries, not a claim that every deployment is a complete operating-system sandbox.

## Purpose

Derive user and tenant identity from validated credentials, keep instance access separate from account identity, and apply resource/role checks to each operation. See [account guide](../../../docs/account-login.md), [external providers](../../../docs/account-external-login.md), and [security architecture](../../../docs/security-architecture.md).

## Requirements

### Requirement: Instance admission and user authentication are separate

A configured AETHER_INSTANCE_TOKEN SHALL be enforced by the HTTP middleware using X-Aether-Instance-Token. Explicit probe and browser callback exceptions SHALL not make unrelated metrics, account or administration routes public.

#### Scenario: Public account entry
- WHEN a caller registers or starts an external login without an existing account
- THEN the route MAY omit user authentication, but SHALL still satisfy the configured instance gate.

### Requirement: Credential priority and validation

The middleware SHALL validate X-API-Key first when supplied. Otherwise Bearer tokens beginning with aether_session_ SHALL use account-session authentication; other Bearer tokens SHALL use JWT verification. Missing credentials on an authenticated business route SHALL fail with HTTP 401; the current common middleware uses numeric business code 40100, not the historical MISSING_API_KEY/TOKEN_EXPIRED strings.

#### Scenario: Invalid explicit credential in local anonymous mode
- WHEN AUTH_ENABLED=false and the caller submits a nonempty invalid X-API-Key or a token with the exact supported Bearer prefix
- THEN authentication SHALL reject it rather than downgrade it to anonymous default access.

#### Scenario: Anonymous local request
- WHEN AUTH_ENABLED=false and no supported credential is recognized
- THEN the identity SHALL have tenantId default and method none.
- AND account-only, instance, workspace and tool-specific checks SHALL retain their own behavior.

The current parser recognizes the exact Bearer prefix. Unsupported authorization schemes can enter anonymous mode when authentication is disabled; that mode is not an access-control boundary for remote deployment.

### Requirement: Trusted tenant and roles

API-key identity SHALL come from the stored user record. Current legacy API keys carry admin role. JWT identity SHALL be derived from verified payload; account-session roles SHALL come from trusted account records. X-Tenant-ID, profile userData and external identity display fields SHALL not grant tenant or administrator authority.

#### Scenario: Caller supplies another tenant
- WHEN an otherwise valid caller supplies a different tenant ID in headers or data
- THEN handlers SHALL authorize resources against the authenticated tenant, rather than treating caller data as authority.

### Requirement: Durable, revocable account sessions

Registration SHALL create a separate account/tenant without silently migrating anonymous default data. Recovery credentials or valid legacy API keys SHALL be exchanged through account login. Access tokens SHALL last 15 minutes within a fixed 30-day session, with atomic refresh rotation, bounded idempotent retries and replay revocation.

#### Scenario: Sensitive operation after recent-auth window
- WHEN a valid account session is older than the ten-minute real-authentication window
- THEN recovery rotation and identity binding/unbinding SHALL require reauthentication.
- AND token refresh SHALL not reset authenticatedAt.

#### Scenario: Reauthenticate current account
- WHEN the current account proves its own recovery credential or already-bound external identity
- THEN only this session's authenticatedAt SHALL update.
- AND its user, tenant, token pair and total session lifetime SHALL not be replaced.

### Requirement: External identity verification

OIDC, OAuth2 and platform-credential adapters SHALL validate against administrator-configured endpoints. Identity SHALL use the exact providerId/issuer/subject tuple. Client-supplied subject or email SHALL not establish account ownership.

#### Scenario: Link an identity
- WHEN a recently authenticated account links a verified external identity
- THEN the original internal user and tenant SHALL remain.
- AND an identity owned by another account SHALL be rejected instead of merged by email.

#### Scenario: Browser reauthentication receipt
- WHEN a reauth flow is polled
- THEN the initiating account session SHALL still be valid and SHALL be the session claiming the result.
- AND the result SHALL be AccountUser, not a new login token pair.

### Requirement: Resource and execution boundaries

Storage operations SHALL apply tenant scoping; resource handlers SHALL verify workspace ownership and path identity. Tool approval mode SHALL not override cross-tenant authorization. Host execution SHALL not be described as isolation; the optional Docker backend requires separate real-environment acceptance.

#### Scenario: Shared host path
- WHEN a user requests a path outside their authorized workspace
- THEN knowing the path or choosing full-access SHALL not grant access.

## Implementation evidence

- [HTTP gate](../../../src/api/http/middleware.ts)
- [Authentication priority](../../../src/auth/middleware.ts)
- [Account lifecycle](../../../src/auth/accounts.ts)
- [Account HTTP](../../../src/api/http/routes/accounts.ts)
- [External flow and polling](../../../src/api/http/routes/account-external.ts)
- [Workspace manager](../../../src/workspace/manager.ts)
