import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  useLayoutEffect,
  useMemo,
  memo,
} from "react";
import { TodoPanel } from './TodoPanel';
import { Button, Tooltip, Popconfirm, Input, Select, Switch, message, Modal, Image } from "antd";
import {
  SendOutlined,
  ReloadOutlined,
  DeleteOutlined,
  CopyOutlined,
  CheckOutlined,
  EditOutlined,
  RobotOutlined,
  UserOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  ClearOutlined,
  LoadingOutlined,
  CheckCircleFilled,
  WarningFilled,
  BulbOutlined,
  ToolOutlined,
  CloseCircleOutlined,
  UpOutlined,
  DownOutlined,
  PaperClipOutlined,
  FileOutlined,
  FileImageOutlined,
  CloseOutlined,
  FileTextOutlined,
  DownloadOutlined,
  SettingOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { useSessionStore } from '@core/store/session';
import { useAgentStore } from '@core/store/agents';
import { useChat } from '@web/hooks/useChat';
import { modelsApi, settingsApi, workspaceApi } from '@core/api';
import type { Message, TokenUsage, ThinkingStep } from '@core/types';
import styles from "./ChatArea.module.css";
import dayjs from "dayjs";
import rehypeRaw from "rehype-raw";

// ── Interactive AskUser Card ──────────────────────────────────────────────────
function InteractiveCard({
  data,
  onReply,
  disabled,
}: {
  data: any;
  onReply: (msg: string) => void;
  disabled?: boolean;
}) {
  const { question, multiSelect } = data;
  // 安全解析 options：可能是 JSON 字符串，也可能直接是数组
  let options: any[] = [];
  try {
    if (Array.isArray(data.options)) {
      options = data.options;
    } else if (typeof data.options === "string") {
      const parsed = JSON.parse(data.options);
      options = Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    options = [];
  }
  const [selected, setSelected] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");
  const [isOther, setIsOther] = useState(false);

  const handleToggle = (label: string) => {
    if (multiSelect) {
      setSelected((prev) =>
        prev.includes(label)
          ? prev.filter((l) => l !== label)
          : [...prev, label],
      );
    } else {
      setSelected([label]);
      setIsOther(false);
    }
  };

  const handleSubmit = () => {
    const finalAnswers = [...selected];
    if (isOther && otherText.trim()) {
      finalAnswers.push(otherText.trim());
    }
    if (finalAnswers.length > 0) {
      onReply(finalAnswers.join("，"));
    }
  };

  return (
    <div
      style={{
        marginTop: 12,
        padding: 16,
        background: "#161b22",
        border: "1px solid #30363d",
        borderRadius: 8,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 12, color: "#e6edf3" }}>
        🤔 {question}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {options?.map((opt: any, idx: number) => (
          <div
            key={idx}
            onClick={() => !disabled && handleToggle(opt.label)}
            style={{
              padding: "8px 12px",
              border: `1px solid ${selected.includes(opt.label) ? "#2f81f7" : "#30363d"}`,
              borderRadius: 6,
              background: selected.includes(opt.label)
                ? "rgba(47,129,247,0.1)"
                : "transparent",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <div
              style={{
                fontWeight: 500,
                color: selected.includes(opt.label) ? "#58a6ff" : "#e6edf3",
              }}
            >
              {opt.label}
            </div>
            {opt.description && (
              <div style={{ fontSize: 12, color: "#8b949e", marginTop: 4 }}>
                {opt.description}
              </div>
            )}
          </div>
        ))}

        {/* Other option */}
        <div
          onClick={() =>
            !disabled &&
            (multiSelect
              ? setIsOther(!isOther)
              : [setSelected([]), setIsOther(true)])
          }
          style={{
            padding: "8px 12px",
            border: `1px solid ${isOther ? "#2f81f7" : "#30363d"}`,
            borderRadius: 6,
            background: isOther ? "rgba(47,129,247,0.1)" : "transparent",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <div
            style={{ fontWeight: 500, color: isOther ? "#58a6ff" : "#e6edf3" }}
          >
            其他
          </div>
          {isOther && (
            <Input
              autoFocus
              size="small"
              placeholder="请输入您的自定义需求..."
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              style={{
                marginTop: 8,
                background: "#0d1117",
                color: "#fff",
                borderColor: "#30363d",
              }}
              disabled={disabled}
            />
          )}
        </div>
      </div>
      <div
        style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}
      >
        <Button
          type="primary"
          size="small"
          onClick={handleSubmit}
          disabled={
            disabled ||
            (selected.length === 0 && (!isOther || !otherText.trim()))
          }
        >
          提交回复
        </Button>
      </div>
    </div>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? "已复制" : "复制"}>
      <Button
        type="text"
        size="small"
        icon={
          copied ? (
            <CheckOutlined style={{ color: "#3fb950" }} />
          ) : (
            <CopyOutlined />
          )
        }
        className={styles.iconBtn}
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      />
    </Tooltip>
  );
}

// ── Token meta ─────────────────────────────────────────────────────────────────
const TOKEN_META = [
  // ── 按消耗权重排序：History → Prompts → Tools → Output ──
  {
    key: "messagesTokens" as keyof TokenUsage,
    color: "#38bdf8",
    label: "历史消息",
  },
  {
    key: "systemPromptTokens" as keyof TokenUsage,
    color: "#818cf8",
    label: "系统提示词",
  },
  {
    key: "skillTokens" as keyof TokenUsage,
    color: "#c084fc",
    label: "技能 Prompt",
  },
  {
    key: "ragTokens" as keyof TokenUsage,
    color: "#34d399",
    label: "知识库(RAG)",
  },
  {
    key: "mcpToolsTokens" as keyof TokenUsage,
    color: "#f97316",
    label: "MCP 工具",
  },
  {
    key: "builtinToolsTokens" as keyof TokenUsage,
    color: "#fbbf24",
    label: "内置工具",
  },
  {
    key: "toolResultsTokens" as keyof TokenUsage,
    color: "#a78bfa",
    label: "工具调用结果",
  },
  {
    key: "completionTokens" as keyof TokenUsage,
    color: "#fb7185",
    label: "生成内容",
  },
];

// ── DeepSeek KV Cache 指标（独立展示，因不属于 Prompt 分项加权）─────
const DEEPSEEK_CACHE_META = [
  {
    key: "cacheHitTokens" as keyof TokenUsage,
    color: "#10b981",
    label: "KV Cache 命中",
    hint: "命中部分计费仅 0.1元/百万",
  },
  {
    key: "cacheMissTokens" as keyof TokenUsage,
    color: "#f59e0b",
    label: "KV Cache 未命中",
    hint: "按正常输入价计费",
  },
];

function fmtToken(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n ?? 0);
}

// ── File info module-level cache（避免同一文件重复请求 API）────────────────
const fileInfoCache = new Map<string, any>()

// ── File Card Component ──────────────────────────────────────────────────────
function FileCard({ file, onCopyPath }: { file: any, onCopyPath: (path: string) => void }) {
  const { activeSessionId } = useSessionStore();
  const [isDownloading, setIsDownloading] = useState(false);
  const [fileInfo, setFileInfo] = useState<any>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);

  // 获取文件元数据（带模块级缓存，避免重复请求）
  useEffect(() => {
    const cacheKey = `${activeSessionId}:${file.name}`
    if (fileInfoCache.has(cacheKey)) {
      setFileInfo(fileInfoCache.get(cacheKey))
      return
    }
    const loadFileInfo = async () => {
      try {
        setIsLoadingInfo(true);
        const info = await workspaceApi.getFileInfo(activeSessionId, file.name);
        fileInfoCache.set(cacheKey, info)
        setFileInfo(info);
      } catch (err) {
        // 静默失败，继续使用默认显示
        console.error('Failed to load file info:', err);
      } finally {
        setIsLoadingInfo(false);
      }
    };

    loadFileInfo();
  }, [file.name, activeSessionId]);

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // 获取文件图标
  const getFileIcon = (ext?: string, isImage?: boolean) => {
    if (isImage) return <FileImageOutlined style={{ fontSize: 24, color: '#a855f7' }} />;
    return <FileTextOutlined style={{ fontSize: 24, color: '#0e639c' }} />;
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const data = await workspaceApi.getFileContent(activeSessionId, file.name);
      if (!data) throw new Error('未获取到文件内容');

      const { content, isBinary } = data;
      let blob;

      if (isBinary) {
        const byteCharacters = atob(content);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        blob = new Blob([byteArray], { type: file.type || 'application/octet-stream' });
      } else {
        blob = new Blob([content], { type: file.type || 'text/plain' });
      }

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      message.success(`已开始下载：${file.name}`);
    } catch (err: any) {
      message.error(`下载失败：${err.message}`);
    } finally {
      setIsDownloading(false);
    }
  };

  // 处理图片链接点击
  const handleImageLinkClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (fileInfo?.workspacePath) {
      // 尝试用 file:// 协议打开
      window.open(`file://${fileInfo.workspacePath}`, '_blank');
    }
  };

  const displayInfo = fileInfo || {
    name: file.name,
    type: file.type || '文件',
    size: file.size || 0,
    isImage: false,
    mtime: Date.now()
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '12px 14px',
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: 8,
      marginTop: 8,
      maxWidth: 420,
      transition: 'border-color 0.2s, box-shadow 0.2s'
    }} onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = '#58a6ff';
      e.currentTarget.style.boxShadow = '0 0 0 1px rgba(88, 166, 255, 0.15)';
    }} onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = '#30363d';
      e.currentTarget.style.boxShadow = 'none';
    }}>
      {/* 上半部分：文件名和图标 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {isLoadingInfo ? (
          <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LoadingOutlined style={{ fontSize: 16, color: '#8b949e' }} />
          </div>
        ) : (
          getFileIcon(displayInfo.type, displayInfo.isImage)
        )}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#e6edf3',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            {displayInfo.name}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e' }}>
            {displayInfo.type}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <Tooltip title="下载">
            <Button
              type="text"
              size="small"
              loading={isDownloading}
              icon={<DownloadOutlined />}
              onClick={handleDownload}
              style={{ color: '#8b949e' }}
            />
          </Tooltip>
          <Tooltip title="复制文件名">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => onCopyPath(file.name)}
              style={{ color: '#8b949e' }}
            />
          </Tooltip>
        </div>
      </div>

      {/* 下半部分：元数据 */}
      {!isLoadingInfo && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          paddingTop: 4,
          borderTop: '1px solid #21262d'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#8b949e' }}>
            <FileTextOutlined style={{ fontSize: 12 }} />
            <span>{formatFileSize(displayInfo.size)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#8b949e' }}>
            <ClockCircleOutlined style={{ fontSize: 12 }} />
            <span>{formatTime(displayInfo.mtime)}</span>
          </div>

          {/* 图片文件特殊处理：显示工作区地址链接 */}
          {displayInfo.isImage && displayInfo.workspacePath && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: '#58a6ff',
              cursor: 'pointer',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden'
            }} onClick={handleImageLinkClick}>
              <LinkOutlined style={{ fontSize: 12 }} />
              <span style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textDecoration: 'underline'
              }}>
                {displayInfo.workspacePath}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Token badge ────────────────────────────────────────────────────────────────
