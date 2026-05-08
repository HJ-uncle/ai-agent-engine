import React, { useState, useEffect, useCallback } from 'react'
import {
  Button, Input, Tooltip, Popconfirm, Modal, Form,
  Spin, Tag, message as antMsg,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined,
  SearchOutlined, FileTextOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import { knowledgeApi } from '@core/api'
import type { KnowledgeDocument, KnowledgeSearchResult } from '@core/types'
import styles from './KnowledgePanel.module.css'

// ── Ingest Modal ───────────────────────────────────────────────────────────────
function IngestModal({ open, onClose, onSaved }: {
  open: boolean
  onClose: () => void
  onSaved: (doc: KnowledgeDocument) => void
}) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    const values = await form.validateFields()
    setLoading(true)
    try {
      const doc = await knowledgeApi.ingest({
        filename: values.filename,
        content: values.content,
        contentType: 'text/plain',
      })
      antMsg.success('文档已入库')
      form.resetFields()
      onSaved(doc)
    } catch (err: any) {
      antMsg.error(err.message ?? '入库失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="添加知识库文档" open={open} onCancel={onClose} onOk={submit} okText="入库" confirmLoading={loading} width={600}>
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="filename" label="文件名 / 标题" rules={[{ required: true }]}>
          <Input placeholder="例如：产品手册.txt" />
        </Form.Item>
        <Form.Item name="content" label="文档内容" rules={[{ required: true }]}>
          <Input.TextArea placeholder="粘贴文档内容..." autoSize={{ minRows: 8, maxRows: 16 }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ── Search Result ──────────────────────────────────────────────────────────────
function SearchResults({ results }: { results: KnowledgeSearchResult[] }) {
  if (!results.length) return null
  return (
    <div className={styles.results}>
      <div className={styles.resultsTitle}>搜索结果</div>
      {results.map((r, i) => (
        <div key={i} className={styles.resultItem}>
          <div className={styles.resultMeta}>
            <FileTextOutlined style={{ color: '#60a5fa', fontSize: 12 }} />
            <span className={styles.resultFile}>{r.filename}</span>
            <Tag color="green" style={{ fontSize: 10, padding: '0 4px', lineHeight: '16px', height: 16 }}>
              {(r.score * 100).toFixed(0)}%
            </Tag>
          </div>
          <div className={styles.resultContent}>{r.content}</div>
        </div>
      ))}
    </div>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────────
export default function KnowledgePanel() {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await knowledgeApi.listDocuments()
      setDocs(res.list)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  const handleDelete = async (id: string) => {
    try {
      await knowledgeApi.deleteDocument(id)
      setDocs((d) => d.filter((x) => x.id !== id))
      antMsg.success('已删除')
    } catch (err: any) { antMsg.error(err.message) }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const results = await knowledgeApi.search(searchQuery, 5)
      setSearchResults(results)
      if (!results.length) antMsg.info('未找到相关内容')
    } catch (err: any) { antMsg.error(err.message) }
    finally { setSearching(false) }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Knowledge Base</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip title="刷新">
            <Button type="text" size="small" icon={<ReloadOutlined />} className={styles.headerBtn} onClick={fetchDocs} loading={loading} />
          </Tooltip>
          <Tooltip title="添加文档">
            <Button type="text" size="small" icon={<PlusOutlined />} className={styles.headerBtn} onClick={() => setModalOpen(true)} />
          </Tooltip>
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchBar}>
        <Input
          size="small"
          placeholder="语义搜索知识库..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onPressEnter={handleSearch}
          suffix={
            <Button type="text" size="small" icon={<SearchOutlined />} loading={searching} onClick={handleSearch} style={{ height: 20, padding: '0 4px' }} />
          }
          className={styles.searchInput}
        />
      </div>

      {/* Search results */}
      {searchResults.length > 0 && <SearchResults results={searchResults} />}

      {/* Divider if both search results and docs */}
      {searchResults.length > 0 && docs.length > 0 && (
        <div className={styles.divider}>全部文档</div>
      )}

      {/* Document list */}
      <div className={styles.list}>
        {loading && docs.length === 0 ? (
          <div className={styles.empty}><Spin size="small" /></div>
        ) : docs.length === 0 ? (
          <div className={styles.empty}>
            <DatabaseOutlined style={{ fontSize: 28, opacity: 0.25 }} />
            <span>暂无文档，点击 + 添加</span>
          </div>
        ) : (
          docs.map((doc) => (
            <div key={doc.id} className={styles.docItem}>
              <FileTextOutlined className={styles.docIcon} />
              <div className={styles.docInfo}>
                <div className={styles.docName}>{doc.filename}</div>
                <div className={styles.docMeta}>
                  {doc.chunkCount != null && <span>{doc.chunkCount} 块</span>}
                  {doc.size != null && <span>{(doc.size / 1024).toFixed(1)}KB</span>}
                  <span>{new Date(doc.createdAt).toLocaleDateString('zh-CN')}</span>
                </div>
              </div>
              <Popconfirm title="删除此文档？" onConfirm={() => handleDelete(doc.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                <Button type="text" size="small" icon={<DeleteOutlined />} className={styles.deleteBtn} />
              </Popconfirm>
            </div>
          ))
        )}
      </div>

      <IngestModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={(doc) => { setDocs((d) => [doc, ...d]); setModalOpen(false) }}
      />
    </div>
  )
}
