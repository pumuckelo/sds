import { Context, DateTime, Effect, Layer } from 'effect'
import { basename, join } from 'node:path'
import { newId } from './ids'
import * as S from './schema'
import { hierarchy } from './hierarchy'
import { Storage, decode, failure, resolveRef, shortRef } from './storage'

const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso))
const createService = Effect.gen(function* () {
  const storage = yield* Storage
  const registryFile = join(storage.stateDir, 'registry.json')
  const registry = Effect.fn('registry')(function* () {
    const value = yield* storage.read(registryFile)
    return value === undefined ? { schemaVersion: 1 as const, checkouts: [] as readonly S.Checkout[] } : yield* decode(S.Registry, value)
  })
  const checkout = Effect.fn('checkout')(function* (id: string) {
    const entry = yield* resolveRef((yield* registry()).checkouts, id)
    const path = yield* storage.canonical(entry.path)
    yield* storage.ensureRepo(path)
    const project = yield* decode(S.Project, yield* storage.read(join(path, '.agent-work/project.json')))
    if (project.id !== entry.projectId) return yield* failure('CONFLICT', 'Project identity changed; register this checkout again.')
    return { ...entry, path }
  })
  const readTask = Effect.fn('readTask')(function* (entry: S.Checkout, id: string) {
    const value = yield* storage.read(join(entry.path, '.agent-work/tasks', `${id}.json`))
    if (value === undefined) return yield* failure('NOT_FOUND', `Task ${id} no longer exists`)
    const task = yield* decode(S.Task, value)
    if (task.id !== id) return yield* failure('STORAGE_ERROR', `Task ID does not match filename: ${id}`)
    return task
  })
  const taskId = Effect.fn('taskId')(function* (entry: S.Checkout, ref: string) {
    return (yield* resolveRef((yield* storage.taskFiles(entry.path)).map(file => ({ id: file.slice(0, -5) })), ref)).id
  })
  const allTasks = Effect.fn('task.all')(function* (entry: S.Checkout) {
    return yield* Effect.forEach(yield* storage.taskFiles(entry.path), file => readTask(entry, file.slice(0, -5)))
  })
  const validateParent = Effect.fn('task.validateParent')(function* (entry: S.Checkout, id: string, ref: string | null) {
    if (ref === null) return undefined
    const all = yield* allTasks(entry)
    const parent = yield* resolveRef(all, ref)
    const ancestors = yield* Effect.try({ try: () => hierarchy(all).ancestors(parent.id), catch: error => error as S.SdsError })
    if (parent.id === id || ancestors.some(task => task.id === id)) return yield* failure('INVALID_INPUT', 'A task cannot be its own parent or move beneath one of its descendants')
    return parent.id
  })
  const validateDependencies = Effect.fn('task.validateDependencies')(function* (entry: S.Checkout, id: string, refs: readonly string[]) {
    const all = yield* allTasks(entry)
    const resolved = yield* Effect.forEach(refs, ref => resolveRef(all, ref))
    const ids = [...new Set(resolved.map(task => task.id))]
    const byId = new Map(all.map(task => [task.id, task]))
    const pending = [...ids], visited = new Set<string>()
    while (pending.length) {
      const current = pending.pop()!
      if (current === id) return yield* failure('INVALID_INPUT', 'Dependencies cannot contain a self-reference or cycle')
      if (visited.has(current)) continue
      visited.add(current)
      const dependency = byId.get(current)
      if (!dependency) return yield* failure('CONFLICT', `Dependency ${current} is missing from this checkout`)
      pending.push(...(dependency.dependencyIds ?? []))
    }
    return ids
  })
  const brief = (task: S.Task, all: readonly S.Task[]) => ({ id: task.id, ref: shortRef(task.id, all), title: task.title, status: task.status, stage: task.stage })
  const live = new Map<string, { agent: string; seenAt: string; expiresAt: number }>()
  const activity = Effect.fn('activity')(function* (checkoutId: string, id: string) {
    const current = live.get(`${checkoutId}/${id}`)
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    return current && current.expiresAt > now ? { running: true, agent: current.agent, seenAt: current.seenAt } : { running: false }
  })
  const register = Effect.fn('register')(function* (raw: unknown) {
    const input = yield* decode(S.RegisterInput, raw)
    const path = yield* storage.canonical(input.path)
    return yield* storage.lock(registryFile, Effect.gen(function* () {
      const root = yield* storage.ensureRepo(path)
      const projectFile = join(root, 'project.json')
      const project = yield* storage.lock(projectFile, Effect.gen(function* () {
        const value = yield* storage.read(projectFile)
        if (value !== undefined) return yield* decode(S.Project, value)
        const project = { schemaVersion: 1 as const, id: newId(), name: input.name ?? basename(path) }
        yield* decode(S.Project, project)
        yield* storage.write(projectFile, project)
        return project
      }))
      const current = yield* registry()
      const previous = current.checkouts.find(item => item.path === path)
      const entry = { id: previous?.id ?? newId(), projectId: project.id, path, name: input.name ?? previous?.name ?? basename(path) }
      yield* storage.write(registryFile, { ...current, checkouts: [...current.checkouts.filter(item => item.path !== path), entry] })
      return { ...entry, projectName: project.name, url: `/checkouts/${entry.id}` }
    }))
  })
  const checkouts = Effect.fn('checkouts')(function* () {
    return yield* Effect.forEach((yield* registry()).checkouts, entry => Effect.gen(function* () {
      yield* storage.canonical(entry.path)
      const project = yield* decode(S.Project, yield* storage.read(join(entry.path, '.agent-work/project.json')))
      if (project.id !== entry.projectId) return yield* failure('CONFLICT', 'Project identity changed; register again')
      return { ...entry, projectName: project.name, available: true, error: null as string | null }
    }).pipe(Effect.catch(error => Effect.succeed({ ...entry, projectName: entry.name, available: false, error: error.message }))))
  })
  const create = Effect.fn('task.create')(function* (raw: unknown) {
    const input = yield* decode(S.CreateInput, raw)
    const entry = yield* checkout(input.checkoutId)
    return yield* storage.lock(join(entry.path, '.agent-work/tasks'), Effect.gen(function* () {
      const now = yield* timestamp
      let id = newId()
      const ids = new Set((yield* storage.taskFiles(entry.path)).map(file => file.slice(0, -5)))
      while (ids.has(id)) id = newId()
      const parentId = yield* validateParent(entry, id, input.parentId ?? null)
      const dependencyIds = yield* validateDependencies(entry, id, input.dependencyIds ?? [])
      const task: S.Task = { schemaVersion: 1, id, parentId, dependencyIds, title: input.title, description: input.description ?? '', stage: 'planning', status: 'queued', revision: 1, createdAt: now, updatedAt: now, todos: (input.todos ?? []).map(todo => ({ ...todo, id: newId(), status: 'pending' as const })), findings: [], notes: [], history: [{ id: newId(), revision: 1, at: now, changes: ['Task created'] }] }
      yield* decode(S.Task, task)
      yield* storage.write(join(entry.path, '.agent-work/tasks', `${id}.json`), task)
      return { id, ref: shortRef(id, [...ids].map(id => ({ id }))), parentId: parentId ?? null, revision: 1, todos: task.todos.map(todo => ({ id: todo.id, ref: shortRef(todo.id, task.todos), ...(input.verbose ? { title: todo.title } : {}) })), url: `/checkouts/${entry.id}/tasks/${id}` }
    }))
  })
  const list = Effect.fn('task.list')(function* (raw: unknown) {
    const input = yield* decode(S.ListInput, raw)
    const entry = yield* checkout(input.checkoutId)
    const all = yield* allTasks(entry)
    const graph = hierarchy(all)
    const ancestors = yield* Effect.try({ try: () => new Map(all.map(task => [task.id, graph.ancestors(task.id)])), catch: error => error as S.SdsError })
    const parentId = input.parentId == null ? input.parentId : (yield* resolveRef(all, input.parentId)).id
    if (input.recursive && typeof parentId !== 'string') return yield* failure('INVALID_INPUT', 'recursive requires a parentId task reference')
    const filtered = all.filter(task => (parentId === undefined || (input.recursive ? ancestors.get(task.id)!.some(parent => parent.id === parentId) : (task.parentId ?? null) === parentId)) && (!input.status || task.status === input.status) && (!input.stage || task.stage === input.stage) && (!input.query || `${task.title} ${task.description}`.toLowerCase().includes(input.query.toLowerCase()))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const offset = input.offset ?? 0, limit = input.limit ?? 50
    const items = yield* Effect.forEach(filtered.slice(offset, offset + limit), task => Effect.gen(function* () {
      return { dependencyIds: task.dependencyIds ?? [], parentId: task.parentId ?? null, subtaskCount: graph.children.get(task.id)?.length ?? 0, id: task.id, ref: shortRef(task.id, all), title: task.title, stage: task.stage, status: task.status, revision: task.revision, updatedAt: task.updatedAt, todoCount: task.todos.filter(todo => todo.status !== 'cancelled').length, completedTodos: task.todos.filter(todo => todo.status === 'done').length, openFindings: task.findings.filter(finding => finding.status === 'open').length, activity: yield* activity(entry.id, task.id) }
    }))
    return { items, total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null }
  })
  const get = Effect.fn('task.get')(function* (raw: unknown) {
    const input = yield* decode(S.GetInput, raw)
    const entry = yield* checkout(input.checkoutId)
    const task = yield* readTask(entry, yield* taskId(entry, input.taskId))
    const offset = input.offset ?? 0, limit = input.limit ?? 50
    if (input.view === 'history') {
      const history = [...task.history].reverse()
      return { id: task.id, revision: task.revision, items: history.slice(offset, offset + limit), total: history.length, nextOffset: offset + limit < history.length ? offset + limit : null }
    }
    const all = yield* allTasks(entry)
    const graph = hierarchy(all)
    const ancestors = yield* Effect.try({ try: () => graph.ancestors(task.id).map(parent => brief(parent, all)), catch: error => error as S.SdsError })
    const enriched = { ...task, dependencyIds: task.dependencyIds ?? [], dependencies: (task.dependencyIds ?? []).map(id => { const dependency = all.find(item => item.id === id); return dependency ? brief(dependency, all) : { id, ref: id.slice(0, 6), title: 'Missing task', status: 'missing', stage: 'unknown' } }), dependents: all.filter(item => item.dependencyIds?.includes(task.id)).map(item => brief(item, all)), ancestors, subtaskCount: graph.children.get(task.id)?.length ?? 0, todos: task.todos.map(todo => ({ ...todo, ref: shortRef(todo.id, task.todos) })), findings: task.findings.map(finding => ({ ...finding, ref: shortRef(finding.id, task.findings) })), activity: yield* activity(entry.id, task.id) }
    if (input.view === 'full') return enriched
    const { history, notes, ...working } = enriched
    return { ...working, todos: working.todos.filter(todo => todo.status === 'pending'), findings: working.findings.filter(finding => finding.status === 'open'), notes: notes.slice(-3), historyCount: history.length }
  })
  const update = Effect.fn('task.update')(function* (raw: unknown) {
    const input = yield* decode(S.UpdateInput, raw)
    const entry = yield* checkout(input.checkoutId)
    const id = yield* taskId(entry, input.taskId)
    const file = join(entry.path, '.agent-work/tasks', `${id}.json`)
    const mutation = storage.lock(file, Effect.gen(function* () {
      const task = yield* readTask(entry, id)
      if (task.revision !== input.expectedRevision) return yield* failure('CONFLICT', `Expected revision ${input.expectedRevision}, current revision is ${task.revision}. Read the task before retrying.`)
      let next = { ...task, todos: [...task.todos], findings: [...task.findings], notes: [...task.notes], history: [...task.history] }
      const now = yield* timestamp
      const changes: string[] = []
      const added: { type: string; id: string; ref: string }[] = []
      for (const op of input.operations) {
        switch (op.type) {
          case 'dependencies.set': next.dependencyIds = yield* validateDependencies(entry, id, op.dependencyIds); changes.push(`Dependencies: ${next.dependencyIds.join(', ') || 'none'}`); break
          case 'parent.set': next.parentId = yield* validateParent(entry, id, op.parentId); changes.push(next.parentId ? `Parent: ${next.parentId}` : 'Moved to top level'); break
          case 'title.set': next.title = op.title; changes.push('Title updated'); break
          case 'description.set': next.description = op.description; changes.push('Description updated'); break
          case 'stage.set': next.stage = op.stage; changes.push(`Stage: ${op.stage}`); break
          case 'status.set':
            if (op.status === 'blocked' && !op.reason?.trim()) return yield* failure('INVALID_INPUT', 'A blocked task needs a reason')
            next.status = op.status; next.blocker = op.status === 'blocked' ? op.reason : undefined; changes.push(`Status: ${op.status}`); break
          case 'todo.add': {
            const todo = { id: newId(), title: op.title, stage: op.stage, status: 'pending' as const }
            next.todos.push(todo); added.push({ type: 'todo', id: todo.id, ref: '' }); changes.push(`Todo added: ${op.title}`); break
          }
          case 'todo.update': {
            const todo = yield* resolveRef(next.todos, op.todoId)
            next.todos = next.todos.map(item => item.id === todo.id ? { ...item, title: op.title ?? item.title, status: op.status ?? item.status, stage: op.stage ?? item.stage } : item)
            changes.push(`Todo updated: ${todo.title}`); break
          }
          case 'todo.complete':
            for (const ref of op.todoIds) {
              const todo = yield* resolveRef(next.todos, ref)
              next.todos = next.todos.map(item => item.id === todo.id ? { ...item, status: 'done' as const } : item)
              changes.push(`Todo completed: ${todo.title}`)
            }
            break
          case 'finding.add': {
            const finding = { id: newId(), description: op.description, severity: op.severity, file: op.file, line: op.line, status: 'open' as const }
            next.findings.push(finding); added.push({ type: 'finding', id: finding.id, ref: '' }); changes.push(`Finding added (${op.severity})`); break
          }
          case 'finding.resolve': {
            const finding = yield* resolveRef(next.findings, op.findingId)
            next.findings = next.findings.map(item => item.id === finding.id ? { ...item, status: op.status, resolution: op.resolution } : item)
            changes.push(`Finding ${op.status}: ${finding.id}`); break
          }
          case 'note.add': next.notes.push({ id: newId(), text: op.text, createdAt: now }); changes.push('Progress note added'); break
        }
      }
      next.revision++; next.updatedAt = now
      next.history.push({ id: newId(), revision: next.revision, at: now, changes })
      yield* decode(S.Task, next)
      yield* storage.write(file, next)
      return { id, parentId: next.parentId ?? null, revision: next.revision, operationCount: input.operations.length, changeCount: changes.length, ...(input.verbose ? { changes } : {}), added: added.map(item => ({ ...item, ref: shortRef(item.id, item.type === 'todo' ? next.todos : next.findings) })) }
    }))
    // All hierarchy mutations share the create lock. Acquire it before task locks
    // so simultaneous A→B and B→A moves cannot both pass cycle validation.
    return yield* input.operations.some(op => op.type === 'parent.set' || op.type === 'dependencies.set')
      ? storage.lock(join(entry.path, '.agent-work/tasks'), mutation)
      : mutation
  })
  const outcome = <A>(taskId: string, effect: Effect.Effect<A, S.SdsError>) => effect.pipe(Effect.match({
    onSuccess: data => ({ taskId, ok: true as const, data }),
    onFailure: error => ({ taskId, ok: false as const, error: { code: error.code, message: error.message } }),
  }))
  const summarize = <A extends { ok: boolean }>(items: readonly A[]) => ({ items, succeeded: items.filter(item => item.ok).length, failed: items.filter(item => !item.ok).length })
  const getMany = Effect.fn('task.getMany')(function* (raw: unknown) {
    const { taskIds, ...input } = yield* decode(S.GetManyInput, raw)
    return summarize(yield* Effect.forEach(taskIds, taskId => outcome(taskId, get({ ...input, taskId }))))
  })
  const updateMany = Effect.fn('task.updateMany')(function* (raw: unknown) {
    // Validate the complete shape before writing, then process in order. Each task
    // update is atomic; successful entries are not rolled back by later failures.
    const { updates, ...input } = yield* decode(S.UpdateManyInput, raw)
    return summarize(yield* Effect.forEach(updates, item => outcome(item.taskId, update({ ...input, ...item }))))
  })
  const heartbeat = Effect.fn('heartbeat')(function* (raw: unknown) {
    const input = yield* decode(S.HeartbeatInput, raw)
    const entry = yield* checkout(input.checkoutId)
    const id = yield* taskId(entry, input.taskId)
    const now = yield* DateTime.now
    const key = `${entry.id}/${id}`
    if (input.running) live.set(key, { agent: input.agent, seenAt: DateTime.formatIso(now), expiresAt: DateTime.toEpochMillis(now) + 60_000 })
    else live.delete(key)
    return { id, running: input.running, expiresInSeconds: input.running ? 60 : 0 }
  })
  return { register, checkouts, create, list, get, getMany, update, updateMany, heartbeat }
})
export class Tasks extends Context.Service<Tasks, Effect.Success<typeof createService>>()('sds/Tasks') {
  static layer = Layer.effect(Tasks, createService)
}
export type TaskList = Effect.Success<ReturnType<Tasks['Service']['list']>>
export type CheckoutList = Effect.Success<ReturnType<Tasks['Service']['checkouts']>>
