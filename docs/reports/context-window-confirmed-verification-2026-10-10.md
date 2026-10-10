# 上下文来回跳变：全链路调查与修复验收

日期：2026-10-10。范围：D:/dev/ai-agent-engine 与 D:/dev/aether-code 的模型窗口配置、请求输入统计、流式投影、历史恢复及卡片显示。此报告是本轮专项验收，不代表所有功能或 7×24 小时耐久测试完成。

## 结论与真实记录

本轮三张截图的 19,848 → 64,673 → 19,975 来回变化，由不同计量阶段覆盖同一个 UI 主数字引起：本地请求预估、供应商 message_start 初步输入、供应商结束帧确认输入。开始帧曾仅标识“模型统计”，缺少“仍未确认”的阶段信息。上方累计结算与卡片的单次调用输入属于不同口径。

只读本地配置确认 deepseek-v4.1-flash 有效窗口为 128,000；运行版本已加载上一轮 66cffeeb 修复。此次不是用户没有加载前轮代码。截图所在记录区间没有 summary 或 micro update，不能用自动压缩解释这三次跳变。

| 历史序号 | 最近结算调用输入 | 调用输出 | 本轮累计输入+输出 | 请求窗口 |
| --- | ---: | ---: | ---: | ---: |
| 268 | 55,327 | 237 | 164,025 | 128,000 |
| 270 | 56,306 | 1,295 | 221,626 | 128,000 |
| 272 | 57,672 | 896 | 280,194 | 128,000 |

后两次累计增加分别为 57,601 和 58,568，精确等于该次最终输入加输出。截图的 19K 属于随后流式开始阶段临时报数，不能替换此前已确认的 55K/56K/57K 输入。64,673 是本地估算，也不能假定为最终模型计量。

## 数据获取与传递位置

| 数据 | 获取/生成位置 | 传递与恢复 | 显示规则 |
| --- | --- | --- | --- |
| 模型有效窗口 | ModelFormDialog → model-store.saveModel → models.updateModel → PUT /api/v1/models/:id；引擎数据库配置、能力解析 | 保存响应立即发布共享 store，随后新的 GET /api/v1/models 同步；旧在途读取失效 | 输入快照所属模型的当前配置与实际请求窗口取较小值；其他 composer 模型不能改写分母 |
| 本次请求估算 | ReAct 在请求裁剪/压缩完成后生成固定 requestInputTokenEstimate | SSE usage → stream-projection → chat snapshot → chat-payload/chat-history | 最近确认值存在时显示独立副行；首次没有确认时保持该请求估算直到最终确认 |
| 供应商初步输入 | Anthropic SDK message_start 等非结束 usage 帧 | currentPromptTokens + contextUsageEstimated=false + contextUsageProvisional=true | 保留原始计量；不覆盖主数字。孤立暂报且无预估时明确写“模型初步统计，等待最终确认” |
| 最终确认输入 | SDK 结束统计 → ReAct terminal usage | contextUsageProvisional=false；confirmedContext 保存输入、模型、有效窗口；投影与历史可恢复 | 更新主数字和进度；允许真实下降及显式零 |
| 轮次累计用量 | 每次调用结算输入与输出 | live 帧为轮次累计；历史 assistant 行为每次调用增量；回放按账单字段相加 | 预估与上下文快照不能加入账单；重复累计帧不能再收一次 |
| 全会话累计用量 | 引擎会话权威用量及归档/子代理用量 | chat snapshot.sessionUsage → session-usage anchor，和分页载入分离 | 历史分页、压缩不重计或丢失已结算用量；删除整轮允许真实减少 |

异常断链保存的 partial 可以记录已观察到的用量，同时上下文输入仍处于 provisional。是否已经记录账单与输入是否最终确认是独立维度。因此文案没有承诺所有 provisional 都不计费；普通开始帧没有计费字段，不会增加累计。

## 本轮修复

