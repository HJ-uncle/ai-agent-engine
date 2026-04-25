import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  useLayoutEffect,
} from "react";
import { Button, Tooltip, Popconfirm, Input, Select, theme, Switch } from "antd";
import {
  SendOutlined,
  StopOutlined,
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
  CheckCircleOutlined,
  CloseCircleOutlined,
  UpOutlined,
  DownOutlined,
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
import { modelsApi, settingsApi } from "../api";
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
  {
    key: "systemPromptTokens" as keyof TokenUsage,
    color: "#818cf8",
    label: "系统提示词",
  },
  {
    key: "messagesTokens" as keyof TokenUsage,
    color: "#38bdf8",
    label: "历史消息",
  },
  {
    key: "skillTokens" as keyof TokenUsage,
    color: "#c084fc",
    label: "技能/工具",
  },
  {
    key: "systemToolsTokens" as keyof TokenUsage,
    color: "#fbbf24",
    label: "系统工具",
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
    <div style={{ width: 200, fontSize: 12 }}>
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
          borderTop: "1px solid #21262d",
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
        基于 Agent Engine 驱动，支持工具调用、知识库检索
      </p>
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
  onReply,
  onToolReply,
  nextMessage,
}: {
  msg: Message;
  isLast?: boolean;
  onRegenerate?: () => void;
  onEdit?: (newContent: string) => void;
  onReply?: (content: string) => void;
  onToolReply?: (
    msgId: string,
    toolCallId: string,
    toolName: string,
    content: string,
  ) => void;
  nextMessage?: Message;
}) {
  const { deleteMessage, files, setActiveFile } = useSessionStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const isUser = msg.role === "user";
  const isStreaming = msg.status === "streaming";

  const timeStr = dayjs(msg.createdAt).format("YYYY-MM-DD HH:mm:ss");

  const startEdit = () => {
    setDraft(msg.content);
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);
  const confirmEdit = () => {
    if (draft.trim() && draft !== msg.content) onEdit?.(draft.trim());
    setEditing(false);
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
            {isUser ? (
              <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex, rehypeHighlight]}
                components={{
                  code({ node, className, children, ...props }: any) {
                    const isBlock = className?.includes("language-");
                    const content = String(children).trim();
                    const isFilePath =
                      !isBlock &&
                      files.some(
                        (f) => f === content || f.endsWith("/" + content),
                      );

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
                                (f) =>
                                  f === content || f.endsWith("/" + content),
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
                }}
              >
                {msg.content || (isStreaming ? "▌" : "")}
              </ReactMarkdown>
            )}
          </div>
        ) : null}

        {/* Interactive Card if ask_user was called */}
        {/* We no longer render it here, it's rendered inside the ThinkingPanel! */}

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
              <CopyBtn text={msg.content} />
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
                onConfirm={() => deleteMessage(msg.id)}
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
    thinkingMode,
    setThinkingMode,
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
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

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

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isInputDisabled) return;
      setInputValue("");
      setIsStreaming(true);
      atBottomRef.current = true;
      scrollToBottom();
      try {
        await send(content, activeSessionId);
      } finally {
        setIsStreaming(false);
        setTimeout(() => scrollToBottom(true), 100);
      }
    },
    [activeSessionId, isInputDisabled, send, scrollToBottom],
  );

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return;
    setIsStreaming(true);
    atBottomRef.current = true;
    regenerate(activeSessionId).finally(() => {
      setIsStreaming(false);
      setTimeout(() => scrollToBottom(true), 100);
    });
  }, [activeSessionId, isStreaming, regenerate, scrollToBottom]);

  const handleEditAndResend = useCallback(
    (msgId: string, newContent: string) => {
      if (isStreaming) return;
      setIsStreaming(true);
      atBottomRef.current = true;
      editAndResend(msgId, newContent, activeSessionId).finally(() => {
        setIsStreaming(false);
        setTimeout(() => scrollToBottom(true), 100);
      });
    },
    [activeSessionId, isStreaming, editAndResend, scrollToBottom],
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
          {/* Agent selector */}
          <Select
            size="small"
            placeholder="选择 Agent"
            allowClear
            className={styles.agentSelect}
            value={session?.agentId || undefined}
            onChange={(val) =>
              updateSessionAgent(activeSessionId, val || undefined)
            }
            options={[
              ...agents.map((a) => ({
                value: a.id,
                label: (
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <RobotOutlined style={{ fontSize: 11 }} />
                    {a.name}
                  </span>
                ),
              })),
            ]}
            styles={{ popup: { root: { minWidth: 180 } } }}
          />

          {/* Token summary */}
          {sessionUsage && (
            <Tooltip
              title={
                <TokenDetailsContent
                  usage={sessionUsage}
                  title="会话累计 Token"
                />
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
            >
              <span className={styles.sessionToken}>
                <ThunderboltOutlined style={{ fontSize: 11 }} />
                {fmtToken(sessionUsage.totalTokens)}
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
                nextMessage={messages[idx + 1]}
                onReply={sendMessage}
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

      {/* Input area */}
      <div className={styles.inputArea}>
        <div
          className={styles.inputWrapper}
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <Input.TextArea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={placeholder}
            autoSize={{ minRows: 1, maxRows: 8 }}
            disabled={isInputDisabled}
            className={styles.input}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Do not send if it's disabled or empty
                if (!isInputDisabled && inputValue.trim()) {
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

              <Tooltip title="添加附件">
                <Button
                  type="text"
                  icon={
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M3.5 2C2.67157 2 2 2.67157 2 3.5V12.5C2 13.3284 2.67157 14 3.5 14H12.5C13.3284 14 14 13.3284 14 12.5V3.5C14 2.67157 13.3284 2 12.5 2H3.5ZM3.5 3H12.5C12.7761 3 13 3.22386 13 3.5V12.5C13 12.7761 12.7761 13 12.5 13H3.5C3.22386 13 3 12.7761 3 12.5V3.5C3 3.22386 3.22386 3 3.5 3ZM8.5 4.5C8.5 4.22386 8.27614 4 8 4C7.72386 4 7.5 4.22386 7.5 4.5V7.5H4.5C4.22386 7.5 4 7.72386 4 8C4 8.27614 4.22386 8.5 4.5 8.5H7.5V11.5C7.5 11.7761 7.72386 12 8 12C8.27614 12 8.5 11.7761 8.5 11.5V8.5H11.5C11.7761 8.5 12 8.27614 12 8C12 7.72386 11.7761 7.5 11.5 7.5H8.5V4.5Z"
                        fill="currentColor"
                      />
                    </svg>
                  }
                  className={styles.actionBtn}
                  style={{ color: "var(--vscode-icon-foreground)" }}
                />
              </Tooltip>
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
                    disabled={!inputValue.trim() || isInputDisabled}
                    onClick={() => sendMessage(inputValue)}
                    style={{
                      background:
                        inputValue.trim() && !isInputDisabled
                          ? "#0e639c"
                          : "var(--vscode-button-secondaryBackground)",
                      color:
                        inputValue.trim() && !isInputDisabled
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
    </div>
  );
}
