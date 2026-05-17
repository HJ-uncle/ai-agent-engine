import React, { useState, useCallback, useRef, useEffect, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { ImageViewer } from 'antd-mobile'
import {
  ContentOutline,
  RedoOutline,
  CheckCircleOutline,
  CloseCircleOutline,
  DeleteOutline,
} from 'antd-mobile-icons'
import type { Message, ThinkingStep } from '@core/types'
import { copyToClipboard } from '@core/utils/clipboard'
import { TokenStatsPopup } from './TokenStatsPopup'
import styles from './MessageBubble.module.css'

// ─── 工具名称映射 ────────────────────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  ask_user: '询问用户',
  read_file: '读取文件',
  write_file: '写入文件',
  list_files: '列出文件',
  delete_file: '删除文件',
  create_dir: '创建目录',
  execute_cmd: '执行命令',
  remember: '记录记忆',
  recall: '回忆记忆',
  list_memories: '列出记忆',
  forget: '遗忘记忆',
  list_skills: '列出技能',
  get_skill: '获取技能',
  run_skill_script: '运行脚本',
  get_time: '获取时间',
  search_files: '搜索文件',
  read_url: '读取网页',
  get_weather: '获取天气',
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function extractText(content: string | any[]): string {
  const raw = typeof content === 'string'
    ? content
    : content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('')
  // 过滤完整的 <think>...</think> 块，再过滤残留的单独 </think> 标签
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/?think>/g, '')
    .trimStart()
}

function extractImages(content: string | any[]): Array<{ url: string; alt: string }> {
  if (typeof content === 'string') return []
  return content
    .filter((c: any) => c.type === 'image_url' && c.image_url?.url)
    .map((c: any) => ({ url: c.image_url.url, alt: c.image_url.alt || '图片' }))
}

function extractWorkspaceFiles(content: string | any[]): Array<{ name: string; fileType: string }> {
  if (typeof content === 'string') return []
  return content
    .filter((c: any) => c.type === 'workspace_file')
    .map((c: any) => ({ name: c.name, fileType: c.fileType }))
}

function fileIcon(fileType: string) {
  if (fileType.startsWith('image/')) return '🖼️'
  if (fileType.includes('pdf')) return '📄'
  if (fileType.includes('zip') || fileType.includes('tar') || fileType.includes('gz')) return '🗜️'
  if (fileType.includes('text') || fileType.includes('json') || fileType.includes('xml')) return '📝'
  return '📎'
}

function fmtTokenTotal(n: number = 0) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return n.toString()
}

/**
 * useCopyBtn: 点击后 1.5s 显示 "已复制"
 * 不使用 antd-mobile Toast（React 18 中会崩溃）
 */
function useCopyBtn() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = useCallback(async (text: string) => {
    await copyToClipboard(text)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }, [])
  return { copied, copy }
}

// ─── 链接下载处理 ─────────────────────────────────────────────────────────────

/**
 * 判断一个链接是否是可下载的文件链接，返回下载 URL 和文件名。
 * 支持两类：
 *   1. 后端 API 下载路径：/api/v1/workspace/file/download?sessionId=...&path=...
 *   2. 遗留的 file:// 本地路径（兜底，自动转换为 API 路径）
 */
function parseDownloadHref(
  href: string,
  sessionId: string,
): { downloadUrl: string; filename: string } | null {
  if (!href) return null

  // ① 已经是 API 下载路径 → 直接使用，提取文件名
  if (href.includes('/workspace/file/download')) {
    try {
      // 处理相对路径：补全 origin
      const url = new URL(href, window.location.origin)
      const pathParam = url.searchParams.get('path') ?? ''
      const filename = pathParam.split('/').pop() || pathParam.split('\\').pop() || 'download'
      return { downloadUrl: href, filename }
    } catch {
      return null
    }
  }

  // ② file:// 协议或 Windows/Unix 绝对路径 → 转换为 API 路径（兜底）
  if (/^https?:\/\//i.test(href)) return null  // 普通外链跳过

  let decoded = href
  try { decoded = decodeURIComponent(href) } catch { /* ignore */ }
  let abs = decoded.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '').replace(/\\/g, '/')
  // 只处理含扩展名的路径
  if (!/\.[a-zA-Z0-9]{1,10}$/.test(abs)) return null

  const filename = abs.split('/').pop() || abs
  const downloadUrl = `/api/v1/workspace/file/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filename)}`
  return { downloadUrl, filename }
}

