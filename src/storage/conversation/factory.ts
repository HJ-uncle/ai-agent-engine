/**
 * 会话历史存储工厂
 *
 * 通过环境变量 `HISTORY_BACKEND` 选择后端：
 * - `jsonl`（默认）：JSONLConversationHistory（Claude Code 格式，追加写 + summary 行压缩）
 * - `sqlite`：SQLiteConversationHistory（逃生门，JSONL 出问题时回退用）
 *
 * 旧 SQLite 数据通过 JSONL 后端的懒迁移自动转入（首次读取该会话时），SQLite 旧行保留不删。
 */
import type { ConversationHistory } from '../../core/agent-context/types.js'
import { SQLiteConversationHistory } from './history.js'
import { JSONLConversationHistory } from './jsonl-history.js'

export function createConversationHistory(maxTokens?: number): ConversationHistory {
  if (process.env.HISTORY_BACKEND === 'sqlite') {
    return new SQLiteConversationHistory(maxTokens)
  }
  return new JSONLConversationHistory(maxTokens)
}
