## ADDED Requirements

### Requirement: Tool Registration

The ToolRegistry SHALL provide a `register(tool: Tool)` method that stores a tool by its unique name.

#### Scenario: Successful tool registration
- **WHEN** `register(tool)` is called with a tool whose `name` does not already exist in the registry
- **THEN** the registry SHALL store the tool and make it available for subsequent `execute` and `list` calls

#### Scenario: Duplicate tool registration
- **WHEN** `register(tool)` is called with a tool whose `name` already exists in the registry
- **THEN** the registry SHALL throw a `DuplicateToolError` containing the conflicting tool name and SHALL NOT overwrite the existing registration

#### Scenario: Tool name validation
- **WHEN** `register(tool)` is called with a tool whose `name` is empty or contains invalid characters
- **THEN** the registry SHALL throw an `InvalidToolNameError` before storing the tool

---

### Requirement: Tool Execution

The ToolRegistry SHALL provide an `execute(name, args, ctx)` method that invokes a registered tool by name.

#### Scenario: Successful tool execution
- **WHEN** `execute(name, args, ctx)` is called and the named tool exists
- **THEN** the registry SHALL invoke the tool's handler with `args` and `ctx` and return the result

#### Scenario: Tool not found
- **WHEN** `execute(name, args, ctx)` is called with a name that is not registered
- **THEN** the registry SHALL return a `ToolNotFoundError` with the requested tool name and SHALL NOT throw an unhandled exception

#### Scenario: Tool execution error propagation
- **WHEN** the tool handler throws an error during execution
- **THEN** the registry SHALL wrap the error in a `ToolExecutionError` and return it to the caller with the original error attached as `cause`

---

### Requirement: Tool Listing

The ToolRegistry SHALL provide a `list()` method that returns the schema descriptions of all registered tools.

#### Scenario: List all registered tools
- **WHEN** `list()` is called after registering N tools
- **THEN** the method SHALL return an array of N objects, each containing the tool's `name`, `description`, and `inputSchema`

#### Scenario: List on empty registry
- **WHEN** `list()` is called before any tools are registered
- **THEN** the method SHALL return an empty array

---

### Requirement: Tool Unregistration

The ToolRegistry SHALL provide an `unregister(name)` method that removes a previously registered tool.

#### Scenario: Successful unregistration
- **WHEN** `unregister(name)` is called with the name of a registered tool
- **THEN** the registry SHALL remove the tool and subsequent calls to `execute(name, ...)` SHALL return `ToolNotFoundError`

#### Scenario: Unregister non-existent tool
- **WHEN** `unregister(name)` is called with a name that is not registered
- **THEN** the registry SHALL throw a `ToolNotFoundError` indicating the tool does not exist
