# MCP Client Specification

## Purpose

Describe implemented MCP transport, discovery, registration and configuration boundaries. Source audit: 2026-11-17.

## Requirements

### Requirement: Scoped configuration and discovery

MCP SHALL support stdio, http, sse and streamableHttp transports. Configuration SHALL resolve project .ae/mcp.json, global ~/.aether/mcp.json and explicit MCP_CONFIG_PATH according to the storage resolver.

#### Scenario: Restricted server selection

- **WHEN** allowedMcpServers is an empty array
- **THEN** no server SHALL be connected or discovered.
- **WHEN** explicit server IDs are supplied
- **THEN** filtering SHALL happen before constructing a client, starting a process or sending a handshake.

#### Scenario: Inline server

- **WHEN** a valid request-level inline stdio or remote server is authorized
- **THEN** it MAY be discovered without persisting configuration
- **AND** local configuration SHALL take priority for the same ID.

Inline stdio is supported by current code despite stale comments suggesting remote-only support.

### Requirement: Namespaced business tools

Discovered tools SHALL be registered under mcp_<serverId>_<toolName>, with unsupported identifier characters normalized.

#### Scenario: Partial discovery failure

- **WHEN** one server cannot connect
- **THEN** the loader SHALL skip that server and preserve other eligible tools
- **AND** cancellation SHALL still propagate.
- **WHEN** a tool is disabled by its server or rejected by the request filter
- **THEN** it SHALL NOT be registered.

### Requirement: Demand-driven connection lifecycle

Discovery SHALL occur when registries are built; the client SHALL lazily reconnect for execution as needed. The implementation SHALL NOT be described as an interval-based automatic refresh/reconnect service.

#### Scenario: Discovery connection cleanup

- **WHEN** stdio or SSE discovery has produced tool definitions
- **THEN** the discovery connection SHALL disconnect
- **AND** execution SHALL obtain its own needed connection.

The current discovery default is 15000 ms unless overridden. Actual tools/call uses configured timeout or 0 (no imposed operation deadline); cancellation and transport errors still apply.

### Requirement: Results and management separation

Tool results SHALL preserve protocol content, structured output and isError semantics through result conversion. Business MCP tools SHALL be distinct from mcp_server_* configuration-management tools.

#### Scenario: Management mutation

- **WHEN** a request modifies shared server configuration
- **THEN** trusted management authorization, version checks and mutation approval SHALL apply
- **AND** saving a new server SHALL not imply it has been enabled or successfully connected.

## Source map

[Client](../../../src/tools/mcp/client.ts), [loader](../../../src/tools/mcp/loader.ts), [result conversion](../../../src/tools/mcp/result.ts), [configuration](../../../src/storage/mcp/mcp-config.ts), [management](../../../src/tools/mcp/management-tools.ts). No external MCP service was contacted for this documentation audit.
