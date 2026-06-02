# E2E 手工验收清单 — `superpower-methodology-and-tiers`

本清单对应 `tasks.md` 中因**需要真实 HTTP / 浏览器 / LLM** 而无法在
单测里复现的 4 个子任务：

| Task | 场景 | 本清单段落 |
|---|---|---|
| 3.4 | Route 层 bootstrap 注入 | §A |
| 6.6 | `PUT /settings` ↔ `GET /settings` 热更新 | §B |
| 8.7 | 前端 console 四档切换落盘 + 热生效 | §C |
| 10.6 | 四档模式全链路 smoke | §D |

每一段都给出：**前置**、**步骤**、**期望**、**Pass 判据**、**查日志/证据位置**。
验收人只需按顺序走一遍，全部 Pass 即可进入 `/opsx:verify` → `/opsx:archive`。

---

## A. Route 层 bootstrap 注入（Task 3.4）

对应代码：
- `src/api/http/routes/chat.ts` L384 `prependBootstrapToSystemPrompt(...)`
- `src/api/http/routes/messages.ts` L144 `prependBootstrapToSystemPrompt(...)`

### 前置
1. `.env` 中：`LOG_LEVEL=debug`，任一可用模型配好 API Key
2. 启动 `pnpm dev`（或等价命令），确认 `engineLogger` 走 stdout

### 步骤 A-1：`off` 模式不注入
1. `PUT /settings` 把 `SUPERPOWER_MODE=off`
2. 发起 `POST /v1/chat/completions`（或 `POST /conversations/:id/messages`），
   随便一句话 `"hello"`
3. 在 server 日志里找 `llm.complete` 前一行的 system prompt（或在 dev 下
   临时打开一次 `logger.debug({ systemPrompt }, 'outbound')` — 不需要提交）

**期望**：system prompt **不**以 `<SUPERPOWER-ACTIVE>` 或 bootstrap 内容开头。

### 步骤 A-2：`methodology` 注入
1. `PUT /settings` → `SUPERPOWER_MODE=methodology`
2. 同上发一条消息
3. 观察出站 system prompt 首段

**期望**：以 `superpower-using-superpowers` 的 `SKILL.md` 全文开头，
后面接 `\n\n---\n\n` 分隔，再是 base prompt。

### 步骤 A-3：`max` 同样注入 + 无重复
1. `PUT /settings` → `SUPERPOWER_MODE=max`
2. 同上
3. 检查 system prompt **只有一段** bootstrap，没有被两次 prepend（防止
   chat.ts 与 messages.ts 双重链路重复注入）

**Pass 判据**
- `off` / `balanced` 不出现 `<SUPERPOWER-ACTIVE>`（或 bootstrap 标题）
- `methodology` / `max` 出现，且 **只出现 1 次**
- bootstrap skill 缺失场景（临时把 `skills/superpower-using-superpowers/`
  重命名后再试一次）—— 日志里有**一次** `bootstrap skill missing` warn，
  之后静默，不 throw

---

## B. Settings API 热更新（Task 6.6）

对应代码：
- `src/api/http/routes/settings.ts`：`GET /settings` 读回 `SUPERPOWER_MODE`，
  `PUT /settings` 写 DB + `process.env`

### 步骤 B-1：基本 round-trip

```bash
curl -X PUT http://localhost:12323/settings \
  -H 'content-type: application/json' \
  -d '{"SUPERPOWER_MODE":"off"}'

curl http://localhost:12323/settings | jq .data.SUPERPOWER_MODE
# expect: "off"

curl -X PUT http://localhost:12323/settings \
  -H 'content-type: application/json' \
  -d '{"SUPERPOWER_MODE":"max"}'

curl http://localhost:12323/settings | jq .data.SUPERPOWER_MODE
# expect: "max"
```

### 步骤 B-2：四档全枚举校验
每档 `PUT` 之后立刻 `GET` 确认。

### 步骤 B-3：非法值拒绝

```bash
curl -i -X PUT http://localhost:12323/settings \
  -H 'content-type: application/json' \
  -d '{"SUPERPOWER_MODE":"turbo"}'
# expect: 400 + message containing "SUPERPOWER_MODE 非法值"
```

### 步骤 B-4：冲突写入拒绝

```bash
curl -i -X PUT http://localhost:12323/settings \
  -H 'content-type: application/json' \
  -d '{"SUPERPOWER_MODE":"max","SUPERPOWER_ENABLED":true}'
# expect: 400 + "不能同时写入"
```

### 步骤 B-5：Legacy 只写
```bash
curl -X PUT http://localhost:12323/settings \
  -H 'content-type: application/json' \
  -d '{"SUPERPOWER_ENABLED":true}'
# 期望 200；server 日志出现一次 DEPRECATION 警告
curl http://localhost:12323/settings | jq .data.SUPERPOWER_MODE
# expect: "methodology" （由 resolver 映射）
```

### 步骤 B-6：热更新影响下一次请求
1. `PUT SUPERPOWER_MODE=off`
2. 发一次 chat 消息，抓 `maxIterations` 日志（或计算用的 token budget 日志）
3. 立刻 `PUT SUPERPOWER_MODE=max`（**不重启服务**）
4. 再发一次 chat 消息，比较两次数字

**Pass 判据**
- 第 2 步 `maxIterations = 50`（默认），tokenBudget ≈ 60000
- 第 4 步 `maxIterations = 200`（×4），tokenBudget = 300000（×5）
- 不需要任何重启

---

## C. 前端 console 四档切换（Task 8.7）

对应代码：`multi-agent-console/src/web/components/settings/GeneralSettings.tsx`

