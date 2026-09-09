import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createApp } from './app'
import { Tasks } from '../core/service'
import { run } from './runtime'

const port = Number(process.env.SDS_PORT ?? 4317)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SDS_PORT must be a valid port')
const stateDir = resolve(process.env.SDS_STATE_DIR ?? join(homedir(), '.local/state/sds'))
const service = createApp({ stateDir, port, distDir: process.env.SDS_DIST_DIR })
const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: service.app.fetch })
console.log(`SDS dashboard: http://127.0.0.1:${port}\nMCP endpoint:  http://127.0.0.1:${port}/mcp\nLocal state:   ${stateDir}`)
if (process.env.SDS_PROJECT) {
  const result = await run(service.runtime, Tasks.use(tasks => tasks.register({ path: resolve(process.env.SDS_PROJECT!) })))
  if (result.ok) console.log(`Checkout: http://127.0.0.1:${port}${result.data.url}`)
  else console.error(result.error)
}
let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  await server.stop(true)
  await service.close()
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
