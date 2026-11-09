import type { JSONSchema, Tool } from '../core/agent-context/types.js'
import { modelAnnotations, modelDescriptions } from './model-tool-copy.js'

/**
 * Only explicit engine-owned factory registrations use this projection. Matching
 * names or sources do not opt extensions in. Executable objects, catalogue text,
 * outputSchema and all non-description parameter nodes are kept unchanged.
 */
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const schemaSingles = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'contentSchema'])
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

function compactSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'description' && typeof child === 'string') return [key, modelAnnotations[child] ?? child]
    if ((schemaMaps.has(key) || key === 'dependencies') && child && typeof child === 'object' && !Array.isArray(child)) {
      return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name,
        key === 'dependencies' && Array.isArray(schema) ? schema : compactSchema(schema)]))]
    }
    if ((schemaArrays.has(key) || key === 'items') && Array.isArray(child)) return [key, child.map(compactSchema)]
    if (schemaSingles.has(key)) return [key, compactSchema(child)]
    // const/enum/default/examples and extension data are values, not schemas.
    return [key, child]
  }))
}

export function compactBuiltinToolDefinition(tool: Tool): Pick<Tool, 'description' | 'parameters'> {
  const parameters = compactSchema(tool.parameters) as JSONSchema
  // The legacy writer has an open payload schema; keep its actual shape examples.
  if (tool.name === 'write_file' && parameters.properties?.data) parameters.properties.data.description =
    String.raw`New raw text/JSON only; omit data for copies and use copyFrom instead. Generated line text: data:"7",trailingNewline:"LF" writes "7\n" once. Omitted/preserve leaves data untouched. No later newline repair. Legacy XLSX:{theme,autoWidth,headerBg,headerColor,rowAlternateBg,images:[{path,range}],sheets:[...]}; hex colors without #, autoWidth fits columns, images use cell ranges. Legacy DOCX:{theme,primaryColor,font,margin:{top,right,bottom,left},sections:[{children:[{type:"paragraph",children:[{type:"image",path,width,height}]}]}]}; primaryColor styles headings/table headers, font is font name, margins in twips (1440=1 inch).`
  // A batch item uses precisely the single-file payload grammar. Keep the long
  // legacy examples once; schemas/constraints are unchanged by this projection.
  if (tool.name === 'write_file' && parameters.properties?.files) {
    const item = parameters.properties.files.items as JSONSchema | undefined
    if (item?.properties?.data) item.properties.data.description = 'Same data contract as top-level data, including raw text, JSON and legacy Office shapes; omit when copyFrom is provided.'
  }
  if (tool.name === 'run_skill_script' && parameters.properties?.command && tool.description.includes('自动注入 SKILLS_ROOT')) parameters.properties.command.description = 'Exact full Shell command from SKILL.md; $SKILLS_ROOT is the skill root.'
  // Bound skill scripts enforce a different grammar; keep that complete contract.
  const description = tool.name === 'run_skill_script' && !tool.description.includes('自动注入 SKILLS_ROOT')
    ? tool.description : modelDescriptions[tool.name] ?? tool.description
  return { description, parameters }
}
