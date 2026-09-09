import { Schema, type Effect } from 'effect'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { Tasks } from '../core/service'
import * as S from '../core/schema'
import { run, type Runtime } from './runtime'

const definitions = [
  { name: 'checkout_register', description: 'Register an absolute local checkout path, initializing .agent-work if needed. Returns checkoutId (id) and dashboard path. Register/commit project.json before branching so worktrees share project identity.', schema: S.RegisterInput, operation: 'register' },
  { name: 'checkout_list', description: 'List registered local checkouts. Each worktree has its own checkout ID; use it explicitly on task calls.', schema: Schema.Struct({}), operation: 'checkouts' },
  { name: 'task_create', description: 'Create a task with optional initial todos and parentId (a task ref in this checkout). Subtasks are full tasks and may themselves have children. Returns IDs, short refs and revision.', schema: S.CreateInput, operation: 'create' },
  { name: 'task_list', description: 'List compact task summaries in one checkout, with filters and offset pagination. parentId filters direct children; null selects roots; recursive=true includes all descendants of a parent.', schema: S.ListInput, operation: 'list' },
  { name: 'task_get', description: 'Read a task using a full ID or unambiguous prefix. Default working view includes pending todos, open findings and three latest notes. Includes parentId, ancestor summaries and direct subtaskCount. full includes all details; history is paginated, newest first.', schema: S.GetInput, operation: 'get' },
  { name: 'task_update', description: 'Apply semantic operations atomically to one task. parent.set moves a subtree; parentId:null detaches to top level. Cycles and cross-checkout parents are rejected. expectedRevision is required: read again after CONFLICT. Complete many todos with one todo.complete operation. Returns counts and newly added IDs; verbose includes change descriptions. IDs accept unambiguous prefixes of at least four characters.', schema: S.UpdateInput, operation: 'update' },
  { name: 'task_get_many', description: 'Read up to 100 task refs in input order. Returns per-task success or error outcomes.', schema: S.GetManyInput, operation: 'getMany' },
  { name: 'task_update_many', description: 'Validate batch shape first, then update tasks in order with per-item expectedRevision. Atomic per task, not across tasks. Returns every outcome; never automatically retry conflicts.', schema: S.UpdateManyInput, operation: 'updateMany' },
  { name: 'task_heartbeat', description: 'Report transient agent activity. While running, refresh every 30 seconds; expires after 60 seconds. Set running false on exit. Never writes task files.', schema: S.HeartbeatInput, operation: 'heartbeat' },
] as const

export function createMcpServer(runtime: Runtime) {
  const server = new Server({ name: 'sds', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(definition => ({
    name: definition.name,
    description: definition.description,
    inputSchema: { ...Schema.toJsonSchemaDocument(definition.schema).schema, type: 'object' } as Tool['inputSchema'],
    annotations: { readOnlyHint: ['checkouts', 'get', 'getMany', 'list'].includes(definition.operation), destructiveHint: false, openWorldHint: false },
  })) }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const definition = definitions.find(item => item.name === request.params.name)
    if (!definition) return { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] }
    const result = await run(runtime, Tasks.use((service): Effect.Effect<unknown, S.SdsError> => service[definition.operation](request.params.arguments ?? {})))
    const data = result.ok ? (Array.isArray(result.data) ? { items: result.data } : result.data as Record<string, unknown>) : { error: result.error }
    return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
  })
  return server
}

export async function handleMcp(runtime: Runtime, request: Request) {
  // A fresh stateless transport per request supports multiple independent harnesses.
  // JSON responses finish before cleanup; no session affinity or background SSE is required.
  const server = createMcpServer(runtime)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try { return await transport.handleRequest(request) } finally { await server.close() }
}