function TokenDetailsContent({
  usage,
  durationMs,
  title = "Token 详情",
  modelId,
}: {
  usage: TokenUsage;
  durationMs?: number;
  title?: string;
  modelId?: string;
}) {
  // 从 store 读取 DeepSeek 有效价格（拉取失败则为 null，不显示估算）
  const deepseekPrices = useSessionStore((s) => s.deepseekEffectivePrices);

  /** 根据模型 ID 获取当前有效的 cacheHit 差价（元/M），用于节省估算 */
  const getCacheHitSavings = (hit: number): { savedYuan: number; priceDiff: number } | null => {
    if (!modelId) return null;
    // 前缀匹配（如 deepseek-chat-0324 → deepseek-chat）
    const entry =
      deepseekPrices[modelId] ??
      Object.entries(deepseekPrices).find(([k]) => modelId.startsWith(k))?.[1];
    if (!entry) return null;
    // normalCacheHit 需要从未折扣状态推导，此处取 entry 里的 cacheHit 作为有效价
    // 差价 = 原价（0.5/1元/M） - 有效价（0.1元/M）
    // 由于 store 只存有效价，差价需要额外知道原价；
    // 退而求其次：仅在折扣中时显示节省（差价 = 当前有效 cacheHit，与原价对比需从 API 重取）
    // 此处保留: 若 isDiscounted=true 则计算节省，否则显示"无折扣"
    if (!entry.isDiscounted) return null;
    // 原价 cacheHit 近似：deepseek-chat=0.5，deepseek-reasoner=1
    const normalCacheHit = modelId.includes('reasoner') ? 1 : 0.5;
    const priceDiff = normalCacheHit - entry.cacheHit;
    if (priceDiff <= 0) return null;
    return { savedYuan: (hit / 1_000_000) * priceDiff, priceDiff };
  };

  return (
    <div style={{ width: 220, fontSize: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 8, color: "#e6edf3" }}>
        ⚡ {title}{" "}
        {durationMs != null && (
          <span style={{ fontSize: 11, color: "#3fb950", marginLeft: 8 }}>
            {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      {/* Bar */}
      <div
        style={{
          height: 5,
          display: "flex",
          gap: 1,
          borderRadius: 3,
          overflow: "hidden",
          background: "#0d1117",
          marginBottom: 10,
        }}
      >
        {TOKEN_META.map((m) => {
          const v = (usage[m.key] as number) ?? 0;
          const total = usage.totalTokens || 1;
          return v > 0 ? (
            <div
              key={m.key}
              style={{ width: `${(v / total) * 100}%`, background: m.color }}
            />
          ) : null;
        })}
      </div>
      {TOKEN_META.map((m) => {
        const v = (usage[m.key] as number) ?? 0;
        return (
          <div
            key={m.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 4,
              fontSize: 11,
            }}
          >
            <span
              style={{
                color: "#8b949e",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: m.color,
                  display: "inline-block",
                }}
              />
              {m.label}
            </span>
            <span style={{ color: "#e6edf3", fontWeight: 600 }}>
              {fmtToken(v)}
            </span>
          </div>
        );
      })}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          paddingTop: 8,
          marginTop: 4,
          borderTop: "1px solid #21262d",
          fontSize: 11,
        }}
      >
        <span style={{ color: "#8b949e" }}>输入 (Prompt)</span>
        <span style={{ color: "#e6edf3", fontWeight: 600 }}>
          {fmtToken(usage.promptTokens ?? 0)}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          paddingTop: 4,
          fontSize: 11,
        }}
      >
        <span style={{ color: "#8b949e" }}>输出 (Completion)</span>
        <span style={{ color: "#e6edf3", fontWeight: 600 }}>
          {fmtToken(usage.completionTokens ?? 0)}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          paddingTop: 4,
          fontWeight: 700,
          fontSize: 12,
        }}
      >
        <span style={{ color: "#8b949e" }}>总计</span>
        <span style={{ color: "#3fb950" }}>{fmtToken(usage.totalTokens)}</span>
      </div>
      {/* ── DeepSeek 专有指标面板（仅当存在 KV Cache 命中或推理 token 时显示）── */}
      {((usage.cacheHitTokens ?? 0) > 0 || (usage.reasoningTokens ?? 0) > 0) && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px dashed #21262d",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#10b981",
              marginBottom: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 13 }}>🐋</span> DeepSeek 专有
          </div>
          {DEEPSEEK_CACHE_META.map((m) => {
            const v = (usage[m.key] as number) ?? 0;
            if (v <= 0) return null;
            return (
              <div
                key={m.key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 4,
                  fontSize: 11,
                }}
              >
                <span
                  style={{
                    color: "#8b949e",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                  title={m.hint}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: m.color,
                      display: "inline-block",
                    }}
                  />
                  {m.label}
                </span>
                <span style={{ color: "#e6edf3", fontWeight: 600 }}>
                  {fmtToken(v)}
                </span>
              </div>
            );
          })}
          {/* KV Cache 命中率与节省金额估算 */}
          {(usage.cacheHitTokens ?? 0) > 0 && (usage.promptTokens ?? 0) > 0 && (() => {
            const hit = usage.cacheHitTokens ?? 0;
            const prompt = usage.promptTokens ?? 1;
            const ratio = (hit / prompt) * 100;
            const savings = getCacheHitSavings(hit);
            return (
              <div
                style={{
                  marginTop: 6,
                  padding: "5px 8px",
                  background: "rgba(16,185,129,0.08)",
                  border: "1px solid rgba(16,185,129,0.25)",
                  borderRadius: 5,
                  fontSize: 11,
                  color: "#10b981",
                  lineHeight: 1.5,
                }}
              >
                💰 命中率 <strong>{ratio.toFixed(1)}%</strong>
                {savings != null && (
                  <>，节省约<strong> ¥{savings.savedYuan.toFixed(5)}</strong></>
                )}
              </div>
            );
          })()}
          {(usage.reasoningTokens ?? 0) > 0 && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 4,
                fontSize: 11,
              }}
            >
              <span
                style={{
                  color: "#8b949e",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
                title="R1/V3 thinking 模式 reasoning_content 实际消耗的 token"
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: "#22d3ee",
                    display: "inline-block",
                  }}
                />
                推理 Tokens
              </span>
              <span style={{ color: "#22d3ee", fontWeight: 600 }}>
                {fmtToken(usage.reasoningTokens ?? 0)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TokenBadge({
  usage,
  durationMs,
}: {
  usage: TokenUsage;
  durationMs?: number;
}) {
  return (
    <Tooltip
      style={{ width: 260 }}
      title={<TokenDetailsContent usage={usage} durationMs={durationMs} />}
      styles={{
        container: {
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          padding: "10px 14px",
        },
      }}
      arrow={false}
    >
      <span className={styles.tokenBadge}>
        <ThunderboltOutlined style={{ fontSize: 10 }} />
        {fmtToken(usage.totalTokens)}
      </span>
    </Tooltip>
  );
}

// ── Thinking steps ─────────────────────────────────────────────────────────────
const TOOL_NAME_MAP: Record<string, string> = {
  ask_user: "询问用户",
  read_file: "读取文件",
  write_file: "写入文件",
  list_files: "列出文件",
  delete_file: "删除文件",
  create_dir: "创建目录",
  execute_cmd: "执行命令",
  remember: "记录记忆",
  recall: "回忆记忆",
  list_memories: "列出记忆",
  forget: "遗忘记忆",
  list_skills: "列出技能",
  get_skill: "获取技能",
  run_skill_script: "运行脚本",
  get_time: "获取时间",
  search_files: "搜索文件",
  read_url: "读取网页",
  get_weather: "获取天气",
};

function ThinkingPanelInner({
  msgId,
  steps,
  isActive,
  onToolReply,
  isLast,
}: {
  msgId: string;
  steps: ThinkingStep[];
  isActive?: boolean;
  onToolReply?: (
    msgId: string,
    toolCallId: string,
    toolName: string,
    content: string,
  ) => void;
  isLast?: boolean;
}) {
  const { files, setActiveFile } = useSessionStore();
  const [expanded, setExpanded] = useState(isActive ?? false);

  // O(1) 文件查找（ThinkingPanel 内也可能渲染文件链接）
  const filesBaseMapInner = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of files) {
      const base = f.substring(f.lastIndexOf('/') + 1)
      if (!m.has(base)) m.set(base, f)
    }
    return m
  }, [files])
  const filesSetInner = useMemo(() => new Set(files), [files])

  const needsUserInput = steps.some(
    (s) =>
      s.type === "tool_start" &&
      s.toolName === "ask_user" &&
      s.success === undefined,
  );

  // 当会话进入活动状态（正在思考/处理）时，默认展开；完成后自动收起
  // 如果需要用户交互（如 ask_user 未完成），也强制保持展开
  useEffect(() => {
    if (needsUserInput) {
      setExpanded(true);
    } else {
      setExpanded(isActive ?? false);
    }
  }, [isActive, needsUserInput]);

  const toolCount = steps.filter((s) => s.type === "tool_start").length;
  const toolNames = Array.from(
    new Set(
      steps
        .filter((s) => s.type === "tool_start")
        .map((s) => TOOL_NAME_MAP[s.toolName || ""] || s.toolName),
    ),
  );
  const hasFailure = steps.some(
    (s) => s.type === "tool_end" && s.success === false,
  );

  const renderTextWithFiles = (text: string) => {
    if (!text) return null;
    // 简单的文件名匹配逻辑：寻找可能是文件名的部分
    // 这里我们遍历已知的 files，如果在 text 中匹配到了，就渲染为链接
    // 为了简单起见，我们只处理全匹配或者被空格/标点包裹的情况

    // 如果 text 直接就是一个文件名
    const trimmed = text.trim();
    const foundFull = filesSetInner.has(trimmed) ? trimmed : filesBaseMapInner.get(trimmed);
    if (foundFull) {
      return (
        <span
          className={styles.fileLink}
          onClick={(e) => {
            e.stopPropagation();
            setActiveFile(foundFull);
          }}
        >
          {text}
        </span>
      );
    }

    return text;
  };

  if (steps.length === 0 && !isActive) return null;

  return (
    <div className={styles.thinkingPanel}>
      <div
        className={styles.thinkingHeader}
        onClick={() => setExpanded(!expanded)}
      >
        <div className={styles.thinkingHeaderLeft}>
          {isActive ? (
            <LoadingOutlined className={styles.thinkingActiveIcon} />
          ) : hasFailure ? (
            <WarningFilled style={{ color: "#f78166" }} />
          ) : (
            <CheckCircleFilled style={{ color: "#3fb950" }} />
          )}
          <span className={styles.thinkingLabel}>
            {isActive
              ? "正在思考..."
              : toolCount > 0
                ? `调用了 ${toolCount} 次工具：${toolNames.join("、")}`
                : "推理完成"}
          </span>
        </div>
        <div className={styles.thinkingHeaderRight}>
          <span className={styles.thinkingToggleLabel}>
            {expanded ? "收起" : "展开"}
          </span>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </div>
      </div>
      {expanded && (
        <div className={styles.thinkingBody}>
          <div className={styles.timelineContainer}>
            {steps.map((step, i) => {
              if (step.type === "thinking")
                return (
                  <div key={i} className={styles.timelineItem}>
                    <div className={styles.timelineIcon}>
                      <BulbOutlined style={{ color: "#a855f7" }} />
                    </div>
                    <div className={styles.timelineContent}>
                      <div
                        className={styles.timelineTitle}
                        style={{ color: "#a855f7" }}
                      >
                        思考
                      </div>
                      <div className={styles.thinkTextWrapper}>
                        <div className={styles.thinkText}>{step.text}</div>
                      </div>
                    </div>
                  </div>
                );
              if (step.type === "tool_start") {
                const isAskUser = step.toolName === "ask_user";
                const toolNameDisplay =
                  TOOL_NAME_MAP[step.toolName || ""] || step.toolName;

                return (
                  <div key={i} className={styles.timelineItem}>
                    <div className={styles.timelineIcon}>
                      {step.success === true ? (
                        <CheckCircleFilled
                          className={styles.resultSuccessIcon}
                        />
                      ) : step.success === false ? (
                        <CloseCircleOutlined
                          className={styles.resultErrorIcon}
                        />
                      ) : (
                        <ToolOutlined className={styles.toolIcon} />
                      )}
                    </div>
                    <div className={styles.timelineContent}>
                      <div
                        className={styles.timelineTitle}
                        style={{
                          color:
                            step.success === false
                              ? "#f78166"
                              : step.success === true
                                ? "#3fb950"
                                : "#d29922",
                        }}
                      >
                        {toolNameDisplay}
                      </div>

                      {isAskUser && step.toolArgs ? (
                        <div className={styles.toolDetails}>
                          {!step.success ? (
                            <InteractiveCard
                              data={step.toolArgs}
                              onReply={(content) =>
                                onToolReply?.(
                                  msgId,
                                  step.toolCallId ?? "",
                                  "ask_user",
                                  content,
                                )
                              }
                              disabled={!isLast}
                            />
                          ) : (
                            <div className={styles.askUserResult}>
                              <div
                                style={{ color: "#c9d1d9", marginBottom: 6 }}
                              >
                                <strong style={{ color: "#8b949e" }}>
                                  提问：
                                </strong>
                                {String(step.toolArgs.question || "")}
                              </div>
                              <div style={{ color: "#58a6ff" }}>
                                <strong style={{ color: "#8b949e" }}>
                                  用户回复：
                                </strong>
                                {step.outputPreview?.replace(
                                  "用户选择了: ",
                                  "",
                                )}
                              </div>
                            </div>
                          )}
                          <div className={styles.toolArgsRaw}>
                            {JSON.stringify(step.toolArgs)}
                          </div>
                        </div>
                      ) : (
                        <div className={styles.toolDetails}>
                          {step.toolArgs && (
                            <div className={styles.toolArgsRaw}>
                              {JSON.stringify(step.toolArgs)}
                            </div>
                          )}
                          {step.outputPreview && (
                            <div className={styles.toolResultCompact}>
                              <span className={styles.resultText}>
                                {renderTextWithFiles(step.outputPreview)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              if (step.type === "tool_end") {
                // If outputPreview is already rendered in tool_start, we might skip it here,
                // but if we need to show standalone tool_end, we can render it.
                // To avoid duplication, we check if we already handled it.
                if (!step.outputPreview) return null;
                return (
                  <div key={i} className={styles.timelineItem}>
                    <div className={styles.timelineIcon}>
                      {step.success ? (
                        <CheckCircleFilled
                          className={styles.resultSuccessIcon}
                        />
                      ) : (
                        <CloseCircleOutlined
                          className={styles.resultErrorIcon}
                        />
                      )}
                    </div>
                    <div className={styles.timelineContent}>
                      <div
                        className={styles.toolResultCompact}
                        style={{ marginTop: 0 }}
                      >
                        <span
                          className={styles.resultText}
                          style={{
                            color: step.success ? "#8b949e" : "#f78166",
                            marginLeft: 0,
                          }}
                        >
                          {renderTextWithFiles(step.outputPreview || "")}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })}
            {isActive && (
              <div className={styles.timelineItem}>
                <div className={styles.timelineIcon}>
                  <LoadingOutlined style={{ color: "#484f58" }} />
                </div>
                <div className={styles.timelineContent}>
                  <div className={styles.thinkingLoading}>
                    Agent 正在处理...
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const ThinkingPanel = memo(ThinkingPanelInner)

// ── Welcome screen ─────────────────────────────────────────────────────────────
const WELCOME_PROMPTS = [
  {
    key: "search",
    emoji: "🔍",
    label: "网络搜索",
    desc: "搜索最新资讯和信息",
    msg: "帮我搜索一下最新的 AI 行业新闻",
  },
  {
    key: "write",
    emoji: "✍️",
    label: "写作助手",
    desc: "帮你撰写各类文档",
    msg: "帮我写一篇关于人工智能的产品介绍文案",
  },
  {
    key: "idea",
    emoji: "💡",
    label: "头脑风暴",
    desc: "激发创意与想法",
    msg: "帮我想 5 个有创意的 SaaS 产品方向",
  },
  {
    key: "analyze",
    emoji: "📊",
    label: "数据分析",
    desc: "分析处理各类数据",
    msg: "帮我分析一份销售数据，并给出优化建议",
  },
];

function WelcomeScreen({
  onPrompt,
  agentName,
}: {
  onPrompt: (msg: string) => void;
  agentName?: string;
}) {
  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeIcon}>
        {agentName ? <RobotOutlined /> : "🤖"}
      </div>
      <h2 className={styles.welcomeTitle}>
        {agentName ? `你好，我是 ${agentName}` : "你好，有什么可以帮你？"}
      </h2>
      <p className={styles.welcomeSub}>
        基于 Agent Engine 驱动，支持工具调用、知识库检索、多工作区绑定及附件处理
      </p>
      <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 24, display: "flex", gap: 16, justifyContent: "center" }}>
        <span>📎 支持所有文件格式上传</span>
        <span>🖱️ 支持拖拽或粘贴附件</span>
        <span>📂 支持绑定多个本地工作区</span>
      </div>
      <div className={styles.promptGrid}>
        {WELCOME_PROMPTS.map((p) => (
          <div
            key={p.key}
            className={styles.promptCard}
            onClick={() => onPrompt(p.msg)}
          >
            <span className={styles.promptEmoji}>{p.emoji}</span>
            <span className={styles.promptLabel}>{p.label}</span>
            <span className={styles.promptDesc}>{p.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Message item ───────────────────────────────────────────────────────────────
function MessageItemInner({
  msg,
  isLast,
  onRegenerate,
  onEdit,
  onToolReply,
  onDelete,
}: {
  msg: Message;
  isLast?: boolean;
  onRegenerate?: () => void;
  onEdit?: (msgId: string, newContent: string) => void;
  onToolReply?: (
    msgId: string,
    toolCallId: string,
    toolName: string,
    content: string,
  ) => void;
  onDelete?: (messageId: string) => void | Promise<void>;
}) {
  const {
    activeSessionId,
    deleteMessage,
    files,
    setActiveFile,
  } = useSessionStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const isUser = msg.role === "user";
  const isStreaming = msg.status === "streaming";

  const timeStr = dayjs(msg.createdAt).format("YYYY-MM-DD HH:mm:ss");

  // ── O(1) 文件查找结构：只在 files 数组变化时重建 ──────────────────────────
  const filesSet = useMemo(() => new Set(files), [files])
  // basename → fullPath 映射（e.g. "index.ts" → "src/index.ts"）
  const filesBaseMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of files) {
      const base = f.substring(f.lastIndexOf('/') + 1)
      if (!m.has(base)) m.set(base, f) // 取第一个匹配
    }
    return m
  }, [files])

  const findFile = useCallback((content: string): string | undefined => {
    if (filesSet.has(content)) return content
    return filesBaseMap.get(content)
  }, [filesSet, filesBaseMap])

  const getMessageText = (content: string | any[]): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    }
    return "";
  };

  const startEdit = () => {
    setDraft(getMessageText(msg.content));
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);
  const confirmEdit = () => {
    const text = getMessageText(msg.content);
    if (draft.trim() && draft !== text) onEdit?.(msg.id, draft.trim());
    setEditing(false);
  };

  const handleCopyPath = (fileName: string) => {
    navigator.clipboard.writeText(fileName);
    message.success("路径已复制到剪贴板");
  };

  // ── markdownComponents：用 useMemo 缓存，避免每次渲染重建导致 ReactMarkdown 强制重新 parse
  const markdownComponents = useMemo(() => ({
    code({ node, className, children, ...props }: any) {
      const isBlock = className?.includes("language-");
      const content = String(children).trim();
      const fullPath = !isBlock ? findFile(content) : undefined
      const isFilePath = Boolean(fullPath)

      if (isBlock) {
        return (
          <div className={styles.codeBlock}>
            <div className={styles.codeHeader}>
              <span className={styles.codeLang}>
                {className?.replace("language-", "") ?? "code"}
              </span>
              <CopyBtn text={String(children)} />
            </div>
            <code className={className} {...props}>
              {children}
            </code>
          </div>
        );
      }

      return (
        <code
          className={
            isFilePath
              ? `${styles.inlineCode} ${styles.fileLink}`
              : styles.inlineCode
          }
          onClick={() => {
            if (isFilePath && fullPath) setActiveFile(fullPath)
          }}
          {...props}
        >
          {children}
        </code>
      );
    },
    td({ node, children, ...props }: any) {
      const content = String(children).trim();
      const fullPath = findFile(content)
      if (fullPath) {
        return (
          <td {...props}>
            <span
              className={styles.fileLink}
              onClick={() => setActiveFile(fullPath)}
            >
              {children}
            </span>
          </td>
        );
      }
      return <td {...props}>{children}</td>;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [findFile, setActiveFile])

  const renderContent = () => {
    if (typeof msg.content === "string") {
      return isUser ? (
        <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
          components={markdownComponents}
        >
          {msg.content || (isStreaming ? "▌" : "")}
        </ReactMarkdown>
      );
    }

    if (Array.isArray(msg.content)) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {msg.content.map((item, i) => {
            if (item.type === "text") {
              return isUser ? (
                <span key={i} style={{ whiteSpace: "pre-wrap" }}>
                  {item.text}
                </span>
              ) : (
                <ReactMarkdown
                  key={i}
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
                  components={markdownComponents}
                >
                  {item.text}
                </ReactMarkdown>
              );
            }
            if (item.type === "image_url") {
              return (
                <div key={i} style={{ marginTop: 4 }}>
                  <img
                    src={item.image_url.url}
                    alt="attachment"
                    style={{
                      maxWidth: "100%",
                      maxHeight: 400,
                      borderRadius: 4,
                      border: "1px solid #30363d",
                      cursor: "zoom-in",
                    }}
                    onClick={() => window.open(item.image_url.url, "_blank")}
                  />
                  {item.metadata?.name && (
                    <div style={{ fontSize: 11, color: '#8b949e', marginTop: 4 }}>
                      {item.metadata.name}
                    </div>
                  )}
                </div>
              );
            }
            if (item.type === "workspace_image") {
              return (
                <div key={i} style={{ marginTop: 4 }}>
                  <img
                    src={item.url}
                    alt={item.name}
                    style={{
                      maxWidth: "100%",
                      maxHeight: 400,
                      borderRadius: 4,
                      border: "1px solid #30363d",
                      cursor: "zoom-in",
                    }}
                    onClick={() => window.open(item.url, "_blank")}
                  />
                  <div style={{ fontSize: 11, color: '#8b949e', marginTop: 4 }}>
                    {item.name}
                  </div>
                </div>
              );
            }
            if (item.type === "file") {
              return (
                <FileCard
                  key={i}
                  file={item.file}
                  onCopyPath={handleCopyPath}
                />
              );
            }
            if (item.type === "workspace_file") {
              return (
                <FileCard
                  key={i}
                  file={{ name: item.name, type: item.fileType || "文件" }}
                  onCopyPath={handleCopyPath}
                />
              );
            }
            return null;
          })}
          {!isUser && isStreaming && <span>▌</span>}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className={`${styles.msgRow} ${isUser ? styles.userRow : styles.aiRow}`}
    >
      {/* Avatar */}
      <div
        className={`${styles.avatar} ${isUser ? styles.userAvatar : styles.aiAvatar}`}
      >
        {isUser ? <UserOutlined /> : <RobotOutlined />}
      </div>

      {/* Bubble */}
      <div className={styles.bubble}>
        {/* Thinking panel (AI only) */}
        {!isUser && (msg.thinkingSteps?.length ?? 0) > 0 && (
          <ThinkingPanel
            msgId={msg.id}
            steps={msg.thinkingSteps!}
            isActive={isStreaming}
            onToolReply={onToolReply}
            isLast={isLast}
          />
        )}
        {!isUser && isStreaming && (msg.thinkingSteps?.length ?? 0) === 0 && (
          <ThinkingPanel msgId={msg.id} steps={[]} isActive />
        )}

        {/* Content */}
        {editing ? (
          <div className={styles.editArea}>
            <Input.TextArea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 10 }}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  confirmEdit();
                }
                if (e.key === "Escape") cancelEdit();
              }}
            />
            <div
              style={{
                display: "flex",
                gap: 6,
                justifyContent: "flex-end",
                marginTop: 6,
              }}
            >
              <Button size="small" onClick={cancelEdit}>
                取消
              </Button>
              <Button type="primary" size="small" onClick={confirmEdit}>
                保存并重发
              </Button>
            </div>
          </div>
        ) : msg.content || isUser ? (
          <div
            className={`${styles.content} ${isUser ? styles.userContent : styles.aiContent}`}
          >
            {renderContent()}
          </div>
        ) : null}

        {/* Footer */}
        {!editing && (
          <div
            className={`${styles.footer} ${isUser ? styles.userFooter : ""}`}
          >
            <span className={styles.time}>{timeStr}</span>

            {msg.durationMs != null && (
              <span className={styles.duration}>
                <ClockCircleOutlined style={{ fontSize: 10 }} />
                {(msg.durationMs / 1000).toFixed(1)}s
              </span>
            )}

            {!isUser && msg.usage && (
              <TokenBadge usage={msg.usage} durationMs={msg.durationMs} />
            )}

            <div className={styles.actions}>
              <CopyBtn text={getMessageText(msg.content)} />
              {!isUser && onRegenerate && (
                <Tooltip title="重新生成">
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    className={styles.iconBtn}
                    onClick={onRegenerate}
                  />
                </Tooltip>
              )}
              {isUser && onEdit && (
                <Tooltip title="编辑并重发">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    className={styles.iconBtn}
                    onClick={startEdit}
                  />
                </Tooltip>
              )}
              <Popconfirm
                title={
                  msg.role === 'user'
                    ? '删除这条提问及其 AI 回答？'
                    : '删除这条 AI 回答？'
                }
                description={
                  msg.role === 'user'
                    ? '同时删除紧跟其后的 AI 回答，操作不可撤销。'
                    : '仅删除该条回答，不影响上方提问。'
                }
                onConfirm={async () => {
                  // 优先使用从父组件注入的 onDelete（会同时持久化到后端 DB），
                  // 否则降级到只删前端 store（仅在缺失 prop 时兜底，避免 UI 卡死）。
                  if (onDelete) {
                    try {
                      await onDelete(msg.id)
                    } catch (err: any) {
                      message.error(`删除失败：${err?.message ?? '未知错误'}`)
                      return
                    }
                  } else {
                    deleteMessage(activeSessionId, msg.id)
                  }
                }}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
              >
                <Tooltip title="删除">
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    className={`${styles.iconBtn} ${styles.dangerBtn}`}
                  />
                </Tooltip>
              </Popconfirm>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── memo 化 MessageItem：只有 msg 引用变化时才重渲染
// status=done 的历史消息不会再变化，流式输出时只有最后一条消息重渲染
const MessageItem = memo(MessageItemInner, (prev, next) => {
  // 所有 props 均相同则跳过渲染
  return (
    prev.msg === next.msg &&
    prev.isLast === next.isLast &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onEdit === next.onEdit &&
    prev.onToolReply === next.onToolReply &&
    prev.onDelete === next.onDelete
  )
})

// ── Main ChatArea ──────────────────────────────────────────────────────────────
export default function ChatArea() {
  const {
    activeSessionId,
    sessions,
    messageMap,
    usageMap,
    clearMessages,
    updateSessionAgent,
    setInheritContext,
    updateSession,
    thinkingMode,
    setThinkingMode,
    triggerFilesRefresh,
  } = useSessionStore();
  const { agents } = useAgentStore();
  const {
    send,
    regenerate,
    editAndResend,
    fetchHistory,
    cancel,
    sendToolResponse,
    deleteMessage: deleteMessageWithBackend,
  } = useChat();

  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [primaryModel, setPrimaryModel] = useState<string>('');

  useEffect(() => {
    modelsApi.listModels()
      .then((data) => {
        const supported = data.filter((m: any) => m.thinkingMode).map((m: any) => m.modelId);
        setSupportedModels(supported);
      })
      .catch(console.error);
    settingsApi.get()
      .then((data) => {
        setPrimaryModel(data.LLM_PRIMARY_MODEL || '');
      })
      .catch(console.error);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = React.useMemo(
    () => messageMap[activeSessionId] ?? [],
    [messageMap, activeSessionId],
  );
  const sessionUsage = usageMap[activeSessionId];
  const session = sessions.find((s) => s.id === activeSessionId);
  const currentAgent = session?.agentId
    ? agents.find((a) => a.id === session.agentId)
    : undefined;

  const activeModelId = currentAgent?.model || primaryModel;
  const isThinkingSupported = supportedModels.includes(activeModelId);

  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentUrls, setAttachmentUrls] = useState<Map<number, string>>(new Map());
  const [showTodoPanel, setShowTodoPanel] = useState(false);
  // ── isStreaming 改为派生自全局 runningSessions ─────────────────────────────
  // 之前是局部 state，会话切换后状态错乱（A 流式中切到 B，B 显示 streaming）。
  // 现在以 store 中的 runningSessions[activeSessionId] 为准，跨会话切换始终准确。
  const runningSessions = useSessionStore((s) => s.runningSessions);
  const isStreaming = Boolean(runningSessions[activeSessionId]);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 会话是否已开始 —— 直接从本地 messageMap 判断，无需额外 API 请求
  // 后端在首次 POST /chat 时自动绑定 agentId，messages.length > 0 即代表已锁定
  const sessionStarted = messages.length > 0;
  const compressStats = session?.compressStats || null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const lastActionRef = useRef<number>(0);

  // ── 导航按钮可见性状态 ───────────────────────────────────────────────────
  const [navVisible, setNavVisible] = useState(false);
  // 当前聚焦的"组"索引（每条 user 消息为一组的起点）
  const currentGroupRef = useRef(-1);

  // 计算消息分组锚点：每条 user 消息在 DOM 中的位置
  const getGroupAnchors = useCallback((): Element[] => {
    const el = scrollRef.current;
    if (!el) return [];
    // 取所有 msgRow，user 消息用 userRow 区分
    return Array.from(el.querySelectorAll('[data-msg-role="user"]'));
  }, []);

  // 带缓冲的平滑滚动（easeInOutCubic 曲线，比原生 smooth 更丝滑）
  const smoothScrollTo = useCallback((targetScrollTop: number, duration = 380) => {
    const el = scrollRef.current;
    if (!el) return;
    const start = el.scrollTop;
    const distance = targetScrollTop - start;
    if (Math.abs(distance) < 2) return;
    const startTime = performance.now();
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      el.scrollTop = start + distance * easeInOutCubic(progress);
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  // 一键置顶
  const scrollToTop = useCallback(() => {
    smoothScrollTo(0, 420);
    currentGroupRef.current = -1;
  }, [smoothScrollTo]);

  // 一键到底（覆写原有的 scrollToBottom，统一用 smoothScrollTo）
  // 注意：流式输出时保持用原 auto 模式避免干扰
  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    smoothScrollTo(el.scrollHeight - el.clientHeight, 380);
    currentGroupRef.current = getGroupAnchors().length;
  }, [smoothScrollTo, getGroupAnchors]);

  // 跳上一组（上一条 user 消息）
  const scrollToPrevGroup = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchors = getGroupAnchors();
    if (!anchors.length) return;
    // 当前滚动位置对应的组
    const elRect = el.getBoundingClientRect();
    const visibleTop = elRect.top;
    // 找到第一个在当前视口顶部之上的 anchor
    let targetIdx = -1;
    for (let i = anchors.length - 1; i >= 0; i--) {
      const rect = anchors[i].getBoundingClientRect();
      if (rect.top < visibleTop - 10) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) {
      smoothScrollTo(0, 380);
      currentGroupRef.current = -1;
      return;
    }
    currentGroupRef.current = targetIdx;
    const anchor = anchors[targetIdx] as HTMLElement;
    const targetTop = el.scrollTop + anchor.getBoundingClientRect().top - elRect.top - 16;
    smoothScrollTo(Math.max(0, targetTop), 380);
  }, [getGroupAnchors, smoothScrollTo]);

  // 跳下一组（下一条 user 消息）
  const scrollToNextGroup = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchors = getGroupAnchors();
    if (!anchors.length) return;
    const elRect = el.getBoundingClientRect();
    const visibleTop = elRect.top;
    // 找到第一个在当前视口顶部之下的 anchor（含一点余量）
    let targetIdx = -1;
    for (let i = 0; i < anchors.length; i++) {
      const rect = anchors[i].getBoundingClientRect();
      if (rect.top > visibleTop + 10) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) {
      // 已经是最后一组，滚到底部
      smoothScrollTo(el.scrollHeight - el.clientHeight, 380);
      currentGroupRef.current = anchors.length;
      return;
    }
    currentGroupRef.current = targetIdx;
    const anchor = anchors[targetIdx] as HTMLElement;
    const targetTop = el.scrollTop + anchor.getBoundingClientRect().top - elRect.top - 16;
    smoothScrollTo(Math.max(0, targetTop), 380);
  }, [getGroupAnchors, smoothScrollTo]);

  const BASE_URL = (import.meta as any).env?.VITE_API_URL ?? "";

  const debounceCheck = useCallback((): boolean => {
    const now = Date.now();
    if (now - lastActionRef.current < 200) return false;
    lastActionRef.current = now;
    return true;
  }, []);

  const logOperation = useCallback((op: string, details: Record<string, unknown>) => {
    console.log(`[SessionOp] ${op}`, { sessionId: activeSessionId, timestamp: new Date().toISOString(), ...details });
  }, [activeSessionId]);

  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

  const addFiles = useCallback((files: File[]) => {
    const validFiles = files.filter(file => {
      if (file.size > MAX_FILE_SIZE) {
        message.error(`文件 ${file.name} 超过 100MB 限制`);
        return false;
      }
      return true;
    });
    setAttachments(prev => [...prev, ...validFiles]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (items) {
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        addFiles(files);
      }
    }
  }, [addFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      addFiles(files);
    }
  }, [addFiles]);

  const attachmentUrlsRef = useRef(attachmentUrls);
  attachmentUrlsRef.current = attachmentUrls;

  const removeAttachment = (index: number) => {
    setAttachments(prev => {
      const url = attachmentUrls.get(index);
      if (url) {
        URL.revokeObjectURL(url);
      }
      return prev.filter((_, i) => i !== index);
    });
    setAttachmentUrls(prev => {
      const newUrls = new Map(prev);
      const url = newUrls.get(index);
      if (url) {
        URL.revokeObjectURL(url);
      }
      newUrls.delete(index);
      // 更新索引映射
      const updatedUrls = new Map<number, string>();
      newUrls.forEach((url, idx) => {
        updatedUrls.set(idx < index ? idx : idx - 1, url);
      });
      return updatedUrls;
    });
  };

  useEffect(() => {
    return () => {
      attachmentUrlsRef.current.forEach(url => {
        URL.revokeObjectURL(url);
      });
    };
  }, []);

  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<Array<{ name: string; path: string }>>([]);

  // 打开工作区管理时加载最近工作区列表
  React.useEffect(() => {
    if (isWorkspaceModalOpen) {
      workspaceApi.listRecent().then(setRecentWorkspaces).catch(() => { });
    }
  }, [isWorkspaceModalOpen]);

  const handleAddWorkspace = () => {
    if (!newWorkspacePath.trim()) return;
    const currentPaths = session?.workspacePaths || [];
    if (currentPaths.includes(newWorkspacePath.trim())) {
      message.warning("该路径已存在");
      return;
    }
    updateSession(activeSessionId, {
      workspacePaths: [...currentPaths, newWorkspacePath.trim()],
    });
    setNewWorkspacePath("");
    message.success("工作区路径已添加");
  };

  const handleRemoveWorkspace = (pathToRemove: string) => {
    const currentPaths = session?.workspacePaths || [];
    updateSession(activeSessionId, {
      workspacePaths: currentPaths.filter((p) => p !== pathToRemove),
    });
    message.success("工作区路径已移除");
  };

  const handleCompress = async () => {
    if (messages.length <= 1 || isCompressing || isStreaming) return;
    setIsCompressing(true);
    const hide = message.loading("正在用 AI 压缩上下文...", 0);
    try {
      const res = await fetch(
        `${BASE_URL}/api/v1/conversation/compress?sessionId=${encodeURIComponent(
          activeSessionId,
        )}`,
        {
          method: "POST",
        },
      );
      const resData = await res.json();
      if (resData.code === 200 && resData.data?.success) {
        if (resData.data.stats) {
          updateSession(activeSessionId, { compressStats: resData.data.stats });
          message.success(`压缩成功！从 ${resData.data.stats.originalTokens} 压缩到 ${resData.data.stats.compressedTokens} Tokens (比例 ${resData.data.stats.ratio})`);
        } else {
          message.success("上下文压缩成功！");
        }
        await fetchHistory(activeSessionId);
        // Update usageMap with compression usage if available
        if (resData.data.usage) {
          useSessionStore.getState().updateUsage(activeSessionId, resData.data.usage);
        }
      } else {
        message.error(`压缩失败: ${resData.message || "未知错误"}`);
      }
    } catch (err: any) {
      message.error(`压缩失败: ${err.message}`);
    } finally {
      hide();
      setIsCompressing(false);
    }
  };

  // 检查是否正在等待用户在 ask_user 卡片中回复
  const isWaitingForUser = React.useMemo(() => {
    if (!messages.length) return false;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "assistant" || !lastMsg.thinkingSteps) return false;
    return lastMsg.thinkingSteps.some(
      (s) =>
        s.type === "tool_start" &&
        s.toolName === "ask_user" &&
        s.success === undefined,
    );
  }, [messages]);

  const isInputDisabled = isStreaming || isWaitingForUser;

  let placeholder = "有问题尽管问我...";
  if (isStreaming) placeholder = "正在生成回复...";
  else if (isWaitingForUser) placeholder = "请先回复上方 Agent 的提问...";

  // Fetch history on session change
  useEffect(() => {
    if (activeSessionId) {
      fetchHistory(activeSessionId);
    }
  }, [activeSessionId, fetchHistory]);

  // Scroll logic
  // 消息数量变化时刷新导航按钮可见性
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      // 等 DOM 更新完成后再量
      requestAnimationFrame(() => {
        setNavVisible(el.scrollHeight > el.clientHeight + 60);
      });
    }
  }, [messages.length]);
  const scrollToBottom = useCallback((smooth = false) => {
    if (smooth) {
      messagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    } else {
      messagesEndRef.current?.scrollIntoView({
        behavior: "auto",
        block: "end",
      });
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      // 增加容错范围
      atBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
      // 有滚动内容时才显示导航按钮
      setNavVisible(scrollHeight > clientHeight + 60);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 使用 useLayoutEffect 确保在 DOM 更新后、重绘前同步滚动位置
  // 流式输出时使用 auto 滚动，因为高频更新下 smooth 会导致动画冲突和“跳动”
  useLayoutEffect(() => {
    if (isStreaming && atBottomRef.current) {
      scrollToBottom(false);
    }
  }, [messages, isStreaming, scrollToBottom]);

  // 切换会话时可以使用平滑滚动
  useEffect(() => {
    atBottomRef.current = true;
    scrollToBottom(true);
    // 切换会话后重新评估是否显示导航按钮
    const el = scrollRef.current;
    if (el) setNavVisible(el.scrollHeight > el.clientHeight + 60);
  }, [activeSessionId, scrollToBottom]);

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const BINARY_EXTENSIONS = new Set([
    '.xlsx', '.xls', '.xlsm', '.xlsb', '.csv',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
    '.mp3', '.wav', '.ogg', '.mp4', '.avi', '.mov', '.webm',
    '.exe', '.dll', '.so', '.dylib',
    '.ttf', '.otf', '.woff', '.woff2',
    '.db', '.sqlite', '.sqlite3',
  ])

  const isBinaryFile = (fileName: string): boolean => {
    const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
    return BINARY_EXTENSIONS.has(ext)
  }

  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  const sendMessage = useCallback(
    async (content: string) => {
      if ((!content.trim() && attachments.length === 0) || isInputDisabled) return;
      setInputValue("");
      const currentAttachments = [...attachments];
      setAttachments([]);
      // isStreaming 由 useChat hook 内部通过 markSessionRunning 自动管理
      atBottomRef.current = true;
      scrollToBottom();

      try {
        const userContentParts: any[] = [];
        if (content.trim()) {
          userContentParts.push({ type: "text", text: content });
        }

        const attachmentData: Array<{ name: string; content: string; type: string; encoding?: 'utf-8' | 'base64' }> = [];

        if (currentAttachments.length > 0) {
          const hide = message.loading("正在处理附件...", 0);
          try {
            const uploadedFiles = [];
            for (const file of currentAttachments) {
              const isImage = file.type.startsWith("image/");
              const isBinary = !isImage && isBinaryFile(file.name);
              const fileContent = (isImage || isBinary) ? await readFileAsBase64(file) : await readFileAsText(file);

              // 1. Upload to workspace
              await workspaceApi.uploadFile(activeSessionId, file.name, fileContent, (isImage || isBinary) ? "base64" : "utf-8");
              uploadedFiles.push(file.name);

              // 2. Prepare for AI
              attachmentData.push({
                name: file.name,
                content: '',
                type: file.type,
                encoding: (isImage || isBinary) ? "base64" : "utf-8"
              });

              if (isImage) {
                // 图片已上传到 workspace，用 workspace URL 而非 base64，避免消息体过大
                userContentParts.push({
                  type: "workspace_image",
                  name: file.name,
                  sessionId: activeSessionId,
                  url: `/api/v1/workspace/image?sessionId=${encodeURIComponent(activeSessionId)}&path=${encodeURIComponent(file.name)}`,
                });
              } else {
                // 文档只存文件名引用（不内嵌内容），和图片一样只显示卡片
                // AI 通过 read_file 工具读取文件内容
                userContentParts.push({
                  type: "workspace_file",
                  name: file.name,
                  fileType: file.type,
                  sessionId: activeSessionId,
                });
              }
            }
            triggerFilesRefresh();
            hide();
          } catch (err: any) {
            hide();
            message.error(`处理附件失败: ${err.message}`);
          }
        }

        // If it's only text, send as string to maintain compatibility, 
        // otherwise send as array of parts.
        const finalContent = userContentParts.length === 1 && userContentParts[0].type === "text"
          ? userContentParts[0].text
          : userContentParts;

        await send(finalContent, activeSessionId, attachmentData);
      } finally {
        setTimeout(() => scrollToBottom(true), 100);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, isInputDisabled, send, scrollToBottom, attachments],
  );

  const handleRegenerate = useCallback(() => {
    if (isStreaming || !debounceCheck()) return;
    logOperation('regenerate', { action: 'start' });
    atBottomRef.current = true;
    regenerate(activeSessionId)
      .then(() => logOperation('regenerate', { action: 'done' }))
      .catch((err) => logOperation('regenerate', { action: 'error', error: err.message }))
      .finally(() => {
        setTimeout(() => scrollToBottom(true), 100);
      });
  }, [activeSessionId, isStreaming, regenerate, scrollToBottom, debounceCheck, logOperation]);

  const handleEditAndResend = useCallback(
    (msgId: string, newContent: string) => {
      if (isStreaming || !debounceCheck()) return;
      logOperation('editAndResend', { action: 'start', msgId });
      atBottomRef.current = true;
      editAndResend(msgId, newContent, activeSessionId)
        .then(() => logOperation('editAndResend', { action: 'done', msgId }))
        .catch((err) => logOperation('editAndResend', { action: 'error', msgId, error: err.message }))
        .finally(() => {
          setTimeout(() => scrollToBottom(true), 100);
        });
    },
    [activeSessionId, isStreaming, editAndResend, scrollToBottom, debounceCheck, logOperation],
  );

  const handleDeleteMessage = useCallback(
    (messageId: string) => deleteMessageWithBackend(activeSessionId, messageId),
    [activeSessionId, deleteMessageWithBackend],
  )

  const handleEditMessage = useCallback(
    (msgId: string, newContent: string) => handleEditAndResend(msgId, newContent),
    [handleEditAndResend],
  )

  const handleToolReply = useCallback(
    async (
      msgId: string,
      toolCallId: string,
      toolName: string,
      content: string,
    ) => {
      atBottomRef.current = true;
      scrollToBottom();
      try {
        await sendToolResponse(
          msgId,
          toolCallId,
          toolName,
          content,
          activeSessionId,
        );
      } finally {
        setTimeout(() => scrollToBottom(true), 100);
      }
    },
    [activeSessionId, sendToolResponse, scrollToBottom],
  );

  return (
    <div className={styles.container}>
      {/* Chat Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          {currentAgent ? (
            <>
              <RobotOutlined className={styles.agentIcon} />
              <span className={styles.headerTitle}>{currentAgent.name}</span>
              {currentAgent.description && (
                <span className={styles.headerDesc}>
                  {currentAgent.description}
                </span>
              )}
            </>
          ) : (
            <span className={styles.headerTitle}>
              {session?.title ?? "新对话"}
            </span>
          )}
        </div>
        <div className={styles.headerRight}>
          {/* Agent selector - 会话开始后显示锁定文本标签，否则展示下拉选择器 */}
          {sessionStarted ? (
            <Tooltip
              title="Agent 已绑定，无法更换。如需使用其他 Agent 请新建会话。"
              placement="bottom"
            >
              <span className={styles.agentLocked}>
                <RobotOutlined className={styles.agentLockedIcon} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {currentAgent?.name ?? "默认对话"}
                </span>
                <span className={styles.agentLockedLock}>🔒</span>
              </span>
            </Tooltip>
          ) : (
            <Tooltip title="选择 Agent" placement="bottom">
              <Select
                size="small"
                placeholder="选择 Agent"
                allowClear
                className={styles.agentSelect}
                value={session?.agentId || undefined}
                onChange={(val) => updateSessionAgent(activeSessionId, val || undefined)}
                options={agents.map((a) => ({
                  value: a.id,
                  label: (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <RobotOutlined style={{ fontSize: 11 }} />
                      {a.name}
                    </span>
                  ),
                }))}
                styles={{ popup: { root: { minWidth: 180 } } }}
              />
            </Tooltip>
          )}

          <Tooltip title="工作区管理">
            <Button
              type="text"
              size="small"
              icon={<SettingOutlined />}
              onClick={() => setIsWorkspaceModalOpen(true)}
              style={{ color: "#8b949e" }}
            />
          </Tooltip>

          <Tooltip title="待办任务">
            <Button
              type="text"
              size="small"
              onClick={() => setShowTodoPanel(v => !v)}
              style={{ color: showTodoPanel ? "#58a6ff" : "#8b949e", fontSize: 15 }}
            >
              📋
            </Button>
          </Tooltip>



          {/* Token summary */}
          {sessionUsage && (
            <Tooltip
              title={
                <div>
                  <TokenDetailsContent
                    usage={sessionUsage}
                    title="会话累计 Token"
                  />
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #30363d' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <span style={{ color: '#8b949e', fontSize: 12 }}>上下文记忆</span>
                      <Tooltip title={session?.inheritContext === false ? '已关闭：AI 不会记住之前的对话内容，每次独立回答' : '已开启：AI 会记住之前的对话，上下文连贯'}>
                        <Switch
                          size="small"
                          checked={session?.inheritContext !== false}
                          onChange={(checked) => setInheritContext(activeSessionId, checked)}
                          disabled={messages.length > 0}
                        />
                      </Tooltip>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ color: '#8b949e', fontSize: 12 }}>上下文使用率</span>
                      <span style={{ color: '#e6edf3', fontSize: 12, fontWeight: 600 }}>
                        {Math.round((sessionUsage.totalTokens / 1000000) * 100)}% of 1000K
                      </span>
                    </div>
                    {compressStats && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: 11 }}>
                        <span style={{ color: '#8b949e', flexShrink: 0 }}>最近一次压缩比例</span>
                        <Tooltip title={`${compressStats.ratio} (${compressStats.originalTokens} → ${compressStats.compressedTokens})`}>
                          <span style={{
                            color: '#3fb950',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            marginLeft: 8,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '180px',
                            display: 'inline-block',
                            direction: 'ltr'
                          }}>
                            {compressStats.ratio} ({compressStats.originalTokens} → {compressStats.compressedTokens})
                          </span>
                        </Tooltip>
                      </div>
                    )}
                    <Button
                      block
                      size="small"
                      onClick={() => handleCompress()}
                      disabled={messages.length <= 1 || isStreaming || isCompressing}
                      loading={isCompressing}
                      style={{
                        background: '#21262d',
                        borderColor: '#30363d',
                        color: '#c9d1d9',
                        fontSize: 12
                      }}
                    >
                      压缩
                    </Button>
                  </div>
                </div>
              }
              styles={{
                container: {
                  background: "#161b22",
                  border: "1px solid #30363d",
                  borderRadius: 8,
                  padding: "10px 14px",
                },
              }}
              arrow={false}
              placement="bottomRight"
              trigger="click"
            >
              <span className={styles.sessionToken} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: '2px solid #8b949e',
                  borderTopColor: '#3fb950',
                  borderRightColor: '#3fb950',
                  transform: `rotate(${Math.round((sessionUsage.totalTokens / 1000000) * 360) - 45}deg)`
                }} />
                {Math.round((sessionUsage.totalTokens / 1000000) * 100)}%
              </span>
            </Tooltip>
          )}

          <Tooltip title="清空对话">
            <Popconfirm
              title="清空当前对话？"
              onConfirm={() => clearMessages(activeSessionId)}
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button
                type="text"
                size="small"
                icon={<ClearOutlined />}
                className={styles.headerBtn}
              />
            </Popconfirm>
          </Tooltip>
        </div>
      </div>

      {/* Messages + 导航按钮 wrapper */}
      <div style={{ position: "relative", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className={styles.messages} ref={scrollRef}>
          {messages.length === 0 ? (
            <WelcomeScreen
              onPrompt={sendMessage}
              agentName={currentAgent?.name}
            />
          ) : (
            <>
              {messages.map((msg, idx) => (
                <div
                  key={msg.id}
                  data-msg-role={msg.role}
                >
                  <MessageItem
                    msg={msg}
                    isLast={idx === messages.length - 1}
                    onRegenerate={
                      idx === messages.length - 1 ? handleRegenerate : undefined
                    }
                    onEdit={msg.role === "user" ? handleEditMessage : undefined}
                    onToolReply={handleToolReply}
                    onDelete={handleDeleteMessage}
                  />
                </div>
              ))}
              <div ref={messagesEndRef} style={{ height: 1, clear: "both" }} />
            </>
          )}
        </div>

        {/* ── 悬浮导航按钮（在 overflow wrapper 外，不被裁剪）── */}
        <div className={styles.scrollNav}>
          {/* 置顶 */}
          <div
            className={`${styles.scrollNavBtn} ${navVisible ? styles.scrollNavBtnVisible : ""}`}
            onClick={scrollToTop}
            title="置顶"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M6 1L1 7h3v4h4V7h3L6 1z" />
              <rect x="1" y="0" width="10" height="1.5" rx="0.75" />
            </svg>
          </div>

          {/* 上一组 */}
          <div
            className={`${styles.scrollNavBtn} ${navVisible ? styles.scrollNavBtnVisible : ""}`}
            style={{ transitionDelay: navVisible ? '0.04s' : '0s' }}
            onClick={scrollToPrevGroup}
            title="上一组对话"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
              <path d="M5.5 2L1 7h3v2h3V7h3L5.5 2z" />
            </svg>
          </div>

          {/* 分隔线 */}
          <div className={styles.scrollNavDivider} />

          {/* 下一组 */}
          <div
            className={`${styles.scrollNavBtn} ${navVisible ? styles.scrollNavBtnVisible : ""}`}
            style={{ transitionDelay: navVisible ? '0.08s' : '0s' }}
            onClick={scrollToNextGroup}
            title="下一组对话"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
              <path d="M5.5 9L10 4H7V2H4v2H1L5.5 9z" />
            </svg>
          </div>

          {/* 到底 */}
          <div
            className={`${styles.scrollNavBtn} ${navVisible ? styles.scrollNavBtnVisible : ""}`}
            style={{ transitionDelay: navVisible ? '0.12s' : '0s' }}
            onClick={scrollToBottomSmooth}
            title="到底部"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M6 11L11 5H8V1H4v4H1L6 11z" />
              <rect x="1" y="10.5" width="10" height="1.5" rx="0.75" />
            </svg>
          </div>
        </div>
      </div>

      {/* Todo Panel — 在输入框上方展示 */}
      {showTodoPanel && (
        <TodoPanel
          sessionId={activeSessionId}
          visible={showTodoPanel}
          onClose={() => setShowTodoPanel(false)}
        />
      )}

      {/* Input area */}
      <div className={styles.inputArea} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()} style={{ position: "relative" }}>
        <div
          className={styles.inputWrapper}
          style={{ flexDirection: "column", alignItems: "stretch", position: "relative" }}
        >
          <div className={styles.resizeHandle} />
          {attachments.length > 0 && (
            <div className={styles.attachmentPreview}>
              {attachments.map((file, index) => {
                // 生成带时间戳的文件名
                const ext = file.name.split('.').pop();
                const baseName = file.name.replace(/\.[^/.]+$/, '');
                const timestamp = Date.now();
                const newFileName = `${baseName}_${timestamp}.${ext}`;

                if (file.type.startsWith("image/")) {
                  const imageUrl = attachmentUrls.get(index) || URL.createObjectURL(file);
                  if (!attachmentUrls.has(index)) {
                    setAttachmentUrls(prev => new Map(prev).set(index, imageUrl));
                  }
                  return (
                    <div key={index} className={styles.attachmentItemImage}>
                      <CloseOutlined
                        onClick={(e) => { e.stopPropagation(); removeAttachment(index); }}
                        className={styles.removeAttachmentImage}
                      />
                      <Image
                        src={imageUrl}
                        alt={newFileName}
                        width={24}
                        height={24}
                        className={styles.attachmentThumb}
                        preview={{
                          src: imageUrl,
                        }}
                      />
                    </div>
                  );
                } else {
                  // 根据文件类型显示不同图标
                  const getFileIcon = () => {
                    if (file.type.includes('pdf')) return <FileTextOutlined style={{ color: '#f85149' }} />;
                    if (file.type.includes('video')) return <FileOutlined style={{ color: '#34d399' }} />;
                    if (file.type.includes('audio')) return <FileOutlined style={{ color: '#60a5fa' }} />;
                    if (file.type.includes('zip') || file.type.includes('rar')) return <FileOutlined style={{ color: '#fbbf24' }} />;
                    if (file.type.includes('text')) return <FileTextOutlined style={{ color: '#34d399' }} />;
                    if (file.type.includes('code') || file.type.includes('json') || file.type.includes('xml')) return <FileTextOutlined style={{ color: '#a78bfa' }} />;
                    return <FileOutlined style={{ color: '#0e639c' }} />;
                  };

                  return (
                    <div key={index} className={styles.attachmentItem}>
                      {getFileIcon()}
                      <span className={styles.attachmentName}>{file.name}</span>
                      <CloseOutlined
                        onClick={() => removeAttachment(index)}
                        className={styles.removeAttachmentIcon}
                      />
                    </div>
                  );
                }
              })}
            </div>
          )}
          <Input.TextArea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onPaste={handlePaste}
            placeholder={placeholder}
            autoSize={{ minRows: 1, maxRows: 8 }}
            disabled={isInputDisabled}
            className={styles.input}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                e.preventDefault();
                if (!isInputDisabled && (inputValue.trim() || attachments.length > 0)) {
                  sendMessage(inputValue);
                }
              }
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                const start = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                const newValue = inputValue.substring(0, start) + "\n" + inputValue.substring(end);
                setInputValue(newValue);
              }
            }}
          />
          <div
            className={styles.inputActions}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              width: "100%",
              marginTop: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {isThinkingSupported && (
                <Tooltip title="开启深度思考，模型会进行更深入的推理">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      cursor: isInputDisabled ? "not-allowed" : "pointer",
                      opacity: isInputDisabled ? 0.5 : 1,
                    }}
                    onClick={() =>
                      !isInputDisabled && setThinkingMode(!thinkingMode)
                    }
                  >
                    <BulbOutlined
                      style={{
                        color: thinkingMode
                          ? "#a855f7"
                          : "var(--vscode-icon-foreground, #8b949e)",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12,
                        color: thinkingMode
                          ? "#a855f7"
                          : "var(--vscode-icon-foreground, #8b949e)",
                        userSelect: "none",
                      }}
                    >
                      深度思考
                    </span>
                    <Switch
                      size="small"
                      checked={thinkingMode}
                      disabled={isInputDisabled}
                      style={{
                        background: thinkingMode ? "#a855f7" : undefined,
                      }}
                    />
                  </div>
                </Tooltip>
              )}

              <Tooltip title="添加附件 (支持所有文件格式；可拖拽或粘贴)">
                <Button
                  type="text"
                  icon={<PaperClipOutlined />}
                  onClick={() => fileInputRef.current?.click()}
                  className={styles.actionBtn}
                  style={{ color: "var(--vscode-icon-foreground)" }}
                />
              </Tooltip>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                multiple
                onChange={handleFileSelect}
              />

              {inputValue.length > 0 && (
                <Tooltip title="清空输入">
                  <Button
                    type="text"
                    icon={<CloseOutlined />}
                    className={styles.clearBtn}
                    onClick={() => {
                      setInputValue("");
                      textareaRef.current?.focus();
                    }}
                  />
                </Tooltip>
              )}

              <span className={styles.charCount}>
                {inputValue.length > 0 && `${inputValue.length}`}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={styles.shortcutHint}>Enter 发送 · Ctrl+Enter 换行</span>
              {isStreaming ? (
                <Tooltip title="停止生成">
                  <Button
                    type="text"
                    icon={
                      <div
                        style={{
                          width: 12,
                          height: 12,
                          backgroundColor: "var(--vscode-icon-foreground)",
                          borderRadius: 2,
                        }}
                      ></div>
                    }
                    className={styles.sendBtn}
                    onClick={() => { cancel() }}
                  />
                </Tooltip>
              ) : (
                <Tooltip
                  title={
                    isInputDisabled ? "请先回复 Agent 提问" : "发送 (Enter)"
                  }
                >
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    className={styles.sendBtn}
                    disabled={(!inputValue.trim() && attachments.length === 0) || isInputDisabled}
                    onClick={() => sendMessage(inputValue)}
                    style={{
                      background:
                        (inputValue.trim() || attachments.length > 0) && !isInputDisabled
                          ? "#0e639c"
                          : "var(--vscode-button-secondaryBackground)",
                      color:
                        (inputValue.trim() || attachments.length > 0) && !isInputDisabled
                          ? "#fff"
                          : "var(--vscode-button-secondaryForeground)",
                    }}
                  />
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Workspace Management Modal */}
      <Modal
        title={null}
        open={isWorkspaceModalOpen}
        onCancel={() => { setIsWorkspaceModalOpen(false); setNewWorkspacePath(""); }}
        footer={null}
        width={580}
        centered
        styles={{
          mask: { backdropFilter: "blur(6px)", background: "rgba(0,0,0,0.55)" },
          body: { padding: 0, background: "#141414" },
        } as any}
        style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #2a2a2a", padding: 0 }}
      >
        {/* ── 标题栏 ── */}
        <div style={{
          padding: "16px 20px 14px",
          borderBottom: "1px solid #222",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="#6b7280">
            <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.12 3.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3z" />
          </svg>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#e0e0e0", flex: 1 }}>工作区管理</span>
          {(() => {
            const cnt = (session?.workspacePaths ?? []).length;
            return cnt > 0 ? (
              <span style={{
                fontSize: 11, color: "#4ade80", background: "rgba(74,222,128,0.1)",
                border: "1px solid rgba(74,222,128,0.2)", borderRadius: 10,
                padding: "1px 8px", fontWeight: 500,
              }}>{cnt} 个已绑定</span>
            ) : null;
          })()}
        </div>
        {/* ── 添加新路径 ── */}
        <div style={{
          marginBottom: 10,
          borderBottom: "1px solid #1f1f1f",
          paddingBottom: 12,
          padding: "12px 16px 16px",
        }}>
          <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 6, paddingLeft: 2 }}>
            添加自定义路径
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={newWorkspacePath}
              onChange={e => setNewWorkspacePath(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAddWorkspace(); }}
              placeholder="粘贴绝对路径，按 Enter 确认…"
              style={{
                flex: 1,
                background: "#0d0d0d", color: "#cccccc",
                border: "1px solid #2a2a2a", borderRadius: 7,
                padding: "7px 12px", fontSize: 12,
                fontFamily: "Consolas, monospace",
                outline: "none", transition: "border-color 0.15s",
              }}
              onFocus={e => { e.currentTarget.style.borderColor = "#0e639c"; }}
              onBlur={e => { e.currentTarget.style.borderColor = "#2a2a2a"; }}
            />
            <button
              onClick={handleAddWorkspace}
              disabled={!newWorkspacePath.trim()}
              style={{
                padding: "7px 16px", fontSize: 12, fontWeight: 500,
                borderRadius: 7, border: "none", cursor: newWorkspacePath.trim() ? "pointer" : "not-allowed",
                background: newWorkspacePath.trim() ? "#0e639c" : "#1a1a1a",
                color: newWorkspacePath.trim() ? "#fff" : "#444",
                transition: "all 0.15s", flexShrink: 0,
              }}
            >添加</button>
          </div>
        </div>
        {/* ── 内容区 ── */}
        <div style={{ padding: "12px 16px 16px", maxHeight: "62vh", overflowY: "auto" }}>
          {(() => {
            const bound = session?.workspacePaths ?? [];
            const available = recentWorkspaces.filter(ws => !bound.includes(ws.path));

            // 从路径推导显示名称
            const parsePath = (p: string, apiName?: string) => {
              const norm = p.replace(/\\/g, "/");
              const parts = norm.split("/").filter(Boolean);
              const last = parts[parts.length - 1] ?? p;
              const parent = parts[parts.length - 2] ?? "";
              // 随机 session ID（纯小写字母数字 ≥12位）→ 用 apiName 或 "会话工作区"
              const isSessionId = /^[a-z0-9]{12,}$/.test(last);
              const displayName = isSessionId
                ? (apiName && apiName !== last ? apiName : (parent || "会话工作区"))
                : last;
              const subPath = parts.length >= 3
                ? "…/" + parts.slice(-3, -1).join("/") + "/"
                : (parent ? parent + "/" : "");
              return { displayName, subPath, isSessionId };
            };

            const WorkspaceRow = ({
              path, apiName, isBound, onAction,
            }: { path: string; apiName?: string; isBound: boolean; onAction: () => void }) => {
              const { displayName, subPath } = parsePath(path, apiName);
              const [hovered, setHovered] = React.useState(false);
              const [btnHovered, setBtnHovered] = React.useState(false);
              return (
                <div
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", borderRadius: 8,
                    background: hovered ? "rgba(255,255,255,0.04)" : "transparent",
                    transition: "background 0.12s",
                    cursor: isBound ? "default" : "pointer",
                  }}
                  onClick={() => { if (!isBound) onAction(); }}
                >
                  {/* 状态点 */}
                  <div style={{
                    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                    background: isBound ? "#4ade80" : "#3d3d3d",
                    boxShadow: isBound ? "0 0 6px rgba(74,222,128,0.4)" : "none",
                    transition: "all 0.2s",
                  }} />

                  {/* 路径信息 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 500,
                      color: isBound ? "#d4d4d4" : "#6b7280",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>{displayName}</div>
                    <div
                      title={path}
                      style={{
                        fontSize: 11, color: "#3a3a3a",
                        fontFamily: "Consolas, monospace",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        marginTop: 1,
                      }}
                    >{subPath}<span style={{ color: "#555" }}>{displayName}</span></div>
                  </div>

                  {/* 操作按钮 */}
                  {isBound ? (
                    <button
                      onClick={e => { e.stopPropagation(); onAction(); }}
                      onMouseEnter={() => setBtnHovered(true)}
                      onMouseLeave={() => setBtnHovered(false)}
                      title="解除绑定"
                      style={{
                        width: 26, height: 26, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: 6, border: "none", cursor: "pointer",
                        background: btnHovered ? "rgba(248,81,73,0.12)" : "transparent",
                        color: btnHovered ? "#f85149" : "#444",
                        fontSize: 14, transition: "all 0.15s",
                      }}
                    >×</button>
                  ) : (
                    <div style={{
                      fontSize: 11, color: hovered ? "#9cdcfe" : "#3a3a3a",
                      flexShrink: 0, transition: "color 0.15s", fontWeight: 500,
                    }}>+ 绑定</div>
                  )}
                </div>
              );
            };

            return (
              <>
                {/* ── 已绑定 ── */}
                {bound.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{
                      fontSize: 10, fontWeight: 600, color: "#4b5563",
                      textTransform: "uppercase", letterSpacing: "0.08em",
                      padding: "4px 12px 6px",
                    }}>已绑定</div>
                    {bound.map(p => (
                      <WorkspaceRow key={p} path={p} isBound={true} onAction={() => handleRemoveWorkspace(p)} />
                    ))}
                  </div>
                )}

                {/* ── 最近使用 ── */}
                {available.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    {bound.length > 0 && <div style={{ height: 1, background: "#1f1f1f", margin: "6px 0 10px" }} />}
                    <div style={{
                      fontSize: 10, fontWeight: 600, color: "#4b5563",
                      textTransform: "uppercase", letterSpacing: "0.08em",
                      padding: "4px 12px 6px",
                    }}>最近使用</div>
                    {available.map(ws => (
                      <WorkspaceRow
                        key={ws.path} path={ws.path} apiName={ws.name} isBound={false}
                        onAction={() => {
                          updateSession(activeSessionId, { workspacePaths: [...bound, ws.path] });
                          const { displayName } = parsePath(ws.path, ws.name);
                          message.success("已绑定：" + displayName);
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* ── 空状态 ── */}
                {bound.length === 0 && available.length === 0 && (
                  <div style={{
                    textAlign: "center", padding: "28px 0 20px",
                    color: "#3d3d3d", fontSize: 12,
                  }}>
                    <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}>📁</div>
                    <div>暂无工作区，请在下方输入路径添加</div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </Modal>
    </div>
  );
}
