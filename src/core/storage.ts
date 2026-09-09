import { Context, Effect, Layer, Schema } from 'effect'
import { mkdir, readFile, readdir, realpath, lstat, open, rename, rm } from 'node:fs/promises'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { nanoid } from 'nanoid'
import { SdsError, type ErrorCode } from './schema'

export const failure = (code: ErrorCode, message: string) => new SdsError({ code, message })
export const io = <A>(label: string, action: () => Promise<A>) => Effect.tryPromise({
  try: () => action(),
  catch: (error) => error instanceof SdsError ? error : failure('STORAGE_ERROR', `${label}: ${error instanceof Error ? error.message : String(error)}`),
})
export const decode = <S extends Schema.Constraint & { DecodingServices: never }>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: 'error' }).pipe(Effect.mapError(error => failure('INVALID_INPUT', error.message)))

export const resolveRef = Effect.fn('resolveRef')(function* <T extends { readonly id: string }>(items: readonly T[], ref: string) {
  const exact = items.find(item => item.id === ref)
  if (exact) return exact
  const matches = items.filter(item => item.id.startsWith(ref))
  if (matches.length === 0) return yield* failure('NOT_FOUND', `No match for ${ref}`)
  if (matches.length !== 1) return yield* failure('AMBIGUOUS_REF', `Ambiguous reference ${ref}; use one of: ${matches.map(item => item.id).join(', ')}`)
  return matches[0]!
})
export function shortRef(id: string, siblings: readonly { readonly id: string }[]) {
  let size = 6
  while (size < id.length && siblings.some(other => other.id !== id && other.id.startsWith(id.slice(0, size)))) size++
  return id.slice(0, size)
}

export class Storage extends Context.Service<Storage, {
  stateDir: string
  canonical(path: string): Effect.Effect<string, SdsError>
  ensureRepo(path: string): Effect.Effect<string, SdsError>
  read(path: string): Effect.Effect<unknown | undefined, SdsError>
  write(path: string, data: unknown): Effect.Effect<void, SdsError>
  taskFiles(path: string): Effect.Effect<string[], SdsError>
  lock<A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SdsError, R>
}>()('sds/Storage') {
  static live(stateDir: string) {
    const storageIo = <A>(label: string, path: string, action: () => Promise<A>) => io(label, async () => {
      try { return await action() } catch (error) {
        const errno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literals(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR']) }))(error)
        if (errno._tag === 'Some') {
          const state = resolve(stateDir)
          const isState = resolve(path) === state || resolve(path).startsWith(`${state}${sep}`)
          const remedy = isState
            ? `SDS state directory: ${state}. Grant access to this directory or select a writable directory with --state-dir or SDS_STATE_DIR. All clients must use the same state directory to share locks and checkout registrations.`
            : 'Check that this checkout path is a directory and is writable by the current process.'
          throw failure('STORAGE_ERROR', `${label}: ${errno.value.code} at ${path}. ${remedy}`)
        }
        throw error
      }
    })
    return Layer.succeed(Storage, Storage.of({
      stateDir,
      canonical: path => storageIo('Resolve checkout', path, async () => {
        const result = await realpath(path)
        if (!(await lstat(result)).isDirectory()) throw failure('INVALID_INPUT', 'Checkout path must be a directory')
        return result
      }),
      ensureRepo: path => storageIo('Prepare task directory', path, async () => {
        const root = join(path, '.agent-work')
        // Do not follow repository-controlled directory symlinks outside the checkout.
        for (const dir of [root, join(root, 'tasks')]) {
          await mkdir(dir, { recursive: true })
          const stat = await lstat(dir)
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('STORAGE_ERROR', `${dir} must be a real directory`)
        }
        return root
      }),
      read: path => storageIo('Read JSON', path, async () => {
        try {
          if ((await lstat(path)).isSymbolicLink()) throw failure('STORAGE_ERROR', `Refusing symlink: ${path}`)
          return JSON.parse(await readFile(path, 'utf8')) as unknown
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      }),
      write: (path, data) => storageIo('Write JSON', path, async () => {
        await mkdir(dirname(path), { recursive: true })
        const temp = join(dirname(path), `.${basename(path)}.${nanoid()}.tmp`)
        try {
          const handle = await open(temp, 'wx', 0o600)
          try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
          await rename(temp, path)
        } finally { await rm(temp, { force: true }) }
      }),
      taskFiles: path => storageIo('List tasks', path, async () => {
        const files = await readdir(join(path, '.agent-work', 'tasks'))
        return files.filter(file => /^[A-Za-z0-9_-]{21}\.json$/.test(file)).sort()
      }),
      lock: (key, effect) => Effect.scoped(Effect.gen(function* () {
        const lockPath = join(stateDir, 'locks', createHash('sha256').update(key).digest('hex'))
        const release = yield* Effect.acquireRelease(storageIo('Acquire lock', lockPath, async () => {
          await mkdir(dirname(lockPath), { recursive: true })
          try {
            return await lockfile.lock(lockPath, { realpath: false, stale: 30_000, retries: { retries: 30, minTimeout: 25, maxTimeout: 100 } })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw failure('BUSY', 'Another writer holds this task. Retry shortly.')
            throw error
          }
        }), release => storageIo('Release lock', lockPath, release).pipe(Effect.orDie))
        void release
        return yield* effect
      })),
    }))
  }
}
