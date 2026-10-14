import { subagentTool, subagentStartTool } from './subagent-tool.js'
import { asyncSubagentTools } from './async-tools.js'
export { readonlySubagentTools } from './async-tools.js'

export const subagentTools = [subagentTool, subagentStartTool, ...asyncSubagentTools]
