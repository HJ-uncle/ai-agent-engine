# 全量文档状态清单

本清单由 `scripts/diagnostics/documentation-audit.mjs --write-index` 从两仓库 Git 文件清单生成，排除依赖、构建产物和忽略的临时资料；包含保留 Web 实现、OpenSpec 变更提案、运行提示词和页面资产，避免把它们误认为现行桌面手册。分类规则与现行文档集合保存在同一脚本中。

本轮源码核对日期：2026-11-17。文档覆盖不是全业务测试通过：清单只列仍存在的资料；保留报告的日期、失败、跳过与测量条件不变；运行指令/Skills 的校对范围见本次刷新记录，工作流与安全约束保留。

当前入口：[文档首页](README.md) · [功能架构与源码](docs/overview.md) · [桌面全部功能](../../aether-code/docs/feature-map.md) · [HTTP 路由](docs/http-routes.md)。

| 类型 | 数量 |
|---|---|
| 现行指南 | 37 |
| 实现契约 | 17 |
| 部署/维护流程 | 3 |
| 源码生成目录 | 2 |
| 插件 HTML 公开参考/维护 | 11 |
| 专项诊断流程（结果按原日期） | 10 |
| 历史报告/提案（非当前承诺） | 220 |
| 运行指令/协作约定（不作为产品手册改写） | 30 |
| 运行页面/示例资产（非说明文档） | 4 |

## 引擎与保留 Web 仓库

