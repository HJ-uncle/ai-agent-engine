export { getMemoryDb, initMemoryDb, closeMemoryDb } from './db.js'
export { MEMORY_SCHEMA } from './schema.js'
export { SQLiteMemoryManager } from './memory-manager.js'
export { createMemoryEmbeddingService, backfillMemoryEmbeddings, OpenAIMemoryEmbeddingService } from './embedding.js'
export type { MemoryEmbeddingConfig, MemoryEmbeddingService, EmbeddingBackfillResult } from './embedding.js'
export { MemoryConsolidator } from './consolidation.js'
export { getSessionMemorySettings, setSessionMemoryScope, defaultMemoryMode, isMemoryMode } from './settings.js'
export type { MemoryMode } from './settings.js'
export type {
  MemoryManager,
  MemoryNode,
  MemoryEdge,
  MemoryGraphMeta,
  MemoryContext,
  MemoryNodeType,
  MemoryEdgeType,
  MemoryNodeFilter,
  CreateMemoryNodeInput,
  UpdateMemoryNodeInput,
  CreateMemoryEdgeInput,
  MemoryScope,
} from './types.js'
