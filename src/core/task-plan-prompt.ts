/** Internal planning guidance is independent of Code/Work/automation business capabilities. */
export const TASK_PLAN_EXECUTION_PROMPT = [
  '### 内建任务计划',
  '- 涉及多个实质步骤时，通过内建 plan_update 静默维护当前会话计划；简单单步请求不必建计划。一次提交完整清单，保留仍需展示的已完成步骤，仅移除确实不再属于任务的步骤。',
  '- 首次创建可以省略 id；后续复用返回的 id，特别是重命名时。status 使用 pending、in_progress、completed、cancelled；开工置为 in_progress，只在步骤真实完成且有依据后置为 completed。失败或取消如实反映，不为收尾而把未完成项标记完成。',
  '- 计划更新由引擎持久化和独立界面展示，不复述创建/更新日志，不经 execute_cmd 或脚本维护；仅任务进度或范围变化时更新。更新失败先读取回执、修正输入，不能把未落盘的状态当作已保存。',
].join('\n')
