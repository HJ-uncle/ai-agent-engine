## ADDED Requirements

### Requirement: Workspace Isolation

Each combination of `tenantId` and `sessionId` SHALL have a dedicated, isolated directory at the path `workspace/<tenantId>/<sessionId>/`.

#### Scenario: Separate directories per session
- **WHEN** two sessions with different `sessionId` values (under the same `tenantId`) each write a file with the same name
- **THEN** the files SHALL be stored in separate directories and SHALL NOT overwrite each other

#### Scenario: Separate directories per tenant
- **WHEN** two tenants with different `tenantId` values each write a file with the same name and same `sessionId`
- **THEN** the files SHALL be stored in separate top-level tenant directories and SHALL NOT overlap

---

### Requirement: Path Safety Validation

All file operations within the workspace SHALL be validated to ensure they remain inside the session's workspace directory. Path traversal attacks MUST be rejected.

#### Scenario: Path traversal attempt rejected
- **WHEN** a file operation is requested with a path containing `..` segments that would escape the workspace directory
- **THEN** the system SHALL reject the operation with a `PathTraversalError` and SHALL NOT access any file outside the workspace

#### Scenario: Absolute path outside workspace rejected
- **WHEN** a file operation is requested with an absolute path that does not begin with the session's workspace directory
- **THEN** the system SHALL reject the operation with a `PathTraversalError`

#### Scenario: Valid relative path accepted
- **WHEN** a file operation is requested with a relative path that resolves to a location inside the workspace directory
- **THEN** the system SHALL allow the operation

---

### Requirement: Workspace Initialization

The workspace directory SHALL be created automatically on first access, without requiring explicit initialization by the caller.

#### Scenario: Auto-create on first file write
- **WHEN** a file write operation is requested for a session whose workspace directory does not yet exist
- **THEN** the system SHALL create the full directory path `workspace/<tenantId>/<sessionId>/` and proceed with the write

#### Scenario: Idempotent initialization
- **WHEN** the workspace directory already exists and a file operation is requested
- **THEN** the system SHALL NOT attempt to recreate the directory and SHALL proceed normally

---

### Requirement: Workspace Snapshot

The Workspace SHALL provide a `snapshot(ctx)` method that archives the entire workspace directory as a zip file and returns its file path.

#### Scenario: Successful snapshot creation
- **WHEN** `snapshot(ctx)` is called for a session with files in its workspace
- **THEN** the system SHALL create a zip archive containing all files and subdirectories of the workspace and return the absolute path to the zip file

#### Scenario: Snapshot of empty workspace
- **WHEN** `snapshot(ctx)` is called for a session with an empty workspace
- **THEN** the system SHALL create a valid (empty) zip archive and return its path without error

---

### Requirement: Workspace Restoration

The Workspace SHALL provide a `restore(snapshotPath, ctx)` method that extracts a previously created snapshot zip into the session's workspace directory.

#### Scenario: Successful restoration
- **WHEN** `restore(snapshotPath, ctx)` is called with the path to a valid zip snapshot
- **THEN** the system SHALL extract all files from the zip into `workspace/<tenantId>/<sessionId>/`, overwriting any existing files

#### Scenario: Invalid snapshot path rejected
- **WHEN** `restore(snapshotPath, ctx)` is called with a `snapshotPath` that does not exist or is not a zip file
- **THEN** the system SHALL return a `SnapshotRestoreError` and SHALL NOT modify the existing workspace

#### Scenario: Snapshot path traversal prevented
- **WHEN** a zip archive contains entries with paths that would extract outside the workspace directory (zip slip attack)
- **THEN** the system SHALL reject the restore operation with a `PathTraversalError` and SHALL NOT extract any files