### 步骤 C-1：四档互切
1. 打开设置页 → 增强模式卡片
2. `off → balanced`：直接切换，看到 toast "已切换到 Balanced 模式"
3. `balanced → methodology`：直接切换，右上角出现金色 **Methodology active** tag
4. `methodology → max`：**弹确认 Modal**，列出 ×5/×4/compress 0.7 的警示
5. 取消一次（不切换）— 当前值回到 `methodology`
6. 再次点 `max`，确认 → 切换成功，tag 仍亮
7. `max → off`：直接切换，tag 消失

### 步骤 C-2：刷新持久化
在任意档位（比如 `methodology`）下 **刷新整页**，确认：
- Segmented 组件回显仍是 `methodology`
- Methodology active tag 仍显示

### 步骤 C-3：Legacy 兼容显示
1. 在 DB 里只写 `SUPERPOWER_ENABLED=true`（通过直接 SQL 或清掉
   `SUPERPOWER_MODE` 行）
2. 刷新设置页

**期望**：Segmented 停在 `Methodology` 档（由 `normalizeMode` 把
legacy true 翻译过来），下方描述文字提醒 `SUPERPOWER_ENABLED` 将在下个
minor 移除。

### 步骤 C-4：后端写失败回滚
（需后端临时模拟 500）切档后 toast 红字 "保存失败"，Segmented 回弹上一档。

**Pass 判据**
- 四档都能切；`max` 必须过确认
- tag 仅在 `methodology`/`max` 下亮
- 刷新后回显正确
- 只写 legacy 能被映射回显

---

## D. 四档全链路 smoke（Task 10.6）

这一步是 **集成验收**：把 A/B/C 一起跑一遍，对每档验证 **3 个维度**。

> 为每一档准备一个新对话，避免历史上下文污染。

| 模式 | 多路器 | 工具 | Bootstrap |
|---|---|---|---|
| `off` | token=60000 / iter=50 / output=4000 | CORE only（**没有** `run_command`/`web_fetch` 等） | 无 |
| `balanced` | token=120000 / iter=100 / output=8000 | 全量 | 无 |
| `methodology` | token=120000 / iter=100 / output=8000 | 全量 | **有** `<SUPERPOWER-ACTIVE>` |
| `max` | token=300000 / iter=200 / output=16000 / compress=0.7 | 全量 | **有** `<SUPERPOWER-ACTIVE>` |

### 验证多路器
最方便的观察点：
- `applySuperpowerMultiplier` 是纯函数，可在 chat 入口临时 `logger.debug`
  一次当前四个值
- 或直接让 agent 跑一个需要 50+ iter 的任务，看 `Max iterations (…)
  exceeded` 消息里的数字是否与表格一致

### 验证工具
发一句 `"列出你当前可用的工具"`，对比输出：
- `off` 档：应该看不到 `run_command`、`web_fetch`、`http_request`、
  `install_package`、`delete_file`、`subagent`
- 其它三档：这些都能列出来

### 验证 Bootstrap
- `off`/`balanced`：问 "你的 Iron Law 是什么" — agent 应该表示不知道/没有
- `methodology`/`max`：agent 应当明确引用 `SKILL.md` 中 Iron Laws
  （"no production code without a failing test" / "no code without spec"）

### 验证 Artifact 目录
`methodology`/`max` 下发起一次对话，检查 workspace：
```
workspace/<tenant>/<session>/docs/superpower/
├── specs/
├── plans/
└── reviews/
```
`off`/`balanced` 下这三个目录**不应该**被创建。

### 验证压缩阈值
`max` 档跑一个超长对话到接近 tokenBudget 的 70%，观察 history 是否被
触发压缩；其它档在 50% 就应该触发。

**Pass 判据**
- 上表每一行的三个维度全部符合
- 切换档位后**不需要重启** server
- 档位切换的 deprecation / invalid warn 都**只打一次**（Section E）

---

## E. 日志一次性观测

把下列场景复现一遍，确认每条 warn **整个进程只出现 1 次**：

| 场景 | 日志关键字 |
|---|---|
| Legacy `SUPERPOWER_ENABLED=true` 被 resolver 使用 | `DEPRECATION: SUPERPOWER_ENABLED is deprecated` |
| `SUPERPOWER_MODE=xxx` 非法值 | `invalid SUPERPOWER_MODE` / `unknown SUPERPOWER_MODE` |
| `PUT /settings` 写 legacy 字段 | `DEPRECATION: PUT /settings with SUPERPOWER_ENABLED` |
| bootstrap skill 缺失 | `bootstrap skill missing` / `superpower-using-superpowers` |

> 如果你的测试环境会多次进程 fork，每个进程内只一次即可。

---

## 验收签字

- [ ] §A Route 注入 3 个步骤全 Pass
- [ ] §B Settings 6 个步骤全 Pass
- [ ] §C 前端 4 个步骤全 Pass
- [ ] §D 四档 × 5 维度全 Pass
- [ ] §E 一次性 warn 全 Pass

全部勾选后：
1. 在 `tasks.md` 把 3.4 / 6.6 / 8.7 / 10.6 勾选并附 "E2E verified by <name> on <date>"
2. 跑 `/opsx:verify`
3. `/opsx:archive`

---

**备注**
- 如发现任一 Pass 判据不符合，请在本文件末尾追加 "Defect" 条目并 link 到
  新起的 change（不要回填此 change 的 spec）
- §D 的"验证多路器"如果觉得临时加 debug 日志太重，可换用已有的
  `src/core/__tests__/superpower.test.ts`（纯函数）作为规格证据，
  E2E 端只做工具可见性 + bootstrap 两个观察即可
