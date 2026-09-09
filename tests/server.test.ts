import { beforeEach, afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../src/server/app'
let root: string, service: ReturnType<typeof createApp>
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sds-http-')); await mkdir(join(root, 'repo')); service = createApp({ stateDir: join(root, 'state') }) })
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
const request = (path: string, data?: unknown, headers?: Record<string, string>) => service.app.request(`http://127.0.0.1:4317${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) })

test('HTTP contract: register, create, update, list and conflicts', async () => {
  const checkout = await (await request('/api/checkouts', { path: join(root, 'repo') })).json()
  const created = await (await request('/api/tasks/create', { checkoutId: checkout.id, title: 'HTTP task' })).json()
  const input = { checkoutId: checkout.id, taskId: created.id, expectedRevision: 1, operations: [{ type: 'status.set', status: 'active' }] }
  expect((await request('/api/tasks/update', input)).status).toBe(200)
  expect((await request('/api/tasks/update', input)).status).toBe(409)
  const listed = await (await request('/api/tasks/list', { checkoutId: checkout.id })).json()
  expect(listed.items[0].status).toBe('active')
  expect((await request('/api/tasks/get', { checkoutId: checkout.id, taskId: 'nonexistent' })).status).toBe(404)
})

test('local transport rejects foreign origins and hosts; malformed JSON is actionable', async () => {
  expect((await request('/api/checkouts', { path: join(root, 'repo') }, { Origin: 'https://evil.example' })).status).toBe(403)
  expect((await service.app.request('http://evil.example:4317/api/checkouts')).status).toBe(403)
  const bad = await service.app.request('http://127.0.0.1:4317/api/tasks/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })
  expect(bad.status).toBe(400)
  expect((await bad.json()).error.code).toBe('INVALID_INPUT')
})

test('real MCP client initializes, discovers schemas, batches updates, and reads HTTP-visible changes', async () => {
  const client = new Client({ name: 'sds-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4317/mcp'), {
    fetch: async (input, init) => service.app.fetch(new Request(input, init)),
  })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name)).toContain('task_update')
    expect(tools.tools.find(tool => tool.name === 'task_update')!.inputSchema.required).toContain('expectedRevision')
    const register = await client.callTool({ name: 'checkout_register', arguments: { path: join(root, 'repo') } })
    expect(register.isError).toBe(false)
    const checkoutId = (register.structuredContent as { id: string }).id
    const list = await client.callTool({ name: 'checkout_list', arguments: {} })
    expect(list.isError).toBe(false)
    const created = await client.callTool({ name: 'task_create', arguments: { checkoutId, title: 'MCP task', todos: [{ title: 'One' }, { title: 'Two' }] } })
    expect(created.isError).toBe(false)
    const data = created.structuredContent as { id: string; todos: { ref: string }[] }
    const update = await client.callTool({ name: 'task_update', arguments: { checkoutId, taskId: data.id, expectedRevision: 1, operations: [{ type: 'todo.complete', todoIds: data.todos.map(todo => todo.ref) }, { type: 'stage.set', stage: 'reviewing' }] } })
    expect(update.isError).toBe(false)
    const task = await (await request('/api/tasks/get', { checkoutId, taskId: data.id, view: 'full' })).json()
    expect(task.stage).toBe('reviewing'); expect(task.todos.every((todo: { status: string }) => todo.status === 'done')).toBe(true)
    const batch = await client.callTool({ name: 'task_update_many', arguments: { checkoutId, updates: [
      { taskId: data.id, expectedRevision: 2, operations: [{ type: 'status.set', status: 'active' }] },
      { taskId: data.id, expectedRevision: 2, operations: [{ type: 'status.set', status: 'done' }] },
    ] } })
    expect(batch.structuredContent).toMatchObject({ succeeded: 1, failed: 1 })
    const reads = await (await request('/api/tasks/get-many', { checkoutId, taskIds: [data.id, 'missing'] })).json()
    expect(reads).toMatchObject({ succeeded: 1, failed: 1, items: [{ ok: true, data: { revision: 3 } }, { ok: false }] })
    const httpBatch = await (await request('/api/tasks/update-many', { checkoutId, updates: [{ taskId: data.id, expectedRevision: 3, operations: [{ type: 'note.add', text: 'HTTP batch' }] }] })).json()
    expect(httpBatch).toMatchObject({ succeeded: 1, failed: 0 })
    const mcpReads = await client.callTool({ name: 'task_get_many', arguments: { checkoutId, taskIds: [data.id] } })
    expect(mcpReads.structuredContent).toMatchObject({ succeeded: 1, items: [{ data: { revision: 4 } }] })
    const stale = await client.callTool({ name: 'task_update', arguments: { checkoutId, taskId: data.id, expectedRevision: 1, operations: [{ type: 'stage.set', stage: 'planning' }] } })
    expect(stale.isError).toBe(true)
    expect(stale.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } })
  } finally { await client.close() }
})

test('two agents hand off planning, blocked implementation, review findings, and completion', async () => {
  const clients = [new Client({ name: 'implementer', version: '1' }), new Client({ name: 'reviewer', version: '1' })]
  for (const client of clients) await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4317/mcp'), {
    fetch: async (input, init) => service.app.fetch(new Request(input, init)),
  }))
  const implementer = clients[0]!, reviewer = clients[1]!
  const call = async (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  try {
    const registration = await call(implementer, 'checkout_register', { path: join(root, 'repo') })
    const checkoutId = (registration.structuredContent as { id: string }).id
    const created = await call(implementer, 'task_create', { checkoutId, title: 'Implement password reset', description: 'Single-use tokens with expiration.', todos: [{ title: 'Implement endpoint', stage: 'implementing' }, { title: 'Verify token reuse is rejected', stage: 'reviewing' }] })
    const initial = created.structuredContent as { id: string; todos: { ref: string }[] }
    const taskId = initial.id
    const update = (client: Client, expectedRevision: number, operations: unknown[]) => call(client, 'task_update', { checkoutId, taskId, expectedRevision, operations })
    expect((await update(implementer, 1, [{ type: 'stage.set', stage: 'implementing' }, { type: 'status.set', status: 'active' }])).isError).toBe(false)
    expect((await update(implementer, 2, [{ type: 'status.set', status: 'blocked', reason: 'Waiting for mail configuration' }, { type: 'note.add', text: 'Endpoint contract agreed; mail configuration is required to proceed.' }])).isError).toBe(false)
    const blocked = await call(reviewer, 'task_get', { checkoutId, taskId })
    expect(blocked.structuredContent).toMatchObject({ status: 'blocked', blocker: 'Waiting for mail configuration', revision: 3 })
    expect((await update(implementer, 3, [{ type: 'status.set', status: 'active' }, { type: 'todo.complete', todoIds: [initial.todos[0]!.ref] }, { type: 'stage.set', stage: 'reviewing' }])).isError).toBe(false)
    const review = await call(reviewer, 'task_get', { checkoutId, taskId })
    expect((review.structuredContent as { todos: unknown[] }).todos).toHaveLength(1)
    const finding = await update(reviewer, 4, [{ type: 'finding.add', description: 'Reset token remains usable after successful reset.', severity: 'high', file: 'src/reset.ts', line: 12 }, { type: 'stage.set', stage: 'implementing' }])
    const findingRef = (finding.structuredContent as { added: { ref: string }[] }).added[0]!.ref
    const stale = await update(implementer, 4, [{ type: 'status.set', status: 'done' }])
    expect(stale.isError).toBe(true)
    expect(stale.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } })
    const fresh = await call(implementer, 'task_get', { checkoutId, taskId })
    expect(fresh.structuredContent).toMatchObject({ revision: 5, stage: 'implementing' })
    expect((await update(implementer, 5, [{ type: 'note.add', text: 'Invalidate the token in the same transaction as the reset.' }, { type: 'stage.set', stage: 'reviewing' }])).isError).toBe(false)
    expect((await update(reviewer, 6, [{ type: 'finding.resolve', findingId: findingRef, status: 'resolved', resolution: 'Token reuse now returns an error; integration test passes.' }, { type: 'todo.complete', todoIds: [initial.todos[1]!.ref] }, { type: 'status.set', status: 'done' }])).isError).toBe(false)
    const final = await call(implementer, 'task_get', { checkoutId, taskId })
    expect(final.structuredContent).toMatchObject({ revision: 7, status: 'done', stage: 'reviewing', todos: [], findings: [] })
    const invalid = await call(implementer, 'task_update', { checkoutId, taskId, expectedRevision: 7, operations: [{ type: 'invented.operation' }] })
    expect(invalid.isError).toBe(true)
    const history = await call(reviewer, 'task_get', { checkoutId, taskId, view: 'history', limit: 2 })
    expect(history.structuredContent).toMatchObject({ total: 7, nextOffset: 2 })
    const page = await call(reviewer, 'task_list', { checkoutId, status: 'done', limit: 1 })
    expect(page.structuredContent).toMatchObject({ total: 1, nextOffset: null })
  } finally { await Promise.all(clients.map(client => client.close())) }
})

test('MCP and HTTP share recursive parent creation, ancestry and reparenting', async () => {
  const client = new Client({ name: 'hierarchy', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4317/mcp'), { fetch: async (input, init) => service.app.fetch(new Request(input, init)) }))
  try {
    const checkout = await (await request('/api/checkouts', { path: join(root, 'repo') })).json()
    const checkoutId = checkout.id
    const parent = await (await request('/api/tasks/create', { checkoutId, title: 'Parent' })).json()
    const childResult = await client.callTool({ name: 'task_create', arguments: { checkoutId, title: 'Child', parentId: parent.ref } })
    expect(childResult.isError).toBe(false)
    const child = childResult.structuredContent as { id: string }
    const nested = await (await request('/api/tasks/create', { checkoutId, title: 'Nested', parentId: child.id })).json()
    const listed = await client.callTool({ name: 'task_list', arguments: { checkoutId, parentId: parent.id, recursive: true } })
    expect(listed.structuredContent).toMatchObject({ total: 2 })
    const cycle = await request('/api/tasks/update', { checkoutId, taskId: parent.id, expectedRevision: 1, operations: [{ type: 'parent.set', parentId: nested.id }] })
    expect(cycle.status).toBe(400)
    const moved = await client.callTool({ name: 'task_update', arguments: { checkoutId, taskId: child.id, expectedRevision: 1, operations: [{ type: 'parent.set', parentId: null }] } })
    expect(moved.isError).toBe(false)
    expect(await (await request('/api/tasks/get', { checkoutId, taskId: nested.id })).json()).toMatchObject({ ancestors: [{ id: child.id }] })
    const schema = await client.listTools()
    expect(schema.tools.find(tool => tool.name === 'task_create')!.inputSchema.properties).toHaveProperty('parentId')
  } finally { await client.close() }
})
