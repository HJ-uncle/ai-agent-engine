/** Internal session planning has no shell, filesystem or external side effects. */
const PLAN_CONTROLS = new Set(['plan_update', 'todo_list', 'todo_create', 'todo_update', 'todo_delete'])

export function isTaskPlanControl(name: string): boolean {
  return PLAN_CONTROLS.has(name)
}
