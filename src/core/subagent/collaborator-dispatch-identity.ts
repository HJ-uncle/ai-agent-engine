import type { Tool } from '../agent-context/types.js'

// A model or extension may reuse a name, but only the server-created per-run
// dispatcher may consume the user's already validated collaborator choices.
const dispatchers = new WeakSet<Tool>()
export function identifyCollaboratorDispatch(tool: Tool): Tool { dispatchers.add(tool); return tool }
export function isCollaboratorDispatch(tool: Tool): boolean { return dispatchers.has(tool) }