1. 引擎提供显式 provisional 阶段、固定请求估算及 confirmedContext。实时投影、持久恢复都保留确认输入；SDK 原始数值不被伪造为单调增长。
2. 客户端分离最近确认主值与本次估算副行，兼容旧引擎 context-only 开始帧。模型初步统计不冒充最终确认或本地估算。
3. 历史回放仍将账单字段按增量累加，同时恢复原始 usage 的嵌套确认对象和阶段；metadata 优先，false、0 保留，后来的 model-only 行不改变已有输入归属。
4. 保存模型成功立即更新共享能力并强制新读取；旧 GET、迟到 CRUD 响应、来源切换以及并发回显均有失效保护。
5. 旧 1M 快照不能遮盖当前 128K 配置；实际 128K 请求在设置升到 256K 后仍保留其有效 128K 窗口，防止显示大于请求真实限制。
6. 预估副行预留空间；临时/预估切换期间主卡不重新挂载，位置、尺寸保持稳定，原数字与进度动画保留。

## 最终验证

| 项目 | 最终结果 | 证据 |
| --- | --- | --- |
| 引擎相关回归 | 53 文件，539/539 通过；0 失败、0 跳过 | .tmp/context-window-final-regression.json / .log |
| 客户端数据合同 | 6 文件，96/96 通过 | D:/dev/aether-code/.e2e-tmp/context-window-final-pure.log |
| 真实 Electron | 6 文件，24/24 通过，workers=1，最终构建产物上执行 | D:/dev/aether-code/.e2e-tmp/context-window-final-electron.log |
| 引擎 typecheck/build | 通过 | .tmp/context-window-final-typecheck.log / context-window-final-build.log |
| 客户端 typecheck/build | 通过；build 包含 node/web typecheck | D:/dev/aether-code/.e2e-tmp/context-window-final-build.log |
| 两仓库 diff check | 通过 | 本轮命令结果与日志 |

Electron 验证真实窗口、主进程 HTTP 桥及认证服务夹具：实际表单 128K→256K→清空默认、刷新与切换模型、预估与临时帧、最终结算、断线续接、单行历史恢复、显式零、压缩与分页、父子累计、删除整轮、数字动画、明暗模式和锚点定位。临时帧使用独立 usage 帧后再发送内容标记，避免合帧的 content 分支绕开 usage 造成假阳性。

主卡最后验证 55,327 在预估 64,673 与临时 19,848 期间保持稳定，最终确认变为 56,306；同一 DOM 探针属性仍存在、位置和尺寸偏差不超过 1px。截图在数字和进度动画 idle 后采集，已视觉检查浅色/深色及副行出现/消失状态。

引擎使用真实 Anthropic SDK 的离线 fetch 夹具验证配置传递到 wire 请求：input estimate + max output <=128000；已知 fallback 1M 不能扩大 128K。此次未重新发送付费真实模型请求；真实用户数字来自本地只读持久记录。

## 产物与当前运行状态

新引擎构建：sha256:1ce4eae9c78c6a46fafaebd94daceef3e91e7b5a930022c0e8b26f459ddc6b37。dist/runtime/build-manifest.json 已核对。客户端最终 renderer 产物 index-CdyHQTj8.js。

运行中的本地实例仍为 sha256:66cffeeb35dfb477f671f0530658cc027e7fb4e27cc7dcab4eb183f07e3d148a，instanceId 未变化。本轮没有重启用户实例或中断其会话。开发客户端没有导入 runtime 指针；默认使用同级 ai-agent-engine/dist/main.js，已核对最新构建路径。开发前端源码支持热更新；新引擎显式阶段/恢复字段在下次安全重启引擎后完整加载。旧引擎的开始帧识别已由客户端兼容逻辑覆盖。

未保存在旧数据里的模型身份、估算或最终统计不能凭空恢复；界面保留来源/未知说明。没有设置“历史最大值锁”，真实压缩、删除或确认输入减少仍会生效。
