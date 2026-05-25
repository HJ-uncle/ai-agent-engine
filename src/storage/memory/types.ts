// ─── Memory Domain Types ────────────────────────────────────────────────────

export type MemoryNodeType =
  | 'preference'
  | 'decision'
  | 'fact'
  | 'lesson'
  | 'narrative'
  | 'milestone'

export type MemoryEdgeType =
  | 'reinforces'
  | 'contradicts'
  | 'leads_to'
  | 'part_of'
  | 'similar_to'
  | 'tagged_with'

export interface MemoryNode {
  id: string
  tenantId: string
  sessionId: string
  type: MemoryNodeType
  timestamp: number
  lastAccessed: number
  strength: number
  importance: number
  summary: string
  detail: string | null
  triggerContext: string | null
  emotionalValence: number
  emotionalTrigger: string | null
  sourceSessionId: string | null
  sourceInteractionIndex: number | null
  sourceToolsUsed: string[] | null
  sourceContextSnapshot: string | null
  decayRate: number
  lastStrengthUpdate: number
  embeddingJson: string | null
  embedding?: number[]
  createdAt: number
  updatedAt: number
  tags?: string[]
}

export interface MemoryEdge {
  id: string
  tenantId: string
  sourceNodeId: string
  targetNodeId: string
  type: MemoryEdgeType
  strength: number
  description: string | null
  createdAt: number
}

export interface MemoryGraphMeta {
  version: string
  lastConsolidation: string | null
  totalNodes: number
  totalEdges: number
  owner: string | null
  description: string | null
}

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface CreateMemoryNodeInput {
  type: MemoryNodeType
  timestamp?: number
  strength?: number
  importance?: number
  summary: string
  detail?: string | null
  triggerContext?: string | null
  emotionalValence?: number
  emotionalTrigger?: string | null
  sourceSessionId?: string | null
  sourceInteractionIndex?: number | null
  sourceToolsUsed?: string[] | null
  sourceContextSnapshot?: string | null
  decayRate?: number
  tags?: string[]
  embedding?: number[]
}

export interface UpdateMemoryNodeInput {
  type?: MemoryNodeType
  strength?: number
  importance?: number
  summary?: string
  detail?: string | null
  triggerContext?: string | null
  emotionalValence?: number
  emotionalTrigger?: string | null
  decayRate?: number
  lastAccessed?: number
  embeddingJson?: string | null
  embedding?: number[]
}

export interface CreateMemoryEdgeInput {
  sourceNodeId: string
  targetNodeId: string
  type: MemoryEdgeType
  strength?: number
  description?: string | null
}

export interface MemoryNodeFilter {
  types?: MemoryNodeType[]
  minStrength?: number
  maxStrength?: number
  minImportance?: number
  tags?: string[]
  sessionId?: string
  orderBy?: 'timestamp' | 'strength' | 'importance' | 'last_accessed'
  orderDir?: 'ASC' | 'DESC'
  limit?: number
  offset?: number
}

export interface MemoryContext {
  tenantId: string
  sessionId: string
}

// ─── MemoryManager Interface ─────────────────────────────────────────────────

export interface MemoryManager {
  // Node CRUD
  createNode(input: CreateMemoryNodeInput, ctx: MemoryContext): Promise<MemoryNode>
  getNode(id: string, ctx: MemoryContext): Promise<MemoryNode | null>
  updateNode(id: string, updates: UpdateMemoryNodeInput, ctx: MemoryContext): Promise<MemoryNode | null>
  deleteNode(id: string, ctx: MemoryContext): Promise<void>

  // Node queries
  listNodes(filter: MemoryNodeFilter, ctx: MemoryContext): Promise<MemoryNode[]>
  recallByTags(tags: string[], ctx: MemoryContext): Promise<MemoryNode[]>
  recallRecent(limit: number, ctx: MemoryContext): Promise<MemoryNode[]>
  recallImportant(minImportance: number, ctx: MemoryContext): Promise<MemoryNode[]>
  recallBySession(sessionId: string, ctx: MemoryContext): Promise<MemoryNode[]>
  recallSimilar(embedding: number[], limit: number, ctx: MemoryContext): Promise<MemoryNode[]>

  // Edge CRUD
  createEdge(input: CreateMemoryEdgeInput, ctx: MemoryContext): Promise<MemoryEdge>
  deleteEdge(id: string, ctx: MemoryContext): Promise<void>
  getEdges(nodeId: string, ctx: MemoryContext): Promise<MemoryEdge[]>

  // Graph traversal
  getNeighbors(
    nodeId: string,
    edgeTypes?: MemoryEdgeType[],
    ctx?: MemoryContext,
  ): Promise<MemoryNode[]>
  traversePath(
    startNodeId: string,
    maxHops: number,
    edgeTypes?: MemoryEdgeType[],
    ctx?: MemoryContext,
  ): Promise<MemoryNode[]>
  getRelatedNodes(
    nodeIds: string[],
    edgeTypes?: MemoryEdgeType[],
    ctx?: MemoryContext,
  ): Promise<MemoryNode[]>

  // Tags
  addTag(nodeId: string, tag: string, ctx: MemoryContext): Promise<void>
  removeTag(nodeId: string, tag: string, ctx: MemoryContext): Promise<void>
  getTags(nodeId: string, ctx: MemoryContext): Promise<string[]>

  // Lifecycle
  decayNodes(ctx: MemoryContext): Promise<number>
  consolidate(ctx: MemoryContext): Promise<string>

  // Graph meta
  getGraphMeta(ctx: MemoryContext): Promise<MemoryGraphMeta>

  // Bulk write (for automated memory extraction)
  writeBatch(
    nodes: CreateMemoryNodeInput[],
    edges: CreateMemoryEdgeInput[],
    ctx: MemoryContext,
  ): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }>
}