/**
 * 触发浏览器文件下载
 */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}



function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const lang = className?.replace('language-', '') || ''
  const text = String(children).replace(/\n$/, '')
  const { copied, copy } = useCopyBtn()
  return (
    <div className={styles.codeBlock}>
      {lang && <span className={styles.codeLang}>{lang}</span>}
      <button className={`${styles.codeCopyBtn} ${copied ? styles.codeCopied : ''}`} onClick={() => copy(text)}>
        {copied ? '✓ 已复制' : '复制'}
      </button>
      <pre className={styles.codePre}><code className={className}>{children}</code></pre>
    </div>
  )
}

// ─── 文件卡片 ─────────────────────────────────────────────────────────────────

function FileCard({ name, fileType }: { name: string; fileType: string }) {
  return (
    <div className={styles.fileCard}>
      <span>{fileIcon(fileType)}</span>
      <span className={styles.fileCardName}>{name}</span>
    </div>
  )
}

// ─── ask_user 交互卡片（移动端全新设计）────────────────────────────────────

interface InteractiveCardProps {
  data: any
  onReply: (content: string) => void
  disabled?: boolean
}

const InteractiveCard = memo(({ data, onReply, disabled }: InteractiveCardProps) => {
  const { question, multiSelect } = data
  let options: any[] = []
  try {
    options = Array.isArray(data.options) ? data.options
      : Array.isArray(JSON.parse(data.options ?? '[]')) ? JSON.parse(data.options) : []
  } catch { options = [] }

  const [selected, setSelected] = useState<string[]>([])
  const [isOther, setIsOther] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const toggle = (label: string) => {
    if (disabled || submitted) return
    if (multiSelect) setSelected((p) => p.includes(label) ? p.filter((x) => x !== label) : [...p, label])
    else { setSelected([label]); setIsOther(false) }
  }

  const toggleOther = () => {
    if (disabled || submitted) return
    if (multiSelect) setIsOther((v) => !v)
    else { setSelected([]); setIsOther(true) }
  }

  const submit = () => {
    const all = [...selected, ...(isOther && otherText.trim() ? [otherText.trim()] : [])]
    if (!all.length) return
    setSubmitted(true)
    onReply(all.join('，'))
  }

  const canSubmit = !disabled && !submitted && (selected.length > 0 || (isOther && otherText.trim().length > 0))

  // 已回复后显示摘要
  if (submitted || disabled) {
    const answeredStep = submitted
    return (
      <div className={styles.askCardDone}>
        <div className={styles.askDoneIcon}>✅</div>
        <div>
          <div className={styles.askDoneQ}>{question}</div>
          {answeredStep && selected.length > 0 && (
            <div className={styles.askDoneA}>
              {[...selected, ...(isOther && otherText.trim() ? [otherText.trim()] : [])].join('，')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.askCard}>
      <div className={styles.askQuestion}>
        <span className={styles.askQuestionEmoji}>🤔</span>
        <span>{question}</span>
      </div>
      <div className={styles.askOptions}>
        {options.map((opt: any, i: number) => {
          const sel = selected.includes(opt.label)
          return (
            <button key={i} className={`${styles.askOpt} ${sel ? styles.askOptSel : ''}`} onClick={() => toggle(opt.label)}>
              <div className={styles.askOptInner}>
                <span className={styles.askOptLabel}>{opt.label}</span>
                {opt.description && <span className={styles.askOptDesc}>{opt.description}</span>}
              </div>
              <span className={`${styles.askOptCheck} ${sel ? styles.askOptCheckVis : ''}`}>✓</span>
            </button>
          )
        })}
        <button className={`${styles.askOpt} ${isOther ? styles.askOptSel : ''}`} onClick={toggleOther}>
          <div className={styles.askOptInner}><span className={styles.askOptLabel}>其他</span></div>
          <span className={`${styles.askOptCheck} ${isOther ? styles.askOptCheckVis : ''}`}>✓</span>
        </button>
        {isOther && (
          <textarea
            autoFocus
            className={styles.askOtherTa}
            placeholder="请输入..."
            value={otherText}
            rows={2}
            onChange={(e) => setOtherText(e.target.value)}
          />
        )}
      </div>
      <button className={`${styles.askSubmit} ${canSubmit ? styles.askSubmitOn : ''}`} onClick={submit} disabled={!canSubmit}>
        提交回复
      </button>
    </div>
  )
})

// ─── ThinkingPanel（对齐 Web：streaming 时展开，完成/needsInput 变化时自动折叠）

interface ThinkingPanelProps {
  steps: ThinkingStep[]
  isActive?: boolean
  msgId: string
  isLast?: boolean
  onToolReply?: (msgId: string, toolCallId: string, toolName: string, content: string) => void
}

const ThinkingPanel = memo(({ steps, isActive, msgId, isLast, onToolReply }: ThinkingPanelProps) => {
  const toolSteps = steps.filter((s) => s.type === 'tool_start')
  const toolCount = toolSteps.length
  const toolNames = Array.from(new Set(toolSteps.map((s) => TOOL_NAME_MAP[s.toolName || ''] || s.toolName)))
  const hasFailure = steps.some((s) => s.type === 'tool_start' && s.success === false)

  // ★ 关键：与 Web 端 ThinkingPanelInner 完全一致的折叠逻辑
  const needsUserInput = steps.some(
    (s) => s.type === 'tool_start' && s.toolName === 'ask_user' && s.success === undefined,
  )

  const [expanded, setExpanded] = useState(isActive ?? false)

  useEffect(() => {
    if (needsUserInput) {
      setExpanded(true)   // ask_user 等待用户输入 → 强制展开
    } else {
      setExpanded(isActive ?? false)  // streaming → 展开；done → 收起
    }
  }, [isActive, needsUserInput])

  if (steps.length === 0 && !isActive) return null

  // 摘要文字
  let summary: string
  if (isActive && toolCount === 0) summary = '正在思考...'
  else if (needsUserInput) summary = `需要您回答问题`
  else if (toolCount > 0) summary = `调用了 ${toolCount} 个工具：${toolNames.slice(0, 3).join('、')}${toolNames.length > 3 ? '...' : ''}`
  else if (isActive) summary = '处理中...'
  else summary = '推理完成'

  return (
    <div className={`${styles.thinkingPanel} ${needsUserInput ? styles.thinkingPanelAsk : ''}`}>
      {/* 标题栏 */}
      <div className={styles.thinkingHeader} onClick={() => setExpanded((v) => !v)}>
        <div className={styles.thinkingLeft}>
          {isActive ? (
            <span className={styles.spinner} />
          ) : hasFailure ? (
            <CloseCircleOutline style={{ color: '#f44336', fontSize: 15 }} />
          ) : needsUserInput ? (
            <span style={{ fontSize: 14 }}>❓</span>
          ) : (
            <CheckCircleOutline style={{ color: '#4caf50', fontSize: 15 }} />
          )}
          <span className={`${styles.thinkingLabel} ${needsUserInput ? styles.thinkingLabelAsk : ''}`}>
            {summary}
          </span>
        </div>
        <span className={styles.thinkingToggle}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className={styles.thinkingBody}>
          {steps.map((step, i) => {
            // ── 思考文本 ─────────────────────────────────────────────────
            if (step.type === 'thinking') {
              return (
                <div key={i} className={styles.tlItem}>
                  <div className={styles.tlDot} style={{ background: '#a855f7' }} />
                  <div className={styles.tlContent}>
                    <div className={styles.tlTitle} style={{ color: '#a855f7' }}>💡 思考</div>
                    <div className={styles.thinkText}>{step.text}</div>
                  </div>
                </div>
              )
            }

            // ── 工具调用 ─────────────────────────────────────────────────
            if (step.type === 'tool_start') {
              const isAskUser = step.toolName === 'ask_user'
              const toolDisplay = TOOL_NAME_MAP[step.toolName || ''] || step.toolName
              const isPending = step.success === undefined
              const isOk = step.success === true
              const isFail = step.success === false

              return (
                <div key={i} className={styles.tlItem}>
                  <div
                    className={styles.tlDot}
                    style={{ background: isFail ? '#f44336' : isOk ? '#4caf50' : '#f59e0b' }}
                  />
                  <div className={styles.tlContent}>
                    <div className={styles.tlTitle} style={{
                      color: isFail ? '#f44336' : isOk ? '#4caf50' : '#f59e0b',
                    }}>
                      {isFail ? '❌' : isOk ? '✅' : '🔧'} {toolDisplay}
                      {isPending && !isAskUser && (
                        <span className={styles.pendingDots}>
                          <span /><span /><span />
                        </span>
                      )}
                    </div>

                    {/* ask_user 交互卡片 */}
                    {isAskUser && step.toolArgs && (
                      <InteractiveCard
                        data={step.toolArgs}
                        disabled={!isLast || !isPending}
                        onReply={(content) =>
                          onToolReply?.(msgId, step.toolCallId ?? '', 'ask_user', content)
                        }
                      />
                    )}

                    {/* 普通工具输出预览 */}
                    {!isAskUser && step.outputPreview && (
                      <div className={styles.toolOutput}>{step.outputPreview}</div>
                    )}
                    {!isAskUser && step.toolArgs && !step.outputPreview && (
                      <div className={styles.toolArgs}>{JSON.stringify(step.toolArgs)}</div>
                    )}
                  </div>
                </div>
              )
            }

            if (step.type === 'tool_end' && step.outputPreview) {
              return (
                <div key={i} className={styles.tlItem}>
                  <div className={styles.tlDot} style={{ background: step.success ? '#4caf50' : '#f44336' }} />
                  <div className={styles.tlContent}>
                    <div className={styles.toolOutput}>{step.outputPreview}</div>
                  </div>
                </div>
              )
            }
            return null
          })}

          {/* 流式加载中 */}
          {isActive && (
            <div className={styles.tlItem}>
              <div className={styles.tlDot} style={{ background: '#007acc' }} />
              <div className={styles.tlContent}>
                <span className={styles.pendingDots} style={{ color: '#888' }}>
                  <span /><span /><span />
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── Props ────────────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  msg: Message
  isLast?: boolean
  isStreaming?: boolean
  sessionId?: string
  onRegenerate?: () => void
  onDelete?: (messageId: string) => Promise<void>
  onToolReply?: (msgId: string, toolCallId: string, toolName: string, content: string) => void
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

export const MessageBubble = memo(({ msg, isLast, isStreaming, sessionId = '', onRegenerate, onDelete, onToolReply }: MessageBubbleProps) => {
  const isUser = msg.role === 'user'
  const isError = msg.status === 'error'

  const textContent = extractText(msg.content)
  const images = extractImages(msg.content)
  const wsFiles = extractWorkspaceFiles(msg.content)

  const [lightboxVis, setLightboxVis] = useState(false)
  const [lightboxIdx, setLightboxIdx] = useState(0)
  const [showActs, setShowActs] = useState(false)
  const { copied: uCopied, copy: uCopy } = useCopyBtn()
  const { copied: aCopied, copy: aCopy } = useCopyBtn()
  const [showStats, setShowStats] = useState(false)

  // ── 用户消息 ──────────────────────────────────────────────────────────────

  if (isUser) {
    return (
      <div className={styles.userRow}>
        <div className={styles.userBubble} onClick={() => setShowActs((v) => !v)}>
          {wsFiles.map((f, i) => <FileCard key={i} name={f.name} fileType={f.fileType} />)}
          {images.length > 0 && (
            <div className={styles.imgGrid}>
              {images.map((img, i) => (
                <img key={i} src={img.url} alt={img.alt} className={styles.thumbImg}
                  onClick={(e) => { e.stopPropagation(); setLightboxIdx(i); setLightboxVis(true) }}
                />
              ))}
              <ImageViewer.Multi images={images.map((x) => x.url)} visible={lightboxVis}
                defaultIndex={lightboxIdx} onClose={() => setLightboxVis(false)} />
            </div>
          )}
          {textContent && <span>{textContent}</span>}
        </div>
        {showActs && (
          <div className={styles.actRow}>
            <button className={`${styles.actBtn} ${uCopied ? styles.actBtnDone : ''}`}
              onClick={(e) => { e.stopPropagation(); uCopy(textContent); setShowActs(false) }}>
              {uCopied ? '✓ 已复制' : <><ContentOutline /> 复制</>}
            </button>
            {onDelete && (
              <button
                className={`${styles.actBtn} ${styles.actBtnDanger}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (window.confirm('删除这轮对话？\n将删除该提问及其关联的 AI 思考与回答，操作不可撤销。')) {
                    await onDelete(msg.id);
                    setShowActs(false);
                  }
                }}
              >
                <DeleteOutline /> 删除
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── AI 消息 ───────────────────────────────────────────────────────────────

  const hasSteps = (msg.thinkingSteps?.length ?? 0) > 0
  const hasText = textContent.length > 0

  return (
    <div className={styles.aiRow}>
      <div className={styles.aiContent}>
        {/* 思考面板 */}
        {(hasSteps || isStreaming) && (
          <ThinkingPanel
            steps={msg.thinkingSteps ?? []}
            isActive={isStreaming}
            msgId={msg.id}
            isLast={isLast}
            onToolReply={onToolReply}
          />
        )}

        {/* 主回复内容 */}
        {(hasText || (!isStreaming && !hasSteps)) && (
          <div className={`${styles.aiBubble} ${isError ? styles.aiBubbleErr : ''}`}>
            {isStreaming && !hasText
              ? <span className={styles.cursor} />
              : (
                <div className={styles.md}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeRaw, rehypeHighlight]}
                    components={{
                      code({ node, className, children, ...props }: any) {
                        if (/language-/.test(className || ''))
                          return <CodeBlock className={className}>{children}</CodeBlock>
                        return <code className={styles.ic} {...props}>{children}</code>
                      },
                      img({ src, alt }: any) {
                        return <img src={src} alt={alt} className={styles.mdImg} loading="lazy"
                          onClick={() => { if (src) { setLightboxIdx(0); setLightboxVis(true) } }} />
                      },
                      a({ href, children }: any) {
                        const parsed = parseDownloadHref(href ?? '', sessionId)
                        if (parsed) {
                          return (
                            <a
                              href={parsed.downloadUrl}
                              className={`${styles.mdLink} ${styles.mdLinkDownload}`}
                              onClick={(e) => {
                                e.preventDefault()
                                triggerDownload(parsed.downloadUrl, parsed.filename)
                              }}
                            >
                              ⬇️ {children}
                            </a>
                          )
                        }
                        // 普通外部链接 → 新标签打开
                        return <a href={href} target="_blank" rel="noreferrer" className={styles.mdLink}>{children}</a>
                      },
                    }}
                  >{textContent}</ReactMarkdown>
                </div>
              )
            }
            {isStreaming && hasText && <span className={styles.cursor} />}
          </div>
        )}

        {/* 底部操作按钮 */}
        {!isStreaming && (hasText || hasSteps) && (
          <div className={styles.aiActs}>
            {msg.usage && (
              <button className={styles.tokenBtn} onClick={() => setShowStats(true)}>
                ⚡ {fmtTokenTotal(msg.usage.totalTokens)}
              </button>
            )}
            {hasText && (
              <button className={`${styles.actBtn} ${aCopied ? styles.actBtnDone : ''}`} onClick={() => aCopy(textContent)}>
                {aCopied ? '✓ 已复制' : <><ContentOutline /> 复制</>}
              </button>
            )}
            {onRegenerate && (
              <button className={styles.actBtn} onClick={onRegenerate}>
                <RedoOutline /> 重新生成
              </button>
            )}
            {onDelete && (
              <button
                className={`${styles.actBtn} ${styles.actBtnDanger}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (window.confirm('删除这轮对话？\n将删除该回答及其关联的提问与思考过程，操作不可撤销。')) {
                    await onDelete(msg.id);
                  }
                }}
              >
                <DeleteOutline /> 删除
              </button>
            )}
          </div>
        )}
      </div>

      {msg.usage && (
        <TokenStatsPopup
          visible={showStats}
          onClose={() => setShowStats(false)}
          usage={msg.usage}
          modelId={msg.modelId}
        />
      )}
    </div>
  )
})
