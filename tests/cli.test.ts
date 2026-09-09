import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Tasks } from '../src/core/service'
import { createRuntime, run } from '../src/core/runtime'

const cli = resolve(import.meta.dir, '../src/cli/main.ts')
let root: string, project: string, stateDir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sds-cli-'))
  project = join(root, 'repo'); stateDir = join(root, 'state')
  await mkdir(project)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function command(args: string[], options: { cwd?: string; stdin?: string } = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd: options.cwd ?? project, env: { ...process.env, SDS_STATE_DIR: stateDir, NO_COLOR: '1' }, stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin), stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}
async function success<T>(args: string[], options?: { cwd?: string; stdin?: string }): Promise<T> {
  const result = await command(args, options)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout) as T
}
type Created = { id: string; ref: string; revision: number; todos: { id: string; ref: string }[] }
type TaskView = { id: string; title: string; description: string; revision: number; stage: string; status: string; notes: { text: string }[]; todos: { id: string; status: string }[]; findings: { id: string; status: string; resolution?: string }[] }
const create = () => success<Created>(['task', 'create', '--json', JSON.stringify({ title: 'CLI task', todos: [{ title: 'Implement' }, { title: 'Verify' }] })])

test('CLI works offline: create from stdin, discover checkout from subfolder, complete several todos', async () => {
  const registered = await success<{ id: string }>(['init'])
  const task = await success<Created>(['task', 'create', '--stdin'], { stdin: JSON.stringify({ title: 'Offline task', todos: [{ title: 'Implement' }, { title: 'Verify' }] }) })
  const subdir = join(project, 'src/deep'); await mkdir(subdir, { recursive: true })
  const receipt = await success<{ revision: number }>(['todo', 'complete', task.ref, ...task.todos.map(todo => todo.ref), '--revision', '1'], { cwd: subdir })
  expect(receipt.revision).toBe(2)
  const view = await success<TaskView>(['task', 'get', task.ref, '--view', 'full'])
  expect(view.todos.every(todo => todo.status === 'done')).toBe(true)
  const runtime = createRuntime(stateDir)
  try {
    const shared = await run(runtime, Tasks.use(service => service.get({ checkoutId: registered.id, taskId: task.id, view: 'full' })))
    expect(shared).toMatchObject({ ok: true, data: { revision: 2 } })
  } finally { await runtime.dispose() }
})

test('inline batches preserve multiline text and support finding resolution', async () => {
  await success(['init']); const task = await create()
  const text = 'Literal $HOME and `code`\n"Quoted text" and Unicode: ✓'
  const receipt = await success<{ revision: number; added: { ref: string }[] }>(['task', 'update', task.ref, '--revision', '1', '--json', JSON.stringify({ operations: [{ type: 'note.add', text }, { type: 'finding.add', severity: 'high', description: text }, { type: 'stage.set', stage: 'reviewing' }] })])
  await success(['task', 'update', task.ref, '--stdin'], { stdin: JSON.stringify({ expectedRevision: receipt.revision, operations: [{ type: 'finding.resolve', findingId: receipt.added[0]!.ref, status: 'resolved', resolution: 'Verified' }, { type: 'status.set', status: 'done' }] }) })
  const view = await success<TaskView>(['task', 'get', task.ref, '--view', 'full'])
  expect(view.notes[0]!.text).toBe(text)
  expect(view.findings[0]).toMatchObject({ status: 'resolved', resolution: 'Verified' })
  expect(view.status).toBe('done')
})