| 文件 | 状态 | 当前阅读入口 |
|---|---|---|
| [.aether/AE.md](<../.aether/AE.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-brainstorming/SKILL.md](<../.aether/skills/os-brainstorming/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-brainstorming/scripts/frame-template.html](<../.aether/skills/os-brainstorming/scripts/frame-template.html>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-brainstorming/spec-document-reviewer-prompt.md](<../.aether/skills/os-brainstorming/spec-document-reviewer-prompt.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-brainstorming/visual-companion.md](<../.aether/skills/os-brainstorming/visual-companion.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-subagent-driven-dev/SKILL.md](<../.aether/skills/os-subagent-driven-dev/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-subagent-driven-dev/code-quality-reviewer-prompt.md](<../.aether/skills/os-subagent-driven-dev/code-quality-reviewer-prompt.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-subagent-driven-dev/implementer-prompt.md](<../.aether/skills/os-subagent-driven-dev/implementer-prompt.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-subagent-driven-dev/spec-reviewer-prompt.md](<../.aether/skills/os-subagent-driven-dev/spec-reviewer-prompt.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/SKILL.md](<../.aether/skills/os-systematic-debugging/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/condition-based-waiting.md](<../.aether/skills/os-systematic-debugging/condition-based-waiting.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/defense-in-depth.md](<../.aether/skills/os-systematic-debugging/defense-in-depth.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/root-cause-tracing.md](<../.aether/skills/os-systematic-debugging/root-cause-tracing.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/test-academic.md](<../.aether/skills/os-systematic-debugging/test-academic.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/test-pressure-1.md](<../.aether/skills/os-systematic-debugging/test-pressure-1.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/test-pressure-2.md](<../.aether/skills/os-systematic-debugging/test-pressure-2.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-systematic-debugging/test-pressure-3.md](<../.aether/skills/os-systematic-debugging/test-pressure-3.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-tdd/SKILL.md](<../.aether/skills/os-tdd/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-using-superpowers/SKILL.md](<../.aether/skills/os-using-superpowers/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-using-superpowers/references/agent-engine-tools.md](<../.aether/skills/os-using-superpowers/references/agent-engine-tools.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-verification-before-completion/SKILL.md](<../.aether/skills/os-verification-before-completion/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-writing-plans/SKILL.md](<../.aether/skills/os-writing-plans/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.aether/skills/os-writing-plans/plan-document-reviewer-prompt.md](<../.aether/skills/os-writing-plans/plan-document-reviewer-prompt.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [.env.example](<../.env.example>) | 现行指南 | 本文件；相关专题见文档首页 |
| [AGENTS.md](<../AGENTS.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [README.md](<../README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [deploy/workspace-runtime/README.md](<../deploy/workspace-runtime/README.md>) | 部署/维护流程 | 本文件；相关专题见文档首页 |
| [docs/README.md](<README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/account-external-login.md](<account-external-login.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/account-login.md](<account-login.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/context-compression-design.md](<context-compression-design.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/docs/api-spec.md](<docs/api-spec.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/docs/bench/performance.md](<docs/bench/performance.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/docs/getting-started.md](<docs/getting-started.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/docs/http-routes.md](<docs/http-routes.md>) | 源码生成目录 | 本文件；相关专题见文档首页 |
| [docs/docs/openapi.json](<docs/openapi.json>) | 源码生成目录 | 本文件；相关专题见文档首页 |
| [docs/docs/overview.md](<docs/overview.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/docs/system-tools.md](<docs/system-tools.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/docs/third-party-integration.md](<docs/third-party-integration.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/documentation-inventory.md](<documentation-inventory.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/documentation-refresh-2026-11-17.md](<documentation-refresh-2026-11-17.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/examples/workbench-extension/README.md](<examples/workbench-extension/README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/examples/workbench-extension/ui/index.html](<examples/workbench-extension/ui/index.html>) | 运行页面/示例资产（非说明文档） | 本文件；相关专题见文档首页 |
| [docs/multimodal-design.md](<multimodal-design.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/operations/session-storage-maintenance.md](<operations/session-storage-maintenance.md>) | 部署/维护流程 | 本文件；相关专题见文档首页 |
| [docs/plugin-project-v1.md](<plugin-project-v1.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/plugin-ui-contributions.md](<plugin-ui-contributions.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/plugins.md](<plugins.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/reports/context-input-metering-audit-2026-10-10.md](<reports/context-input-metering-audit-2026-10-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-09-29-claude-capability-catalog.md](<research/2026-09-29-claude-capability-catalog.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-09-30-codegraph-loading-fix.md](<research/2026-09-30-codegraph-loading-fix.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-09-30-net-file-changes-review.md](<research/2026-09-30-net-file-changes-review.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-09-30-session-history-disappearance-audit.md](<research/2026-09-30-session-history-disappearance-audit.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-11-11-plugin-timer-review.md](<research/2026-11-11-plugin-timer-review.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-11-12-currency-plugin-application-fix.md](<research/2026-11-12-currency-plugin-application-fix.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-11-12-plugin-real-world-acceptance.md](<research/2026-11-12-plugin-real-world-acceptance.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-11-12-plugin-sdk-development.md](<research/2026-11-12-plugin-sdk-development.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/2026-11-16-session-continuation-wuzu-code.md](<research/2026-11-16-session-continuation-wuzu-code.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/builtin-agent-team-audit-2026-11-09.md](<research/builtin-agent-team-audit-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/codegraph-subagent-repair-2026-11-10.md](<research/codegraph-subagent-repair-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/codegraph-subagent-research-audit-2026-11-09.md](<research/codegraph-subagent-research-audit-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/harness-client-integration-notes.md](<research/harness-client-integration-notes.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/harness-frontend-extension-map.md](<research/harness-frontend-extension-map.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/harness-frontend-slot-matrix.md](<research/harness-frontend-slot-matrix.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/harness-host-lifecycle-notes.md](<research/harness-host-lifecycle-notes.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/harness-interactive-plugin-notes.md](<research/harness-interactive-plugin-notes.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/memory-injection-optimization-2026-11-09.md](<research/memory-injection-optimization-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/office-incident-forensics-2026-11-09.md](<research/office-incident-forensics-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/office-incident-remediation-2026-11-09.md](<research/office-incident-remediation-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/office-subagent-workflow-audit-2026-11-09.md](<research/office-subagent-workflow-audit-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/prompt-cache-prefix-2026-11-09.md](<research/prompt-cache-prefix-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/rollback-child-cache-2026-11-10.md](<research/rollback-child-cache-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/rollback-consistency-2026-11-09.md](<research/rollback-consistency-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/session-storage-audit-2026-11-05/README.md](<research/session-storage-audit-2026-11-05/README.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/session-storage-audit-2026-11-05/durability-ecosystem.md](<research/session-storage-audit-2026-11-05/durability-ecosystem.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/session-storage-audit-2026-11-05/live-maintenance-2026-11-05.md](<research/session-storage-audit-2026-11-05/live-maintenance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/session-storage-audit-2026-11-05/runtime-projections.md](<research/session-storage-audit-2026-11-05/runtime-projections.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/session-storage-audit-2026-11-05/session-api-security.md](<research/session-storage-audit-2026-11-05/session-api-security.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/session-storage-audit-2026-11-05/storage-backends.md](<research/session-storage-audit-2026-11-05/storage-backends.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/team-token-optimization-report-2026-11-09.md](<research/team-token-optimization-report-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/work-prompt-reliability-limits-2026-11-09.md](<research/work-prompt-reliability-limits-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/research/work-prompt-reliability-report-2026-11-09.md](<research/work-prompt-reliability-report-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/runtime-guide.md](<runtime-guide.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/security-architecture.md](<security-architecture.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/session-toolkits.md](<session-toolkits.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/test-reports/2026-10-09-pressure-fixes-and-retest.md](<test-reports/2026-10-09-pressure-fixes-and-retest.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/test-reports/2026-10-09-two-end-final-acceptance.md](<test-reports/2026-10-09-two-end-final-acceptance.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/test-reports/2026-10-09-windows-pty-close-race-diagnosis.md](<test-reports/2026-10-09-windows-pty-close-race-diagnosis.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/test-reports/2026-10-10-memory-embedding-source-acceptance.md](<test-reports/2026-10-10-memory-embedding-source-acceptance.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [docs/thinking-mode-config.md](<thinking-mode-config.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [multi-agent-console/README.md](<../multi-agent-console/README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [multi-agent-console/docs/deploy/nginx-ua-routing.md](<../multi-agent-console/docs/deploy/nginx-ua-routing.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/index.html](<../multi-agent-console/index.html>) | 运行页面/示例资产（非说明文档） | 本文件；相关专题见文档首页 |
| [multi-agent-console/m.html](<../multi-agent-console/m.html>) | 运行页面/示例资产（非说明文档） | 本文件；相关专题见文档首页 |
| [multi-agent-console/openspec/changes/responsive-h5-layout/design.md](<../multi-agent-console/openspec/changes/responsive-h5-layout/design.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/responsive-h5-layout/proposal.md](<../multi-agent-console/openspec/changes/responsive-h5-layout/proposal.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/responsive-h5-layout/specs/responsive-layout/spec.md](<../multi-agent-console/openspec/changes/responsive-h5-layout/specs/responsive-layout/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/responsive-h5-layout/tasks.md](<../multi-agent-console/openspec/changes/responsive-h5-layout/tasks.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/split-mobile-app-shell/design.md](<../multi-agent-console/openspec/changes/split-mobile-app-shell/design.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/split-mobile-app-shell/proposal.md](<../multi-agent-console/openspec/changes/split-mobile-app-shell/proposal.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/split-mobile-app-shell/specs/mobile-app-shell/spec.md](<../multi-agent-console/openspec/changes/split-mobile-app-shell/specs/mobile-app-shell/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/split-mobile-app-shell/specs/multi-entry-build/spec.md](<../multi-agent-console/openspec/changes/split-mobile-app-shell/specs/multi-entry-build/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/split-mobile-app-shell/specs/shared-core/spec.md](<../multi-agent-console/openspec/changes/split-mobile-app-shell/specs/shared-core/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [multi-agent-console/openspec/changes/split-mobile-app-shell/tasks.md](<../multi-agent-console/openspec/changes/split-mobile-app-shell/tasks.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/design.md](<../openspec/changes/ant-design-x-full-upgrade/design.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/proposal.md](<../openspec/changes/ant-design-x-full-upgrade/proposal.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/specs/xcard-protocol/spec.md](<../openspec/changes/ant-design-x-full-upgrade/specs/xcard-protocol/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/specs/xmarkdown-renderer/spec.md](<../openspec/changes/ant-design-x-full-upgrade/specs/xmarkdown-renderer/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/specs/xsdk-chat-hook/spec.md](<../openspec/changes/ant-design-x-full-upgrade/specs/xsdk-chat-hook/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/specs/xskill-display/spec.md](<../openspec/changes/ant-design-x-full-upgrade/specs/xskill-display/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/ant-design-x-full-upgrade/tasks.md](<../openspec/changes/ant-design-x-full-upgrade/tasks.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/design.md](<../openspec/changes/deepseek-pricing-and-balance/design.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/proposal.md](<../openspec/changes/deepseek-pricing-and-balance/proposal.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/specs/deepseek-balance/spec.md](<../openspec/changes/deepseek-pricing-and-balance/specs/deepseek-balance/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/specs/deepseek-error-handling/spec.md](<../openspec/changes/deepseek-pricing-and-balance/specs/deepseek-error-handling/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/specs/deepseek-models/spec.md](<../openspec/changes/deepseek-pricing-and-balance/specs/deepseek-models/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/specs/deepseek-pricing/spec.md](<../openspec/changes/deepseek-pricing-and-balance/specs/deepseek-pricing/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/deepseek-pricing-and-balance/tasks.md](<../openspec/changes/deepseek-pricing-and-balance/tasks.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/fix-tool-history-compat/design.md](<../openspec/changes/fix-tool-history-compat/design.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/fix-tool-history-compat/proposal.md](<../openspec/changes/fix-tool-history-compat/proposal.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/fix-tool-history-compat/specs/tool-call-history-compat/spec.md](<../openspec/changes/fix-tool-history-compat/specs/tool-call-history-compat/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/fix-tool-history-compat/tasks.md](<../openspec/changes/fix-tool-history-compat/tasks.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/design.md](<../openspec/changes/vscode-explorer-refactor/design.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/proposal.md](<../openspec/changes/vscode-explorer-refactor/proposal.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/specs/explorer-performance/spec.md](<../openspec/changes/vscode-explorer-refactor/specs/explorer-performance/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/specs/file-ops-safety/spec.md](<../openspec/changes/vscode-explorer-refactor/specs/file-ops-safety/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/specs/file-preview/spec.md](<../openspec/changes/vscode-explorer-refactor/specs/file-preview/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/specs/git-integration/spec.md](<../openspec/changes/vscode-explorer-refactor/specs/git-integration/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/specs/monaco-editor-integration/spec.md](<../openspec/changes/vscode-explorer-refactor/specs/monaco-editor-integration/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/specs/vscode-file-tree/spec.md](<../openspec/changes/vscode-explorer-refactor/specs/vscode-file-tree/spec.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/changes/vscode-explorer-refactor/tasks.md](<../openspec/changes/vscode-explorer-refactor/tasks.md>) | 历史报告/提案（非当前承诺） | [现行指南](runtime-guide.md) |
| [openspec/specs/agent-loop/spec.md](<../openspec/specs/agent-loop/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/auth-multitenancy/spec.md](<../openspec/specs/auth-multitenancy/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/cache-store/spec.md](<../openspec/specs/cache-store/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/conversation-history/spec.md](<../openspec/specs/conversation-history/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/knowledge-base/spec.md](<../openspec/specs/knowledge-base/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/llm-adapter/spec.md](<../openspec/specs/llm-adapter/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/mcp-client/spec.md](<../openspec/specs/mcp-client/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/memory-store/spec.md](<../openspec/specs/memory-store/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/observability/spec.md](<../openspec/specs/observability/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/prompt-template/spec.md](<../openspec/specs/prompt-template/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/security-sandbox/spec.md](<../openspec/specs/security-sandbox/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/stream-pipeline/spec.md](<../openspec/specs/stream-pipeline/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/superpower-methodology/spec.md](<../openspec/specs/superpower-methodology/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/superpower-mode/spec.md](<../openspec/specs/superpower-mode/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/task-queue/spec.md](<../openspec/specs/task-queue/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [openspec/specs/tool-registry/spec.md](<../openspec/specs/tool-registry/spec.md>) | 实现契约 | 本文件；相关专题见文档首页 |
| [scripts/longrun/README.md](<../scripts/longrun/README.md>) | 专项诊断流程（结果按原日期） | [现行指南](runtime-guide.md) |
| [scripts/longrun/analyze-continuation.md](<../scripts/longrun/analyze-continuation.md>) | 专项诊断流程（结果按原日期） | [现行指南](runtime-guide.md) |
| [scripts/longrun/continuation-client-monitor.md](<../scripts/longrun/continuation-client-monitor.md>) | 专项诊断流程（结果按原日期） | [现行指南](runtime-guide.md) |
| [scripts/patches/node-pty-1.1.0/README.md](<../scripts/patches/node-pty-1.1.0/README.md>) | 部署/维护流程 | 本文件；相关专题见文档首页 |
| [scripts/real-model-acceptance.md](<../scripts/real-model-acceptance.md>) | 专项诊断流程（结果按原日期） | [现行指南](runtime-guide.md) |
| [sdk-package/README.md](<../sdk-package/README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [src/skills/builtin/aether-office/SKILL.md](<../src/skills/builtin/aether-office/SKILL.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [src/skills/builtin/aether-office/references/documents.md](<../src/skills/builtin/aether-office/references/documents.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [src/skills/builtin/aether-office/references/environment.md](<../src/skills/builtin/aether-office/references/environment.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [src/skills/builtin/aether-office/references/presentations-pdf.md](<../src/skills/builtin/aether-office/references/presentations-pdf.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [src/skills/builtin/aether-office/references/spreadsheets.md](<../src/skills/builtin/aether-office/references/spreadsheets.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [src/tools/model-tool-definitions.contracts.md](<../src/tools/model-tool-definitions.contracts.md>) | 实现契约 | 本文件；相关专题见文档首页 |

## Aether 桌面仓库

| 文件 | 状态 | 当前阅读入口 |
|---|---|---|
| [.wuzu/plans/adaptive-sparking-ladybug.md](<../../aether-code/.wuzu/plans/adaptive-sparking-ladybug.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [AGENTS.md](<../../aether-code/AGENTS.md>) | 运行指令/协作约定（不作为产品手册改写） | 本文件；相关专题见文档首页 |
| [README.md](<../../aether-code/README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [design-system/aether-code/MASTER.md](<../../aether-code/design-system/aether-code/MASTER.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [design-system/aether-code/PAGE-COVERAGE.md](<../../aether-code/design-system/aether-code/PAGE-COVERAGE.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [design-system/aether-code/QA-ISSUES.md](<../../aether-code/design-system/aether-code/QA-ISSUES.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/README.md](<../../aether-code/docs/README.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/accounts-and-login.md](<../../aether-code/docs/accounts-and-login.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/all-mode-longrun-readonly-audit-2026-10-13.md](<../../aether-code/docs/all-mode-longrun-readonly-audit-2026-10-13.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/all-mode-runtime-limit-client-audit-2026-10-12.md](<../../aether-code/docs/all-mode-runtime-limit-client-audit-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/append-mode-queue-audit-2026-11-04.md](<../../aether-code/docs/append-mode-queue-audit-2026-11-04.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/append-real-model-review-2026-11-04.md](<../../aether-code/docs/append-real-model-review-2026-11-04.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/approval-interaction-review-2026-10-06.md](<../../aether-code/docs/approval-interaction-review-2026-10-06.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/artifacts-changes-consolidation-acceptance-2026-11-05.md](<../../aether-code/docs/artifacts-changes-consolidation-acceptance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/assets/runtime-refresh-20261105/verification.md](<../../aether-code/docs/assets/runtime-refresh-20261105/verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-display-fix-2026-10-08.md](<../../aether-code/docs/browser-display-fix-2026-10-08.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-html-acceptance-2026-11-04.md](<../../aether-code/docs/browser-html-acceptance-2026-11-04.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-integration-verification-2026-10-08.md](<../../aether-code/docs/browser-integration-verification-2026-10-08.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-local-file-preview-2026-11-05.md](<../../aether-code/docs/browser-local-file-preview-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-navigation-lifecycle-fix-2026-10-09.md](<../../aether-code/docs/browser-navigation-lifecycle-fix-2026-10-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-network-verification-2026-10-08.md](<../../aether-code/docs/browser-network-verification-2026-10-08.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-service-security-audit-2026-11-05.md](<../../aether-code/docs/browser-service-security-audit-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-session-and-subagent-limits-2026-10-12.md](<../../aether-code/docs/browser-session-and-subagent-limits-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/browser-workflow-reliability.md](<../../aether-code/docs/browser-workflow-reliability.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/chat-artifact-link-verification-2026-10-08.md](<../../aether-code/docs/chat-artifact-link-verification-2026-10-08.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/code-performance-optimization-2026-10-12.md](<../../aether-code/docs/code-performance-optimization-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/code-work-mode-parity-2026-11-04.md](<../../aether-code/docs/code-work-mode-parity-2026-11-04.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/codex-aether-deep-comparison-2026-10-15.md](<../../aether-code/docs/codex-aether-deep-comparison-2026-10-15.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/codex-capability-integration-2026-10-14.md](<../../aether-code/docs/codex-capability-integration-2026-10-14.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/codex-reference-analysis-and-evolution-2026-10-13.md](<../../aether-code/docs/codex-reference-analysis-and-evolution-2026-10-13.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/codex-resource-monitor-audit-2026-10-15.md](<../../aether-code/docs/codex-resource-monitor-audit-2026-10-15.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/composer-defaults-verification.md](<../../aether-code/docs/composer-defaults-verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/README.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/README.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/capability-protocol-implementation.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/capability-protocol-implementation.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/client-ecosystem.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/client-ecosystem.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/codex-local-ecosystem.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/codex-local-ecosystem.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/codex-official-ecosystem.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/codex-official-ecosystem.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/codex-oss-tools.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/codex-oss-tools.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/ecosystem-implementation.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/ecosystem-implementation.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/engine-audit-intro.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/engine-audit-intro.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/engine-tools.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/engine-tools.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ecosystem-audit-2026-11-03/transcript-findings.md](<../../aether-code/docs/ecosystem-audit-2026-11-03/transcript-findings.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/editor-code-oss.md](<../../aether-code/docs/editor-code-oss.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/empty-model-response-investigation.md](<../../aether-code/docs/empty-model-response-investigation.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/engine-client-interaction-2026-11-03.md](<../../aether-code/docs/engine-client-interaction-2026-11-03.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/engine-monitor-design-2026-10-15.md](<../../aether-code/docs/engine-monitor-design-2026-10-15.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/engine-oom-investigation-2026-10-14.md](<../../aether-code/docs/engine-oom-investigation-2026-10-14.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/feature-map.md](<../../aether-code/docs/feature-map.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/frontend-architecture.md](<../../aether-code/docs/frontend-architecture.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/git-loading-acceptance-2026-11-05.md](<../../aether-code/docs/git-loading-acceptance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/git-menu-acceptance-2026-11-05.md](<../../aether-code/docs/git-menu-acceptance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/git-workspace-sync-verification.md](<../../aether-code/docs/git-workspace-sync-verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/history/browser-workflow-reliability-before-2026-11-17.md](<../../aether-code/docs/history/browser-workflow-reliability-before-2026-11-17.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/horizontal-scroll-audit-2026-11-09.md](<../../aether-code/docs/horizontal-scroll-audit-2026-11-09.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/local-engine-cron-schema-repair.md](<../../aether-code/docs/local-engine-cron-schema-repair.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/local-engine-startup-recovery.md](<../../aether-code/docs/local-engine-startup-recovery.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/office-content-audit-2026-11-10.md](<../../aether-code/docs/office-content-audit-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/office-generation-reliability-2026-11-10.md](<../../aether-code/docs/office-generation-reliability-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/office-preview-optimization-2026-11-03.md](<../../aether-code/docs/office-preview-optimization-2026-11-03.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/office-quality-20261110.md](<../../aether-code/docs/office-quality-20261110.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/office-work-adaptation-2026-10-15.md](<../../aether-code/docs/office-work-adaptation-2026-10-15.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/p1-upgrade-verification-2026-10-15.md](<../../aether-code/docs/p1-upgrade-verification-2026-10-15.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/plugin-api/AGENTS.md](<../../aether-code/docs/plugin-api/AGENTS.md>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/contributions.html](<../../aether-code/docs/plugin-api/content/contributions.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/events.html](<../../aether-code/docs/plugin-api/content/events.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/manifest.html](<../../aether-code/docs/plugin-api/content/manifest.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/native.html](<../../aether-code/docs/plugin-api/content/native.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/overview.html](<../../aether-code/docs/plugin-api/content/overview.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/page.html](<../../aether-code/docs/plugin-api/content/page.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/permissions.html](<../../aether-code/docs/plugin-api/content/permissions.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/content/platform.html](<../../aether-code/docs/plugin-api/content/platform.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/maintenance.html](<../../aether-code/docs/plugin-api/maintenance.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/plugin-api/template.html](<../../aether-code/docs/plugin-api/template.html>) | 插件 HTML 公开参考/维护 | 本文件；相关专题见文档首页 |
| [docs/popup-layer-and-menu-audit-2026-11-06.md](<../../aether-code/docs/popup-layer-and-menu-audit-2026-11-06.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ppt-composition-review-2026-11-10.md](<../../aether-code/docs/ppt-composition-review-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/ppt-design-acceptance-2026-11-10.md](<../../aether-code/docs/ppt-design-acceptance-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/project-storage.md](<../../aether-code/docs/project-storage.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/reply-images-acceptance-2026-11-05.md](<../../aether-code/docs/reply-images-acceptance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/sandbox-security-review.md](<../../aether-code/docs/sandbox-security-review.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/security-confirmation-fix-2026-10-10.md](<../../aether-code/docs/security-confirmation-fix-2026-10-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/session-storage-frontend-compatibility-2026-11-05.md](<../../aether-code/docs/session-storage-frontend-compatibility-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/shared-composer-model-picker-validation-2026-10-12.md](<../../aether-code/docs/shared-composer-model-picker-validation-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/silent-task-plan-and-six-session-soak-2026-10-12.md](<../../aether-code/docs/silent-task-plan-and-six-session-soak-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagent-durability-validation-2026-10-13.md](<../../aether-code/docs/subagent-durability-validation-2026-10-13.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagents/claude-reference.md](<../../aether-code/docs/subagents/claude-reference.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagents/decision.md](<../../aether-code/docs/subagents/decision.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagents/engine-audit.md](<../../aether-code/docs/subagents/engine-audit.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagents/implementation.md](<../../aether-code/docs/subagents/implementation.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagents/incident-2026-09-29.md](<../../aether-code/docs/subagents/incident-2026-09-29.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/subagents/wuzu-reference.md](<../../aether-code/docs/subagents/wuzu-reference.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/client-audit.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/client-audit.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/engine-audit.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/engine-audit.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/github-cases.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/github-cases.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/official-protocol-research.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/official-protocol-research.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/report.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/report.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/README.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/README.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-code-agent-teams-current.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-code-agent-teams-current.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-cross-session.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-cross-session.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-overview.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-overview.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-permissions.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-permissions.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-sessions.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-sessions.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-streaming-current.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-streaming-current.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-subagents-current.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/claude-sdk-subagents-current.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/FoundationAgents__MetaGPT/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/FoundationAgents__MetaGPT/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/OpenBMB__ChatDev/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/OpenBMB__ChatDev/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/OpenHands__OpenHands/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/OpenHands__OpenHands/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/crewAIInc__crewAI/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/crewAIInc__crewAI/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/gastownhall__gastown/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/gastownhall__gastown/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/gastownhall__gastown/files/docs/design/mail-protocol.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/gastownhall__gastown/files/docs/design/mail-protocol.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/langchain-ai__langgraph-supervisor-py/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/langchain-ai__langgraph-supervisor-py/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/langchain-ai__langgraph-swarm-py/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/langchain-ai__langgraph-swarm-py/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__agent-framework/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__agent-framework/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__autogen/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__autogen/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__magentic-ui/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__magentic-ui/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__magentic-ui/files/docs/limitations.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/microsoft__magentic-ui/files/docs/limitations.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/README.snapshot.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/README.snapshot.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/doc/experimental/issue-worktree-support.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/doc/experimental/issue-worktree-support.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/docs/api/issues.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/docs/api/issues.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/docs/guides/agent-developer/heartbeat-protocol.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/docs/guides/agent-developer/heartbeat-protocol.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/docs/guides/board-operator/costs-and-budgets.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/github/paperclipai__paperclip/files/docs/guides/board-operator/costs-and-budgets.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/openai-app-server-current.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/openai-app-server-current.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/openai-subagents.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/openai-subagents.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/supervisor-mode-research-2026-11-04/sources/openai-worktrees.md](<../../aether-code/docs/supervisor-mode-research-2026-11-04/sources/openai-worktrees.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/terminal-actions-verification.md](<../../aether-code/docs/terminal-actions-verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-account-identity-lifecycle-fix.md](<../../aether-code/docs/test-reports/2026-10-09-account-identity-lifecycle-fix.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-converged-baseline-full.md](<../../aether-code/docs/test-reports/2026-10-09-client-converged-baseline-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-full-acceptance.md](<../../aether-code/docs/test-reports/2026-10-09-client-full-acceptance.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-identity-fixed-full.md](<../../aether-code/docs/test-reports/2026-10-09-client-identity-fixed-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-r3-replay-new-freeze.md](<../../aether-code/docs/test-reports/2026-10-09-client-r3-replay-new-freeze.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-r4-final-terminal.md](<../../aether-code/docs/test-reports/2026-10-09-client-r4-final-terminal.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-r4-first-final-full.md](<../../aether-code/docs/test-reports/2026-10-09-client-r4-first-final-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-r4-second-final-full.md](<../../aether-code/docs/test-reports/2026-10-09-client-r4-second-final-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-session-composer-fix.md](<../../aether-code/docs/test-reports/2026-10-09-client-session-composer-fix.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-strict-intermediate-full.md](<../../aether-code/docs/test-reports/2026-10-09-client-strict-intermediate-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-client-unified-full.md](<../../aether-code/docs/test-reports/2026-10-09-client-unified-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-09-terminal-dpr-fit-fix.md](<../../aether-code/docs/test-reports/2026-10-09-terminal-dpr-fit-fix.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-10-client-e1214-engine-tgz.md](<../../aether-code/docs/test-reports/2026-10-10-client-e1214-engine-tgz.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-10-client-e1214-full.md](<../../aether-code/docs/test-reports/2026-10-10-client-e1214-full.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/test-reports/2026-10-10-client-quit-draft-fix.md](<../../aether-code/docs/test-reports/2026-10-10-client-quit-draft-fix.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/thinking-mode-verification.md](<../../aether-code/docs/thinking-mode-verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/tool-ergonomics-investigation-2026-10-08.md](<../../aether-code/docs/tool-ergonomics-investigation-2026-10-08.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/tool-feedback-compaction-2026-10-08.md](<../../aether-code/docs/tool-feedback-compaction-2026-10-08.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/tool-images-localization-verification.md](<../../aether-code/docs/tool-images-localization-verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/tool-profiles.md](<../../aether-code/docs/tool-profiles.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/two-hour-six-task-test-2026-10-13.md](<../../aether-code/docs/two-hour-six-task-test-2026-10-13.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/user-guide.md](<../../aether-code/docs/user-guide.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/work-agent-experience-validation.md](<../../aether-code/docs/work-agent-experience-validation.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-archive-display-20261105.md](<../../aether-code/docs/work-archive-display-20261105.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-browser-screenshot-acceptance-2026-11-05.md](<../../aether-code/docs/work-browser-screenshot-acceptance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-collaboration-activity-validation.md](<../../aether-code/docs/work-collaboration-activity-validation.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-cron-stream-hardening.md](<../../aether-code/docs/work-cron-stream-hardening.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-file-reveal-acceptance-2026-11-05.md](<../../aether-code/docs/work-file-reveal-acceptance-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-final-deliverables-2026-11-05.md](<../../aether-code/docs/work-final-deliverables-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-full-e2e-audit.md](<../../aether-code/docs/work-full-e2e-audit.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-icon-guidelines.md](<../../aether-code/docs/work-icon-guidelines.md>) | 现行指南 | 本文件；相关专题见文档首页 |
| [docs/work-message-actions-2026-11-03.md](<../../aether-code/docs/work-message-actions-2026-11-03.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-output-recovery-2026-11-03.md](<../../aether-code/docs/work-output-recovery-2026-11-03.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-performance-investigation-2026-10-12.md](<../../aether-code/docs/work-performance-investigation-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-performance-optimization-2026-10-12.md](<../../aether-code/docs/work-performance-optimization-2026-10-12.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-remaining-verification.md](<../../aether-code/docs/work-remaining-verification.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-scroll-to-bottom-20261105.md](<../../aether-code/docs/work-scroll-to-bottom-20261105.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-smoke-c-reaudit.md](<../../aether-code/docs/work-smoke-c-reaudit.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-soak-evidence-audit.md](<../../aether-code/docs/work-soak-evidence-audit.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-soak-plan.md](<../../aether-code/docs/work-soak-plan.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-turn-artifact-recovery-2026-11-05.md](<../../aether-code/docs/work-turn-artifact-recovery-2026-11-05.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/work-workspace-recovery-2026-11-06.md](<../../aether-code/docs/work-workspace-recovery-2026-11-06.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [docs/xlsx-charts-acceptance-2026-11-10.md](<../../aether-code/docs/xlsx-charts-acceptance-2026-11-10.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [e2e/fixtures/currency-converter/README.md](<../../aether-code/e2e/fixtures/currency-converter/README.md>) | 历史报告/提案（非当前承诺） | [现行指南](../../aether-code/docs/user-guide.md) |
| [scripts/office-invariant-observer.md](<../../aether-code/scripts/office-invariant-observer.md>) | 专项诊断流程（结果按原日期） | [现行指南](../../aether-code/docs/user-guide.md) |
| [scripts/office-resource-ui-validation.md](<../../aether-code/scripts/office-resource-ui-validation.md>) | 专项诊断流程（结果按原日期） | [现行指南](../../aether-code/docs/user-guide.md) |
| [scripts/office-ui-load-probe.md](<../../aether-code/scripts/office-ui-load-probe.md>) | 专项诊断流程（结果按原日期） | [现行指南](../../aether-code/docs/user-guide.md) |
| [scripts/office-v003-handshake-contract.md](<../../aether-code/scripts/office-v003-handshake-contract.md>) | 专项诊断流程（结果按原日期） | [现行指南](../../aether-code/docs/user-guide.md) |
| [scripts/office-v004-handshake-contract.md](<../../aether-code/scripts/office-v004-handshake-contract.md>) | 专项诊断流程（结果按原日期） | [现行指南](../../aether-code/docs/user-guide.md) |
| [scripts/office-verified-submit.md](<../../aether-code/scripts/office-verified-submit.md>) | 专项诊断流程（结果按原日期） | [现行指南](../../aether-code/docs/user-guide.md) |
| [src/renderer/index.html](<../../aether-code/src/renderer/index.html>) | 运行页面/示例资产（非说明文档） | 本文件；相关专题见文档首页 |
