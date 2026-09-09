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