test('concurrent CLI writers preserve revisions; invalid batches roll back', async () => {
  await success(['init']); const task = await create()
  const writers = await Promise.all(['First', 'Second'].map(text => command(['note', 'add', task.ref, text, '--revision', '1'])))
  expect(writers.map(result => result.code).sort()).toEqual([0, 1])
  expect(JSON.parse(writers.find(result => result.code === 1)!.stderr)).toMatchObject({ error: { code: 'CONFLICT' } })
  const invalid = await command(['task', 'update', task.ref, '--revision', '2', '--json', JSON.stringify({ operations: [{ type: 'title.set', title: 'Should roll back' }, { type: 'todo.complete', todoIds: ['missing'] }] })])
  expect(invalid.code).toBe(1)
  const view = await success<TaskView>(['task', 'get', task.ref, '--view', 'full'])
  expect(view.title).toBe('CLI task'); expect(view.revision).toBe(2); expect(view.notes).toHaveLength(1)
})

test('rejects file input, malformed JSON, mismatched revisions, and conflicting input modes', async () => {
  await success(['init']); const task = await create()
  for (const args of [
    ['task', 'update', task.ref, '--input', 'payload.json'],
    ['task', 'update', task.ref, '--json', '{broken'],
    ['task', 'update', task.ref, '--json', '{}', '--stdin'],
    ['task', 'update', task.ref, '--json', JSON.stringify({ expectedRevision: 1, operations: [{ type: 'stage.set', stage: 'reviewing' }] }), '--revision', '2'],
    ['todo', 'complete', task.ref, task.todos[0]!.ref],
  ]) {
    const result = await command(args)
    expect(result.code, result.stdout + result.stderr).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  }
  expect((await success<TaskView>(['task', 'get', task.ref])).revision).toBe(1)
})

test('explicit project and inherited worktree identity isolate versions; nested git root stops discovery', async () => {
  await success(['init']); const task = await create()
  const worktree = join(root, 'other'); await cp(project, worktree, { recursive: true })
  await success(['task', 'stage', task.ref, 'implementing', '--revision', '1', '--project', worktree])
  expect((await success<TaskView>(['task', 'get', task.ref])).stage).toBe('planning')
  const other = await success<TaskView>(['task', 'get', task.ref, '--project', worktree])
  expect(other.stage).toBe('implementing')
  const metadata = JSON.parse(await readFile(join(worktree, '.agent-work/project.json'), 'utf8'))
  expect(metadata).toEqual(JSON.parse(await readFile(join(project, '.agent-work/project.json'), 'utf8')))
  const nested = join(project, 'nested'); await mkdir(join(nested, '.git'), { recursive: true })
  const result = await command(['task', 'list'], { cwd: nested })
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'NOT_FOUND' } })
})

