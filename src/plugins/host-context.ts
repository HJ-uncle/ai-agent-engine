import { z } from 'zod'
/** Presentation context is never authority and cannot select another session. */
export const pluginHostContextSchema = z.object({ messageId: z.string().max(256).optional(), messageRole: z.string().max(40).optional(),
  filePath: z.string().max(4096).optional(), selectionText: z.string().max(32_768).optional(), targetId: z.string().max(256).optional() }).strict()
export type PluginHostContext = z.infer<typeof pluginHostContextSchema>
