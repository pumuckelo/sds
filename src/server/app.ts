import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { watch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, sep } from 'node:path'
import { Tasks } from '../core/service'
import type { SdsError } from '../core/schema'
import type { Effect } from 'effect'
import { createRuntime, run } from './runtime'
import { handleMcp } from './mcp'

const git = promisify(execFile)
export function createApp(options: { stateDir: string; port?: number; distDir?: string }) {
  const runtime = createRuntime(options.stateDir)
  const app = new Hono()
  const listeners = new Set<() => void>()
  const watchers = new Map<string, FSWatcher>()
  const notify = () => listeners.forEach(listener => listener())
  let closing = false
  let watcherRefresh: Promise<void> | undefined
  const doRefreshWatchers = async () => {
    if (closing) return
    const result = await run(runtime, Tasks.use(service => service.checkouts()))
    if (!result.ok || closing) return
    for (const entry of result.data) {
      if (!entry.available || watchers.has(entry.id)) continue
      try {
        const watcher = watch(join(entry.path, '.agent-work'), { recursive: true }, notify)
        watcher.on('error', () => { watcher.close(); watchers.delete(entry.id); notify() })
        watchers.set(entry.id, watcher)
      } catch { /* Unavailable checkouts remain visible and can be registered again. */ }
    }
  }
  const refreshWatchers = () => {
    if (closing) return Promise.resolve()
    return watcherRefresh ??= doRefreshWatchers().catch(error => { if (!closing) console.error('Watch refresh failed', error) }).finally(() => { watcherRefresh = undefined })
  }
  const timer = setInterval(() => { void refreshWatchers(); notify() }, 10_000)
  timer.unref()
  void refreshWatchers()

  app.use('*', async (c, next) => {
    const url = new URL(c.req.url)
    const port = options.port ?? 4317
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
    if (!hosts.has(url.host) || (c.req.header('host') && !hosts.has(c.req.header('host')!))) return c.json({ error: { code: 'FORBIDDEN', message: 'Localhost only' } }, 403)
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173'])
    const origin = c.req.header('origin')
    if (origin && !origins.has(origin)) return c.json({ error: { code: 'FORBIDDEN', message: 'Origin not allowed' } }, 403)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    await next()
  })
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: c => c.json({ error: { code: 'INVALID_INPUT', message: 'Request exceeds 2 MB' } }, 413) }))
  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_INPUT', message: 'Malformed JSON' } }, 400)
    console.error(error)
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error; see server logs' } }, 500)
  })
  const execute = async <A>(effect: Effect.Effect<A, SdsError, Tasks>) => {
    const result = await run(runtime, effect)
    if (result.ok) return Response.json(result.data)
    const status = { INVALID_INPUT: 400, NOT_FOUND: 404, AMBIGUOUS_REF: 409, CONFLICT: 409, BUSY: 423, STORAGE_ERROR: 500 }[result.error.code]
    return Response.json({ error: result.error }, { status })
  }
  app.get('/api/health', c => c.json({ name: 'sds', version: '0.1.0' }))
  app.get('/api/checkouts', async () => {
    const result = await run(runtime, Tasks.use(service => service.checkouts()))
    if (!result.ok) return Response.json({ error: result.error }, { status: 500 })
    const entries = await Promise.all(result.data.map(async entry => {
      let branch: string | null = null
      if (entry.available) {
        try { branch = (await git('git', ['-C', entry.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1500 })).stdout.trim() } catch { /* Plain folders are valid projects. */ }
      }
      return { ...entry, branch }
    }))
    return Response.json(entries)
  })
  app.post('/api/checkouts', async c => {
    const body = await c.req.json()
    const result = await execute(Tasks.use(service => service.register(body)))
    await refreshWatchers(); notify()
    return result
  })
  app.post('/api/tasks/create', async c => { const body = await c.req.json(); const response = await execute(Tasks.use(service => service.create(body))); notify(); return response })
  app.post('/api/tasks/list', async c => { const body = await c.req.json(); return execute(Tasks.use(service => service.list(body))) })
  app.post('/api/tasks/get', async c => { const body = await c.req.json(); return execute(Tasks.use(service => service.get(body))) })
  app.post('/api/tasks/update', async c => { const body = await c.req.json(); const response = await execute(Tasks.use(service => service.update(body))); notify(); return response })
  app.post('/api/tasks/get-many', async c => { const body = await c.req.json(); return execute(Tasks.use(service => service.getMany(body))) })
  app.post('/api/tasks/update-many', async c => { const body = await c.req.json(); const response = await execute(Tasks.use(service => service.updateMany(body))); notify(); return response })
  app.all('/mcp', async c => { const response = await handleMcp(runtime, c.req.raw); void refreshWatchers(); notify(); return response })
  app.get('/events', c => streamSSE(c, async stream => {
    let wake = () => {}
    let pending = true
    let aborted = false
    const listener = () => { pending = true; wake() }
    listeners.add(listener)
    stream.onAbort(() => { aborted = true; listeners.delete(listener); wake() })
    try {
      while (!aborted) {
        if (!pending) await new Promise<void>(resolve => { wake = resolve; if (pending || aborted) resolve() })
        if (aborted) break
        pending = false
        await stream.writeSSE({ event: 'change', data: '{}' })
      }
    } finally { listeners.delete(listener) }
  }))
  app.get('*', async c => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }, 404)
    const dist = resolve(options.distDir ?? join(import.meta.dir, '../../dist'))
    const target = resolve(dist, `.${decodeURIComponent(c.req.path)}`)
    if (target !== dist && !target.startsWith(`${dist}${sep}`)) return c.notFound()
    const asset = Bun.file(target)
    if (target !== dist && await asset.exists()) return new Response(asset)
    if (c.req.path.startsWith('/assets/')) return c.notFound()
    const index = Bun.file(join(dist, 'index.html'))
    return await index.exists() ? new Response(index) : c.text('SDS server is running. Run bun run build for the dashboard, or bun run dev for Vite.')
  })
  return { app, runtime, close: async () => { closing = true; clearInterval(timer); await watcherRefresh; for (const watcher of watchers.values()) watcher.close(); watchers.clear(); await runtime.dispose() } }
}