test('help and schemas are discoverable without initializing a project', async () => {
  const help = await command(['task', 'update', '--help'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('--stdin'); expect(help.stdout).not.toContain('--input')
  const schema = await success<{ properties: { operations: unknown }; required: string[] }>(['schema', 'update'])
  expect(schema.required).toContain('operations'); expect(schema.properties.operations).toBeDefined()
})


test('compact receipts omit echoed titles; verbose preserves descriptions', async () => {
  await success(['init']); const task = await create()
  const compact = await success<Record<string, unknown>>(['todo', 'complete', task.ref, ...task.todos.map(todo => todo.ref), '--revision', '1'])
  expect(compact).toMatchObject({ revision: 2, operationCount: 1, changeCount: 2, added: [] })
  expect(compact).not.toHaveProperty('changes')
  const verbose = await success<{ changes: string[] }>(['task', 'stage', task.ref, 'reviewing', '--revision', '2', '--verbose'])
  expect(verbose.changes).toEqual(['Stage: reviewing'])
})

test('batch reads and updates report ordered partial outcomes and preserve individual atomicity', async () => {
  await success(['init']); const first = await create(); const second = await create()
  const updates = [
    { taskId: first.ref, expectedRevision: 1, operations: [{ type: 'title.set', title: 'Updated' }] },
    { taskId: second.ref, expectedRevision: 1, operations: [{ type: 'title.set', title: 'Rolled back' }, { type: 'todo.complete', todoIds: ['missing'] }] },
    { taskId: first.ref, expectedRevision: 1, operations: [{ type: 'title.set', title: 'Stale' }] },
    { taskId: second.ref, expectedRevision: 1, operations: [{ type: 'stage.set', stage: 'reviewing' }] },
  ]
  const result = await command(['task', 'update-many', '--stdin'], { stdin: JSON.stringify({ updates }) })
  expect(result.code).toBe(1); expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toMatchObject({ succeeded: 2, failed: 2, items: [
    { taskId: first.ref, ok: true, data: { revision: 2 } },
    { taskId: second.ref, ok: false, error: { code: 'NOT_FOUND' } },
    { taskId: first.ref, ok: false, error: { code: 'CONFLICT' } },
    { taskId: second.ref, ok: true, data: { revision: 2 } },
  ] })
  const reads = await command(['task', 'get-many', second.ref, 'missing', first.ref])
  expect(reads.code).toBe(1)
  expect(JSON.parse(reads.stdout)).toMatchObject({ succeeded: 2, failed: 1, items: [
    { taskId: second.ref, ok: true, data: { title: 'CLI task', stage: 'reviewing', revision: 2 } },
    { taskId: 'missing', ok: false, error: { code: 'NOT_FOUND' } },
    { taskId: first.ref, ok: true, data: { title: 'Updated', revision: 2 } },
  ] })
  const malformed = await command(['task', 'update-many', '--json', JSON.stringify({ updates: [
    { taskId: first.ref, expectedRevision: 2, operations: [{ type: 'title.set', title: 'Must not write' }] },
    { taskId: second.ref, operations: [] },
  ] })])
  expect(malformed.code).toBe(2); expect(malformed.stdout).toBe('')
  expect((await success<TaskView>(['task', 'get', first.ref])).revision).toBe(2)
})

test('invalid state directory errors identify the path and configuration remedies', async () => {
  await writeFile(stateDir, 'not a directory')
  const result = await command(['init'])
  expect(result.code).toBe(1)
  const error = JSON.parse(result.stderr).error
  expect(error.code).toBe('STORAGE_ERROR')
  expect(error.message).toContain(stateDir)
  expect(error.message).toContain('--state-dir')
  expect(error.message).toContain('SDS_STATE_DIR')
})

// This scenario starts 15 CLI processes; allow for slower CI startup and filesystem I/O.
test('CLI creates nested tasks, lists descendants and moves branches with revision checks', async () => {
  await success(['init']); const rootTask = await create()
  const child = await success<Created>(['task', 'create', 'Child', '--parent', rootTask.ref])
  const grandchild = await success<Created>(['task', 'create', '--stdin'], { stdin: JSON.stringify({ title: 'Grandchild', parentId: child.ref }) })
  const view = await success<{ parentId: string; ancestors: { id: string }[] }>(['task', 'get', grandchild.ref])
  expect(view.parentId).toBe(child.id); expect(view.ancestors.map(task => task.id)).toEqual([rootTask.id, child.id])
  expect(await success(['task', 'list', '--parent', rootTask.ref, '--recursive'])).toMatchObject({ total: 2 })
  expect(await success(['task', 'list', '--roots'])).toMatchObject({ total: 1 })
  const invalid = await command(['task', 'move', rootTask.ref, '--parent', grandchild.ref, '--revision', '1'])
  expect(invalid.code).toBe(2)
  await success(['task', 'move', child.ref, '--root', '--revision', '1'])
  expect(await success(['task', 'list', '--roots'])).toMatchObject({ total: 2 })
  expect(await success(['task', 'get', grandchild.ref])).toMatchObject({ ancestors: [{ id: child.id }] })
  await success(['task', 'move', child.ref, '--parent', rootTask.ref, '--revision', '2'])
  for (const args of [['task', 'move', child.ref, '--revision', '3'], ['task', 'list', '--roots', '--parent', rootTask.ref], ['task', 'list', '--recursive']]) {
    const result = await command(args); expect(result.code).toBe(2); expect(result.stdout).toBe('')
  }
}, 30_000)
