import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  useLayoutEffect,
} from "react";
import { TodoPanel } from './TodoPanel';
import { Button, Tooltip, Popconfirm, Input, Select, Switch, message, Modal } from "antd";
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
import { useSessionStore } from "../store/session";
import { useAgentStore } from "../store/agents";
import { useChat } from "../hooks/useChat";
import { modelsApi, settingsApi, workspaceApi } from "../api";
import type { Message, TokenUsage, ThinkingStep } from "../types";
import styles from "./ChatArea.module.css";
import dayjs from "dayjs";

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
  const { question, options, multiSelect } = data;
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

function fmtToken(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n ?? 0);
}

// ── File Card Component ──────────────────────────────────────────────────────
function FileCard({ file, onCopyPath }: { file: any, onCopyPath: (path: string) => void }) {
  const { activeSessionId } = useSessionStore();
  const [isDownloading, setIsDownloading] = useState(false);
  const [fileInfo, setFileInfo] = useState<any>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);

  // 获取文件元数据
  useEffect(() => {
    const loadFileInfo = async () => {
      try {
        setIsLoadingInfo(true);
        const info = await workspaceApi.getFileInfo(activeSessionId, file.name);
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
}: {
  usage: TokenUsage;
  durationMs?: number;
  title?: string;
}) {
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

function ThinkingPanel({
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
    const foundFull = files.find(
      (f) => f === trimmed || f.endsWith("/" + trimmed),
    );
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
                ? `调用了 ${toolCount} 个工具：${toolNames.join("、")}`
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
function MessageItem({
  msg,
  isLast,
  onRegenerate,
  onEdit,
  onToolReply,
}: {
  msg: Message;
  isLast?: boolean;
  onRegenerate?: () => void;
  onEdit?: (newContent: string) => void;
  onToolReply?: (
    msgId: string,
    toolCallId: string,
    toolName: string,
    content: string,
  ) => void;
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
    if (draft.trim() && draft !== text) onEdit?.(draft.trim());
    setEditing(false);
  };

  const handleCopyPath = (fileName: string) => {
    navigator.clipboard.writeText(fileName);
    message.success("路径已复制到剪贴板");
  };

  const renderContent = () => {
    if (typeof msg.content === "string") {
      return isUser ? (
        <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
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
                  rehypePlugins={[rehypeKatex, rehypeHighlight]}
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

  const markdownComponents = {
    code({ node, className, children, ...props }: any) {
      const isBlock = className?.includes("language-");
      const content = String(children).trim();
      const isFilePath =
        !isBlock &&
        files.some((f) => f === content || f.endsWith("/" + content));

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
            if (isFilePath) {
              const fullPath = files.find(
                (f) => f === content || f.endsWith("/" + content),
              );
              if (fullPath) setActiveFile(fullPath);
            }
          }}
          {...props}
        >
          {children}
        </code>
      );
    },
    td({ node, children, ...props }: any) {
      const content = String(children).trim();
      const isFilePath = files.some(
        (f) => f === content || f.endsWith("/" + content),
      );

      if (isFilePath) {
        return (
          <td {...props}>
            <span
              className={styles.fileLink}
              onClick={() => {
                const fullPath = files.find(
                  (f) => f === content || f.endsWith("/" + content),
                );
                if (fullPath) setActiveFile(fullPath);
              }}
            >
              {children}
            </span>
          </td>
        );
      }
      return <td {...props}>{children}</td>;
    },
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
                title="删除这条消息？"
                onConfirm={() => deleteMessage(activeSessionId, msg.id)}
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
  const [showTodoPanel, setShowTodoPanel] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);

  // 会话是否已开始 —— 直接从本地 messageMap 判断，无需额外 API 请求
  // 后端在首次 POST /chat 时自动绑定 agentId，messages.length > 0 即代表已锁定
  const sessionStarted = messages.length > 0;
  const compressStats = session?.compressStats || null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const lastActionRef = useRef<number>(0);

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

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<Array<{ name: string; path: string }>>([]);

  // 打开工作区管理时加载最近工作区列表
  React.useEffect(() => {
    if (isWorkspaceModalOpen) {
      workspaceApi.listRecent().then(setRecentWorkspaces).catch(() => {});
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
      setIsStreaming(true);
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
              const fileContent = isImage ? await readFileAsBase64(file) : await readFileAsText(file);

              // 1. Upload to workspace
              await workspaceApi.uploadFile(activeSessionId, file.name, fileContent, isImage ? "base64" : "utf-8");
              uploadedFiles.push(file.name);

              // 2. Prepare for AI
              // 图片已上传到 workspace，只传文件名给后端，让 AI 用 read_image 工具读取
              // 不传 base64 content，避免消息体过大
              // 文件已上传到 workspace，content 不传内容，让 AI 用 read_file/read_image 工具读取
              attachmentData.push({
                name: file.name,
                content: '',  // 不传内容，避免消息体过大
                type: file.type,
                encoding: isImage ? "base64" : "utf-8"
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
        setIsStreaming(false);
        setTimeout(() => scrollToBottom(true), 100);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, isInputDisabled, send, scrollToBottom, attachments],
  );

  const handleRegenerate = useCallback(() => {
    if (isStreaming || !debounceCheck()) return;
    logOperation('regenerate', { action: 'start' });
    setIsStreaming(true);
    atBottomRef.current = true;
    regenerate(activeSessionId)
      .then(() => logOperation('regenerate', { action: 'done' }))
      .catch((err) => logOperation('regenerate', { action: 'error', error: err.message }))
      .finally(() => {
        setIsStreaming(false);
        setTimeout(() => scrollToBottom(true), 100);
      });
  }, [activeSessionId, isStreaming, regenerate, scrollToBottom, debounceCheck, logOperation]);

  const handleEditAndResend = useCallback(
    (msgId: string, newContent: string) => {
      if (isStreaming || !debounceCheck()) return;
      logOperation('editAndResend', { action: 'start', msgId });
      setIsStreaming(true);
      atBottomRef.current = true;
      editAndResend(msgId, newContent, activeSessionId)
        .then(() => logOperation('editAndResend', { action: 'done', msgId }))
        .catch((err) => logOperation('editAndResend', { action: 'error', msgId, error: err.message }))
        .finally(() => {
          setIsStreaming(false);
          setTimeout(() => scrollToBottom(true), 100);
        });
    },
    [activeSessionId, isStreaming, editAndResend, scrollToBottom, debounceCheck, logOperation],
  );

  const handleToolReply = useCallback(
    async (
      msgId: string,
      toolCallId: string,
      toolName: string,
      content: string,
    ) => {
      setIsStreaming(true);
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
        setIsStreaming(false);
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

      {/* Messages */}
      <div className={styles.messages} ref={scrollRef}>
        {messages.length === 0 ? (
          <WelcomeScreen
            onPrompt={sendMessage}
            agentName={currentAgent?.name}
          />
        ) : (
          <>
            {messages.map((msg, idx) => (
              <MessageItem
                key={msg.id}
                msg={msg}
                isLast={idx === messages.length - 1}
                onRegenerate={
                  idx === messages.length - 1 ? handleRegenerate : undefined
                }
                onEdit={
                  msg.role === "user"
                    ? (newContent) => handleEditAndResend(msg.id, newContent)
                    : undefined
                }
                onToolReply={handleToolReply}
              />
            ))}
            <div ref={messagesEndRef} style={{ height: 1, clear: "both" }} />
          </>
        )}
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
      <div className={styles.inputArea} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
        <div
          className={styles.inputWrapper}
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          {attachments.length > 0 && (
            <div className={styles.attachmentPreview}>
              {attachments.map((file, index) => (
                <div key={index} className={styles.attachmentItem}>
                  {file.type.startsWith("image/") ? (
                    <FileImageOutlined style={{ color: "#a855f7" }} />
                  ) : (
                    <FileOutlined style={{ color: "#0e639c" }} />
                  )}
                  <span className={styles.attachmentName}>{file.name}</span>
                  <CloseOutlined
                    onClick={() => removeAttachment(index)}
                    className={styles.removeAttachment}
                  />
                </div>
              ))}
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Do not send if it's disabled or empty
                if (!isInputDisabled && (inputValue.trim() || attachments.length > 0)) {
                  sendMessage(inputValue);
                }
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
            </div>
            <div>
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
                    onClick={cancel}
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
        width={560}
        centered
          styles={{
            mask: { backdropFilter: "blur(8px)", background: "var(--color-overlay-heavy)" },
            body: { padding: 0, background: "transparent" },
          } as any}
          style={{ borderRadius: "var(--radius-xl)", overflow: "hidden", padding: 0 }}
      >
        {/* 标题栏 */}
        <div style={{ padding: "14px 18px 12px", borderBottom: "var(--border-hairline)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-label)" }}>工作区管理</span>
          <span style={{ fontSize: 11, color: "var(--color-label-tertiary)" }}>已绑定 {(session?.workspacePaths ?? []).length} 个</span>
        </div>

        <div style={{ padding: "8px 14px 14px", maxHeight: "60vh", overflowY: "auto" }}>
          {(() => {
            const bound = session?.workspacePaths ?? [];
            const available = recentWorkspaces.filter(ws => !bound.includes(ws.path));
            const allItems = [...bound.map(p => ({ path: p, isBound: true })), ...available.map(ws => ({ path: ws.path, isBound: false }))];
            if (allItems.length === 0) return null;
            return (
              <div style={{ marginBottom: 10 }}>
                {allItems.map(({ path, isBound }) => {
                  const parts = path.replace(/\\\\/g, "/").split("/").filter(Boolean);
                  const name = parts[parts.length - 1] ?? path;
                  const shortPath = parts.length > 3 ? "\u2026/" + parts.slice(-2).join("/") : path;
                  return (
                    <div key={path} onClick={() => { if (isBound) return; updateSession(activeSessionId, { workspacePaths: [...bound, path] }); message.success("已绑定 " + name); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--radius-xs)", cursor: isBound ? "default" : "pointer", transition: "background var(--duration-fast) var(--easing-ease)" }}
                      onMouseEnter={e => { if (!isBound) e.currentTarget.style.background = "var(--color-fill-quaternary)"; }}
                      onMouseLeave={e => { if (!isBound) e.currentTarget.style.background = "transparent"; }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isBound ? "var(--color-green)" : "var(--color-label-quaternary)" }} />
                      <span style={{ fontSize: 13, color: isBound ? "var(--color-label)" : "var(--color-label-secondary)", fontWeight: isBound ? 500 : 400, flexShrink: 0 }}>{name}</span>
                      <span style={{ fontSize: 11, color: "var(--color-label-tertiary)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={path}>{shortPath}</span>
                      {isBound ? (
                        <div onClick={e => { e.stopPropagation(); handleRemoveWorkspace(path); }}
                          style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-xs)", color: "var(--color-label-tertiary)", cursor: "pointer", fontSize: 11, transition: "all var(--duration-fast) var(--easing-ease)", flexShrink: 0 }}
                          onMouseEnter={e => { e.currentTarget.style.color = "var(--color-red)"; e.currentTarget.style.background = "var(--color-red-subtle)"; }}
                          onMouseLeave={e => { e.currentTarget.style.color = "var(--color-label-tertiary)"; e.currentTarget.style.background = "transparent"; }}>\u2715</div>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--color-label-tertiary)", flexShrink: 0 }}>+</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div style={{ borderTop: "var(--border-hairline)", paddingTop: 10, display: "flex", gap: 6 }}>
            <Input size="small" placeholder="粘贴绝对路径后按 Enter..." value={newWorkspacePath} onChange={(e) => setNewWorkspacePath(e.target.value)} onPressEnter={handleAddWorkspace}
              style={{ background: "var(--color-fill-secondary)", color: "var(--color-label)", border: "var(--border-default)", borderRadius: "var(--radius-sm)", fontSize: 12 }}
              onFocus={e => (e.target.style.borderColor = "var(--color-accent)")} onBlur={e => (e.target.style.borderColor = "var(--color-gray-4)")} />
            <Button size="small" type="primary" onClick={handleAddWorkspace} disabled={!newWorkspacePath.trim()} style={{ borderRadius: 4, flexShrink: 0 }}>\u6dfb\u52a0</Button>
          </div>
          {(session?.workspacePaths ?? []).length === 0 && recentWorkspaces.length === 0 && (
            <div style={{ textAlign: "center", padding: "16px 0", color: "#444", fontSize: 12 }}>暂无可用工作区，请手动输入路径</div>
          )}
        </div>
      </Modal>
    </div>
  );
}
