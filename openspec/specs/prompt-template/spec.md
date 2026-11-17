# Prompt Template Specification

## Purpose

Describe the implemented tenant-scoped SQLite template store. Source audit: 2026-11-17.

## Requirements

### Requirement: Tenant lookup with built-in fallback

PromptTemplateStore SHALL look up a tenant template and allow default-tenant built-in fallback by name. list SHALL return the caller's records plus shared built-ins.

#### Scenario: Tenant override

- **WHEN** a tenant-specific non-built-in template exists for a shared name
- **THEN** lookup SHALL prefer that tenant record.
- **WHEN** no eligible record exists
- **THEN** get SHALL return null.

### Requirement: Single-pass placeholder substitution

render SHALL replace occurrences matching {{word}} using provided string variables. Missing variables SHALL remain unchanged.

#### Scenario: Missing variable

- **WHEN** a template contains {{missing}} and no value is supplied
- **THEN** the rendered result SHALL preserve {{missing}}
- **AND** SHALL NOT claim strictMode or MissingVariableError behavior.

#### Scenario: Missing template

- **WHEN** render cannot find the named template
- **THEN** it SHALL throw the implementation's ordinary Error indicating the template was not found.

Inserted variable text is not recursively rendered. This store performs substitution, not policy validation, escaping or model authorization.

### Requirement: Protected built-ins and database constraints

create SHALL insert a tenant non-built-in row and rely on database uniqueness. update/delete SHALL target only the caller's non-built-in record and return whether any row changed.

#### Scenario: Built-in mutation attempt

- **WHEN** update/delete targets a built-in with no mutable tenant override
- **THEN** it SHALL return false
- **AND** SHALL NOT modify the shared built-in.

There is no guaranteed custom DuplicateTemplateError or immutable-template exception contract.

## Source map

[Store](../../../src/prompt-template/store.ts), [tests](../../../src/prompt-template/__tests__/store.test.ts), [SQLite migrations](../../../src/storage/sqlite/migrations/). Built-in seed contents are defined by migrations and are not duplicated here.
