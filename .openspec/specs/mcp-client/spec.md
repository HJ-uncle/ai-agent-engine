# mcp-client Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: MCP Server Connection

The MCP Client SHALL connect to external MCP (Model Context Protocol) servers based on configuration entries specifying server URL and optional authentication credentials.

#### Scenario: Successful connection to MCP server
- **WHEN** the configuration contains a valid MCP server entry with `url` and the server is reachable
- **THEN** the MCP Client SHALL establish a connection and mark the server as `connected`

#### Scenario: Connection with authentication
- **WHEN** the MCP server entry includes an `apiKey` or bearer token credential
- **THEN** the MCP Client SHALL include the credential in all requests to that server

#### Scenario: Multiple server connections
- **WHEN** the configuration contains N MCP server entries
- **THEN** the MCP Client SHALL attempt to connect to all N servers independently and report the connection status for each

---

### Requirement: Tool Discovery

The MCP Client SHALL automatically fetch and cache the list of tools exposed by each connected MCP server.

#### Scenario: Tools fetched on connection
- **WHEN** a connection to an MCP server is successfully established
- **THEN** the MCP Client SHALL call the server's tool listing endpoint and cache the returned tool descriptors (name, description, inputSchema)

#### Scenario: Tool list refresh
- **WHEN** `refreshTools(serverUrl)` is called or the configured `refreshIntervalMs` elapses
- **THEN** the MCP Client SHALL re-fetch the tool list from the server and update the cache

#### Scenario: Server returns empty tool list
- **WHEN** an MCP server returns an empty tool list
- **THEN** the MCP Client SHALL cache an empty list for that server and SHALL NOT raise an error

---

### Requirement: Tool Wrapping and ToolRegistry Integration

The MCP Client SHALL wrap each discovered MCP tool as a `Tool` interface object and register it with the `ToolRegistry`, making it transparently available to the Agent Loop.

#### Scenario: MCP tool wrapped and registered
- **WHEN** an MCP server exposes a tool named `"web-search"` with a given `inputSchema`
- **THEN** the MCP Client SHALL create a `Tool` wrapper with the same `name`, `description`, and `inputSchema`, and call `ToolRegistry.register(wrappedTool)`

#### Scenario: MCP tool execution routed to server
- **WHEN** the Agent Loop calls `ToolRegistry.execute("web-search", args, ctx)`
- **THEN** the MCP Client's wrapper SHALL serialize `args` and forward the invocation to the originating MCP server's tool execution endpoint, returning the result

#### Scenario: Name collision with existing tool
- **WHEN** an MCP tool name conflicts with an already-registered local tool name
- **THEN** the MCP Client SHALL prefix the MCP tool name with the server identifier (e.g., `"mcp:<serverId>:web-search"`) to avoid collision and SHALL log a warning

---

### Requirement: Connection Error Handling

The MCP Client SHALL handle MCP server unavailability gracefully, without disrupting the availability of other registered tools.

#### Scenario: MCP server unreachable at startup
- **WHEN** the MCP Client attempts to connect to a configured server and the server is unreachable
- **THEN** the client SHALL log an error, mark that server as `disconnected`, and SHALL NOT register any tools from that server; other servers SHALL be unaffected

#### Scenario: MCP server becomes unavailable mid-operation
- **WHEN** an MCP tool execution call fails because the server connection is lost
- **THEN** the tool wrapper SHALL return a `MCPServerUnavailableError` to the ToolRegistry and the Agent Loop SHALL treat it as a tool execution error without crashing

#### Scenario: Reconnection attempt
- **WHEN** a configured MCP server was previously `disconnected` and `reconnectIntervalMs` elapses
- **THEN** the MCP Client SHALL attempt to reconnect and, upon success, SHALL re-fetch and re-register that server's tools

