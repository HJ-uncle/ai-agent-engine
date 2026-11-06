import { subagentTool, subagentStartTool } from './subagent-tool.js'
import { asyncSubagentTools } from './async-tools.js'
import { readonlySubagentTools as readonlyControls } from './async-tools.js'
import { subagentDirectoryTool, subagentFollowupTool, subagentRequestInputTool } from './team-tools.js'
export const readonlySubagentTools = [...readonlyControls, subagentDirectoryTool]

export const subagentTools = [subagentTool, subagentStartTool, ...asyncSubagentTools, subagentDirectoryTool, subagentFollowupTool, subagentRequestInputTool]
/** Lifecycle controls are scoped by real execution ownership; they cannot spawn a new child. */
export const ownedCollaborationTools = [...asyncSubagentTools, subagentDirectoryTool, subagentFollowupTool, subagentRequestInputTool]
