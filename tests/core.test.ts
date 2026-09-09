import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { createRuntime, run, type Runtime } from '../src/server/runtime'
import { Tasks } from '../src/core/service'
import { resolveRef } from '../src/core/storage'
import type { Task } from '../src/core/schema'

let root: string, path: string, runtime: Runtime, checkoutId: string
const call = <A>(action: (service: Tasks['Service']) => Effect.Effect<A, import('../src/core/schema').SdsError>) => run(runtime, Tasks.use(action))
async function create() {
  const result = await call(service => service.create({ checkoutId, title: 'Ship reset flow', todos: [{ title: 'Endpoint' }, { title: 'Tests' }] }))
  if (!result.ok) throw result.error
  return result.data
}
async function stored(id: string) { return JSON.parse(await readFile(join(path, '.agent-work/tasks', `${id}.json`), 'utf8')) as Task }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sds-test-')); path = join(root, 'repo'); await mkdir(path)
  runtime = createRuntime(join(root, 'state'))
  const result = await call(service => service.register({ path }))
  if (!result.ok) throw result.error
  checkoutId = result.data.id
})
afterEach(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })

describe('repository operations', () => {
  test('register is stable, worktrees share project but isolate task versions', async () => {
    const task = await create()
    const again = await call(service => service.register({ path }))
    expect(again.ok && again.data.id).toBe(checkoutId)
    const worktree = join(root, 'worktree'); await cp(path, worktree, { recursive: true })
    const second = await call(service => service.register({ path: worktree }))
    if (!second.ok || !again.ok) throw new Error('register failed')
    expect(second.data.id).not.toBe(checkoutId)
    expect(second.data.projectId).toBe(again.data.projectId)
    await call(service => service.update({ checkoutId: second.data.id, taskId: task.id, expectedRevision: 1, operations: [{ type: 'title.set', title: 'Worktree version' }] }))
    expect((await stored(task.id)).title).toBe('Ship reset flow')
  })
  test('batch updates complete todos and record findings in one revision', async () => {
    const task = await create()
    const result = await call(service => service.update({ checkoutId, taskId: task.ref, expectedRevision: 1, operations: [
      { type: 'todo.complete', todoIds: task.todos.map(todo => todo.ref) },
      { type: 'finding.add', severity: 'high', description: 'Tokens can be reused', file: 'src/reset.ts', line: 42 },
      { type: 'stage.set', stage: 'reviewing' },
      { type: 'note.add', text: 'Verified endpoint and tests.' },
    ] }))
    expect(result.ok && result.data.revision).toBe(2)
    const data = await stored(task.id)
    expect(data.todos.every(todo => todo.status === 'done')).toBe(true)
    expect(data.findings[0]?.line).toBe(42)
    expect(data.notes).toHaveLength(1)
    expect(data.history).toHaveLength(2)
  })
  test('invalid operation rolls back entire batch', async () => {
    const task = await create()
    const before = await stored(task.id)
    const result = await call(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 1, operations: [
      { type: 'title.set', title: 'Must not persist' }, { type: 'todo.complete', todoIds: ['missing'] },
    ] }))
    expect(result.ok).toBe(false)
    expect(await stored(task.id)).toEqual(before)
  })
  test('concurrent runtimes reject stale revisions without losing updates', async () => {
    const task = await create()
    const other = createRuntime(join(root, 'state'))
    try {
      const update = (title: string) => Tasks.use(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 1, operations: [{ type: 'title.set', title }] }))
      const results = await Promise.all([run(runtime, update('Writer A')), run(other, update('Writer B'))])
      expect(results.filter(result => result.ok)).toHaveLength(1)
      expect(results.find(result => !result.ok)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect((await stored(task.id)).revision).toBe(2)
    } finally { await other.dispose() }
  })
  test('short references reject ambiguity; traversal and unknown input fields rejected', async () => {
    const result = await Effect.runPromise(resolveRef([{ id: 'abcdef111' }, { id: 'abcdef222' }], 'abcd').pipe(Effect.result))
    expect(result._tag).toBe('Failure')
    const task = await create()
    const invalid = await call(service => service.get({ checkoutId, taskId: '../secret' }))
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await call(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 1, operations: [{ type: 'title.set', title: 'x', typo: true }] }))).toMatchObject({ ok: false })
  })
  test('working view excludes closed items and history paginates newest first', async () => {
    const task = await create()
    await call(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 1, operations: [{ type: 'todo.complete', todoIds: [task.todos[0]!.id] }] }))
    const result = await call(service => service.get({ checkoutId, taskId: task.id }))
    expect(result.ok && 'todos' in result.data && result.data.todos).toHaveLength(1)
    const history = await call(service => service.get({ checkoutId, taskId: task.id, view: 'history', limit: 1 }))
    expect(history.ok && 'items' in history.data && history.data.items?.[0]?.revision).toBe(2)
    expect(history.ok && 'nextOffset' in history.data && history.data.nextOffset).toBe(1)
  })
  test('heartbeat does not modify task data', async () => {
    const task = await create(); const before = await stored(task.id)
    await call(service => service.heartbeat({ checkoutId, taskId: task.id, agent: 'test-agent', running: true }))
    const view = await call(service => service.get({ checkoutId, taskId: task.id }))
    expect(view.ok && 'activity' in view.data && view.data.activity.running).toBe(true)
    expect(await stored(task.id)).toEqual(before)
    await call(service => service.heartbeat({ checkoutId, taskId: task.id, agent: 'test-agent', running: false }))
  })
  test('blocked status requires reason and clearing it removes blocker', async () => {
    const task = await create()
    expect(await call(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 1, operations: [{ type: 'status.set', status: 'blocked' }] }))).toMatchObject({ ok: false })
    await call(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 1, operations: [{ type: 'status.set', status: 'blocked', reason: 'Waiting for API' }] }))
    await call(service => service.update({ checkoutId, taskId: task.id, expectedRevision: 2, operations: [{ type: 'status.set', status: 'active' }] }))
    expect((await stored(task.id)).blocker).toBeUndefined()
  })
  test('corrupt schema and symlink task files fail explicitly', async () => {
    const task = await create()
    const file = join(path, '.agent-work/tasks', `${task.id}.json`)
    await writeFile(file, '{"schemaVersion":99}')
    expect(await call(service => service.get({ checkoutId, taskId: task.id }))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await rm(file); await symlink(join(root, 'secret'), file)
    expect(await call(service => service.get({ checkoutId, taskId: task.id }))).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } })
  })
})

