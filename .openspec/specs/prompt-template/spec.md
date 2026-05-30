# prompt-template Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Template Storage

The PromptTemplate system SHALL store system prompt templates by name in SQLite, supporting create, read, update, and delete operations.

#### Scenario: Create a new template
- **WHEN** a template with a given `name` is saved and no template with that name exists for the tenant
- **THEN** the template SHALL be persisted in the `prompt_templates` table with `name`, `content`, and `tenantId`

#### Scenario: Template name uniqueness per tenant
- **WHEN** a template is created with a name that already exists for the same `tenantId`
- **THEN** the system SHALL return a `DuplicateTemplateError` and SHALL NOT overwrite the existing template

#### Scenario: Template stored in SQLite
- **WHEN** a template is created and the service is restarted
- **THEN** the template SHALL still be retrievable after restart

---

### Requirement: Template Rendering

The PromptTemplate system SHALL provide a `render(name, variables)` method that returns the template content with all `{{variable}}` placeholders replaced by their corresponding values.

#### Scenario: Successful render with all variables provided
- **WHEN** `render(name, { topic: "AI", language: "English" })` is called for a template containing `{{topic}}` and `{{language}}`
- **THEN** the method SHALL return the template content with both placeholders replaced by their provided values

#### Scenario: Render with missing variable
- **WHEN** `render(name, variables)` is called and the template contains a placeholder for which no value is provided in `variables`
- **THEN** the system SHALL either leave the placeholder unchanged (with a warning log) or throw a `MissingVariableError`, as configured by `strictMode`

#### Scenario: Template not found
- **WHEN** `render(name, variables)` is called for a template name that does not exist
- **THEN** the method SHALL throw a `TemplateNotFoundError`

#### Scenario: Render escaping
- **WHEN** a variable value contains `{{` or `}}` characters
- **THEN** the renderer SHALL treat them as literal characters and SHALL NOT perform recursive template substitution

---

### Requirement: Built-In Templates

The system SHALL pre-register built-in role templates (`assistant`, `coder`, `analyst`) that are available to all tenants without requiring creation.

#### Scenario: Built-in assistant template available
- **WHEN** `render("assistant", variables)` is called without prior template creation
- **THEN** the system SHALL successfully render the built-in assistant system prompt

#### Scenario: Built-in coder template available
- **WHEN** `render("coder", variables)` is called
- **THEN** the system SHALL render a built-in system prompt oriented towards code generation and explanation tasks

#### Scenario: Built-in analyst template available
- **WHEN** `render("analyst", variables)` is called
- **THEN** the system SHALL render a built-in system prompt oriented towards data analysis and reasoning tasks

#### Scenario: Built-in templates cannot be deleted
- **WHEN** a `delete` operation is called on a built-in template name
- **THEN** the system SHALL return a `BuiltInTemplateError` and SHALL NOT remove the template

---

### Requirement: Custom Template Management

The PromptTemplate system SHALL allow tenants to create, update, and delete their own templates, scoped by `tenantId`.

#### Scenario: Create custom template
- **WHEN** `createTemplate(name, content, ctx)` is called by a tenant
- **THEN** the template SHALL be stored with `tenantId = ctx.tenantId` and SHALL be accessible only to that tenant

#### Scenario: Update custom template
- **WHEN** `updateTemplate(name, newContent, ctx)` is called for an existing custom template owned by the tenant
- **THEN** the template content SHALL be updated and subsequent `render` calls SHALL use the new content

#### Scenario: Delete custom template
- **WHEN** `deleteTemplate(name, ctx)` is called for a custom template owned by the tenant
- **THEN** the template SHALL be removed from storage and subsequent `render` calls SHALL throw `TemplateNotFoundError`

#### Scenario: Cross-tenant template isolation
- **WHEN** tenant A creates a template named `"my-template"` and tenant B calls `render("my-template", {}, ctxB)`
- **THEN** the system SHALL return `TemplateNotFoundError` for tenant B, as the template belongs to tenant A

