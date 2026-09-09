import type { Task } from './schema'
import { failure } from './storage'

// Parent links live only on the child, so moving a subtree writes one task file.
export function hierarchy(tasks: readonly Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const children = new Map<string | null, Task[]>()
  for (const task of tasks) {
    const parent = task.parentId ?? null
    const siblings = children.get(parent) ?? []
    siblings.push(task); children.set(parent, siblings)
  }
  function ancestors(id: string): Task[] {
    const result: Task[] = [], visited = new Set([id])
    let parentId = byId.get(id)?.parentId
    while (parentId) {
      if (visited.has(parentId)) throw failure('CONFLICT', `Task hierarchy contains a cycle at ${parentId}; correct its parent link.`)
      visited.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) throw failure('CONFLICT', `Parent task ${parentId} is missing from this checkout; restore it or detach the child.`)
      result.push(parent); parentId = parent.parentId
    }
    return result.reverse()
  }
  return { byId, children, ancestors }
}