test('recursive subtasks retain independent state and support branch moves and detach', async () => {
  const top = await create()
  let parent = top.id
  const descendants: string[] = []
  for (let depth = 0; depth < 6; depth++) {
    const child = await call(service => service.create({ checkoutId, parentId: parent.slice(0, 6), title: `Depth ${depth + 1}` }))
    if (!child.ok) throw child.error
    expect(child.data.parentId).toBe(parent)
    descendants.push(child.data.id); parent = child.data.id
  }
  const view = await call(service => service.get({ checkoutId, taskId: parent }))
  expect(view).toMatchObject({ ok: true, data: { parentId: descendants[4], ancestors: [{ id: top.id }, ...descendants.slice(0, -1).map(id => ({ id }))] } })
  const direct = await call(service => service.list({ checkoutId, parentId: top.ref }))
  expect(direct.ok && direct.data.items.map(task => task.id)).toEqual([descendants[0]!])
  const recursive = await call(service => service.list({ checkoutId, parentId: top.ref, recursive: true, limit: 2 }))
  expect(recursive).toMatchObject({ ok: true, data: { total: 6, nextOffset: 2 } })
  const root = await call(service => service.list({ checkoutId, parentId: null }))
  expect(root.ok && root.data.items.map(task => task.id)).toEqual([top.id])
  const invalid = await call(service => service.update({ checkoutId, taskId: top.id, expectedRevision: 1, operations: [{ type: 'title.set', title: 'Should roll back' }, { type: 'parent.set', parentId: parent }] }))
  expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect((await stored(top.id)).title).toBe('Ship reset flow')
  const moved = await call(service => service.update({ checkoutId, taskId: descendants[0], expectedRevision: 1, operations: [{ type: 'parent.set', parentId: null }, { type: 'status.set', status: 'done' }] }))
  expect(moved).toMatchObject({ ok: true, data: { parentId: null, revision: 2 } })
  expect((await stored(top.id)).revision).toBe(1)
  expect((await stored(descendants[1]!)).status).toBe('queued')
  const detached = await call(service => service.get({ checkoutId, taskId: parent }))
  expect(detached.ok && 'ancestors' in detached.data && detached.data.ancestors.map(task => task.id)).toEqual(descendants.slice(0, -1))
  expect(await call(service => service.update({ checkoutId, taskId: descendants[0], expectedRevision: 1, operations: [{ type: 'parent.set', parentId: top.id }] }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
})

test('concurrent opposite parent moves cannot create a cycle across runtimes', async () => {
  const a = await create(), b = await create()
  const otherRuntime = createRuntime(join(root, 'state'))
  try {
    const updates = await Promise.all([
      call(service => service.update({ checkoutId, taskId: a.id, expectedRevision: 1, operations: [{ type: 'parent.set', parentId: b.id }] })),
      run(otherRuntime, Tasks.use(service => service.update({ checkoutId, taskId: b.id, expectedRevision: 1, operations: [{ type: 'parent.set', parentId: a.id }] }))),
    ])
    expect(updates.filter(result => result.ok)).toHaveLength(1)
    expect(updates.filter(result => !result.ok)).toMatchObject([{ ok: false, error: { code: 'INVALID_INPUT' } }])
    expect(await call(service => service.list({ checkoutId }))).toMatchObject({ ok: true, data: { total: 2 } })
  } finally { await otherRuntime.dispose() }
})

test('parent refs stay in checkout; invalid graph imported from files is reported and can be detached', async () => {
  const parent = await create()
  const otherPath = join(root, 'other'); await mkdir(otherPath)
  const other = await call(service => service.register({ path: otherPath })); if (!other.ok) throw other.error
  expect(await call(service => service.create({ checkoutId: other.data.id, parentId: parent.id, title: 'Wrong checkout' }))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(await call(service => service.update({ checkoutId, taskId: parent.id, expectedRevision: 1, operations: [{ type: 'parent.set', parentId: parent.ref }] }))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  const original = await stored(parent.id)
  await writeFile(join(path, '.agent-work/tasks', `${parent.id}.json`), JSON.stringify({ ...original, parentId: parent.id }))
  expect(await call(service => service.list({ checkoutId }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  expect(await call(service => service.get({ checkoutId, taskId: parent.id }))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  expect(await call(service => service.update({ checkoutId, taskId: parent.id, expectedRevision: 1, operations: [{ type: 'parent.set', parentId: null }] }))).toMatchObject({ ok: true })
  expect(await call(service => service.list({ checkoutId }))).toMatchObject({ ok: true })
})

describe('task dependencies', () => {
  test('resolves refs, exposes both directions, rejects cycles and detaches', async () => {
    const a = await create(), b = await create(), c = await create()
    const set = (id: string, revision: number, dependencyIds: string[]) => call(service => service.update({ checkoutId, taskId: id, expectedRevision: revision, operations: [{ type: 'dependencies.set', dependencyIds }] }))
    expect((await set(b.id, 1, [a.ref, a.id])).ok).toBe(true)
    expect((await stored(b.id)).dependencyIds).toEqual([a.id])
    expect((await set(c.id, 1, [b.ref])).ok).toBe(true)
    expect((await set(a.id, 1, [c.id])).ok).toBe(false)
    expect((await set(a.id, 1, [a.id])).ok).toBe(false)
    expect((await set(a.id, 1, ['missing'])).ok).toBe(false)
    expect((await stored(a.id)).revision).toBe(1)
    const view = await call(service => service.get({ checkoutId, taskId: b.id, view: 'full' }))
    if (!view.ok || !('dependencies' in view.data)) throw new Error('Expected dependency view')
    expect(view.data.dependencies.map(task => task.id)).toEqual([a.id])
    expect(view.data.dependents.map(task => task.id)).toEqual([c.id])
    expect((await set(b.id, 2, [])).ok).toBe(true)
    expect((await stored(b.id)).dependencyIds).toEqual([])
  })
  test('opposing concurrent dependency writes cannot create a cycle', async () => {
    const a = await create(), b = await create()
    const results = await Promise.all([[a.id, b.id], [b.id, a.id]].map(([id, dependency]) => call(service => service.update({ checkoutId, taskId: id, expectedRevision: 1, operations: [{ type: 'dependencies.set', dependencyIds: [dependency] }] }))))
    expect(results.filter(result => result.ok)).toHaveLength(1)
  })
  test('creation validates dependencies and legacy files remain readable', async () => {
    const a = await create()
    const legacy = await stored(a.id); delete (legacy as { dependencyIds?: readonly string[] }).dependencyIds
    await writeFile(join(path, '.agent-work/tasks', `${a.id}.json`), JSON.stringify(legacy))
    const created = await call(service => service.create({ checkoutId, title: 'Dependent', dependencyIds: [a.ref] }))
    expect(created.ok).toBe(true)
    if (created.ok) expect((await stored(created.data.id)).dependencyIds).toEqual([a.id])
    const view = await call(service => service.get({ checkoutId, taskId: a.id, view: 'full' }))
    expect(view.ok && 'dependencyIds' in view.data && view.data.dependencyIds).toEqual([])
  })
})
