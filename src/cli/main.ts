#!/usr/bin/env bun
import { version } from '../../package.json'
import { BunServices } from '@effect/platform-bun'
import { Console, Effect, Option, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Tasks } from '../core/service'
import { createRuntime } from '../core/runtime'
import { decode, failure, io } from '../core/storage'
import * as S from '../core/schema'

const textFlag = (name: string) => Flag.string(name).pipe(Flag.optional)
const taskArg = Argument.string('task').pipe(Argument.withSchema(S.Ref))
const revisionFlag = Flag.integer('revision').pipe(Flag.withSchema(S.Revision))
const stdinFlag = Flag.boolean('stdin').pipe(Flag.withDescription('Read JSON from piped stdin'), Flag.withDefault(false))
const jsonFlag = Flag.string('json').pipe(Flag.withDescription('Inline JSON payload'), Flag.optional)
const root = Command.make('sds').pipe(
  Command.withDescription('Repository task management. JSON on stdout; errors on stderr. No server required.'),
  Command.withSharedFlags({ project: textFlag('project'), stateDir: textFlag('state-dir'), verbose: Flag.boolean('verbose').pipe(Flag.withDescription('Include mutation change descriptions'), Flag.withDefault(false)) }),
)

const withTasks = Effect.fn('cli.withTasks')(function* <A>(action: (tasks: Tasks['Service'], project: string) => Effect.Effect<A, S.SdsError>) {
  const options = yield* root
  const stateDir = resolve(Option.getOrUndefined(options.stateDir) ?? process.env.SDS_STATE_DIR ?? join(homedir(), '.local/state/sds'))
  const runtime = createRuntime(stateDir)
  return yield* Effect.acquireUseRelease(
    Effect.succeed(runtime),
    runtime => io('Run task operation', () => runtime.runPromise(Tasks.use(tasks => action(tasks, Option.getOrUndefined(options.project) ?? process.cwd())))),
    runtime => Effect.promise(() => runtime.dispose()),
  )
})
const print = (data: unknown) => Console.log(JSON.stringify(data))

const checkoutId = Effect.fn('cli.checkoutId')(function* (tasks: Tasks['Service'], start: string) {
  const path = yield* io('Find checkout', async () => {
    let path = await realpath(resolve(start))
    if (!(await lstat(path)).isDirectory()) throw failure('INVALID_INPUT', 'Project path must be a directory')
    while (true) {
      try { await lstat(join(path, '.agent-work/project.json')); return path } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      // Never escape a nested repository or worktree into its parent's project.
      try { await lstat(join(path, '.git')); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const parent = dirname(path)
      if (parent === path) break
      path = parent
    }
    throw failure('NOT_FOUND', 'No SDS project in this checkout. Run sds init at its root, or pass --project /path/to/checkout.')
  })
  const existing = (yield* tasks.checkouts()).find(entry => entry.path === path)
  if (existing) {
    if (!existing.available) return yield* failure('CONFLICT', existing.error ?? 'Checkout unavailable; register it again with sds init.')
    return existing.id
  }
  return (yield* tasks.register({ path })).id
})
const inputJson = Effect.fn('cli.inputJson')(function* (stdin: boolean, json: Option.Option<string>) {
  if (stdin && Option.isSome(json)) return yield* failure('INVALID_INPUT', 'Use --json or --stdin, not both')
  if (!stdin && Option.isNone(json)) return yield* failure('INVALID_INPUT', 'Supply --json or pipe JSON with --stdin')
  if (stdin && process.stdin.isTTY) return yield* failure('INVALID_INPUT', 'Pipe JSON into stdin when using --stdin')
  const text = Option.isSome(json) ? json.value : yield* io('Read stdin', () => Bun.stdin.text())
  return yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => failure('INVALID_INPUT', 'Input must be valid JSON') })
})
const CreateBody = Schema.Struct({ dependencyIds: S.CreateInput.fields.dependencyIds, parentId: S.CreateInput.fields.parentId, title: S.Title, description: Schema.optional(S.Text), todos: S.CreateInput.fields.todos })
const UpdateBody = Schema.Struct({ expectedRevision: Schema.optional(S.Revision), operations: S.UpdateInput.fields.operations })
const updateTask = Effect.fn('cli.updateTask')(function* (taskId: string, expectedRevision: number, operations: readonly (typeof S.Operation.Type)[]) {
  const { verbose } = yield* root
  const result = yield* withTasks((tasks, project) => Effect.gen(function* () {
    return yield* tasks.update({ checkoutId: yield* checkoutId(tasks, project), taskId, expectedRevision, operations, verbose })
  }))
  yield* print(result)
})

const init = Command.make('init', { path: Argument.string('path').pipe(Argument.optional), name: textFlag('name') }, Effect.fn('cli.init')(function* ({ path, name }) {
  const options = yield* root
  if (Option.isSome(path) && Option.isSome(options.project)) return yield* failure('INVALID_INPUT', 'Use either a path argument or --project, not both')
  const result = yield* withTasks(tasks => tasks.register({ path: resolve(Option.getOrUndefined(path) ?? Option.getOrUndefined(options.project) ?? process.cwd()), name: Option.getOrUndefined(name) }))
  yield* print(result)
})).pipe(Command.withDescription('Initialize/register this directory or an explicit path'))
const checkout = Command.make('checkout').pipe(Command.withSubcommands([
  Command.make('list', {}, Effect.fn('cli.checkouts')(function* () { yield* print({ items: yield* withTasks(tasks => tasks.checkouts()) }) })),
]))
const create = Command.make('create', { parent: textFlag('parent'), title: Argument.string('title').pipe(Argument.optional), description: textFlag('description'), stdin: stdinFlag, json: jsonFlag }, Effect.fn('cli.create')(function* ({ parent, title, description, stdin, json }) {
  if ((stdin || Option.isSome(json)) && (Option.isSome(title) || Option.isSome(description) || Option.isSome(parent))) return yield* failure('INVALID_INPUT', 'Use JSON input or title/description arguments, not both')
  const body = yield* decode(CreateBody, (stdin || Option.isSome(json)) ? yield* inputJson(stdin, json) : { parentId: Option.getOrUndefined(parent), title: Option.getOrUndefined(title), description: Option.getOrUndefined(description) })
  const { verbose } = yield* root
  yield* print(yield* withTasks((tasks, project) => Effect.gen(function* () { return yield* tasks.create({ ...body, verbose, checkoutId: yield* checkoutId(tasks, project) }) })))
})).pipe(Command.withDescription('Create a task; --json or --stdin can include initial todos'))
const list = Command.make('list', { parent: textFlag('parent'), roots: Flag.boolean('roots').pipe(Flag.withDefault(false)), recursive: Flag.boolean('recursive').pipe(Flag.withDefault(false)), status: textFlag('status'), stage: textFlag('stage'), query: textFlag('query'), offset: Flag.integer('offset').pipe(Flag.optional), limit: Flag.integer('limit').pipe(Flag.optional) }, Effect.fn('cli.list')(function* (options) {
  if (options.roots && Option.isSome(options.parent)) return yield* failure('INVALID_INPUT', 'Use --roots or --parent, not both')
  const { parent, roots, recursive, ...filters } = options
  const body = { parentId: roots ? null : Option.getOrUndefined(parent), recursive, ...Object.fromEntries(Object.entries(filters).flatMap(([key, value]) => Option.isSome<string | number>(value) ? [[key, value.value]] : [])) }
  yield* print(yield* withTasks((tasks, project) => Effect.gen(function* () { return yield* tasks.list({ ...body, checkoutId: yield* checkoutId(tasks, project) }) })))
}))
const get = Command.make('get', { task: taskArg, view: textFlag('view'), offset: Flag.integer('offset').pipe(Flag.optional), limit: Flag.integer('limit').pipe(Flag.optional) }, Effect.fn('cli.get')(function* (options) {
  yield* print(yield* withTasks((tasks, project) => Effect.gen(function* () { return yield* tasks.get({ checkoutId: yield* checkoutId(tasks, project), taskId: options.task, view: Option.getOrUndefined(options.view), offset: Option.getOrUndefined(options.offset), limit: Option.getOrUndefined(options.limit) }) })))
})).pipe(Command.withDescription('Read working view; --view full or history for more detail'))
const update = Command.make('update', { task: taskArg, stdin: stdinFlag, json: jsonFlag, revision: revisionFlag.pipe(Flag.optional) }, Effect.fn('cli.update')(function* (options) {
  const body = yield* decode(UpdateBody, yield* inputJson(options.stdin, options.json))
  const revision = Option.getOrUndefined(options.revision)
  if (revision !== undefined && body.expectedRevision !== undefined && revision !== body.expectedRevision) return yield* failure('INVALID_INPUT', '--revision disagrees with input expectedRevision')
  const expected = revision ?? body.expectedRevision
  if (expected === undefined) return yield* failure('INVALID_INPUT', 'Supply --revision or expectedRevision in the input')
  yield* updateTask(options.task, expected, body.operations)
})).pipe(Command.withDescription('Apply an atomic operation batch from JSON; use sds schema update for its shape'))
const printBatch = Effect.fn('cli.printBatch')(function* (result: { failed: number }) {
  yield* print(result)
  if (result.failed > 0) process.exitCode = 1
})
const getMany = Command.make('get-many', { tasks: Argument.string('tasks').pipe(Argument.withSchema(S.Ref), Argument.variadic({ min: 1, max: 100 })), view: textFlag('view'), offset: Flag.integer('offset').pipe(Flag.optional), limit: Flag.integer('limit').pipe(Flag.optional) }, Effect.fn('cli.getMany')(function* (options) {
  yield* printBatch(yield* withTasks((tasks, project) => Effect.gen(function* () { return yield* tasks.getMany({ checkoutId: yield* checkoutId(tasks, project), taskIds: options.tasks, view: Option.getOrUndefined(options.view), offset: Option.getOrUndefined(options.offset), limit: Option.getOrUndefined(options.limit) }) })))
})).pipe(Command.withDescription('Read up to 100 tasks in input order, with per-task outcomes'))
const updateMany = Command.make('update-many', { stdin: stdinFlag, json: jsonFlag }, Effect.fn('cli.updateMany')(function* (options) {
  const body = yield* decode(S.UpdateManyBody, yield* inputJson(options.stdin, options.json))
  const { verbose } = yield* root
  yield* printBatch(yield* withTasks((tasks, project) => Effect.gen(function* () { return yield* tasks.updateMany({ ...body, verbose: verbose || body.verbose, checkoutId: yield* checkoutId(tasks, project) }) })))
})).pipe(Command.withDescription('Update tasks sequentially, each with its own revision; partial failures exit 1 with all outcomes on stdout'))
const move = Command.make('move', { task: taskArg, parent: textFlag('parent'), root: Flag.boolean('root').pipe(Flag.withDefault(false)), revision: revisionFlag }, Effect.fn('cli.move')(function* (options) {
  if (options.root === Option.isSome(options.parent)) return yield* failure('INVALID_INPUT', 'Supply either --parent TASK or --root')
  yield* updateTask(options.task, options.revision, [{ type: 'parent.set', parentId: options.root ? null : Option.getOrThrow(options.parent) }])
})).pipe(Command.withDescription('Move a task and its descendants beneath a parent, or detach to top level'))
const stage = Command.make('stage', { task: taskArg, stage: Argument.withSchema(Argument.string('stage'), S.Stage), revision: revisionFlag }, Effect.fn('cli.stage')(function* (options) {
  yield* updateTask(options.task, options.revision, [{ type: 'stage.set', stage: options.stage }])
}))
const status = Command.make('status', { task: taskArg, status: Argument.withSchema(Argument.string('status'), S.Status), reason: textFlag('reason'), revision: revisionFlag }, Effect.fn('cli.status')(function* (options) {
  yield* updateTask(options.task, options.revision, [{ type: 'status.set', status: options.status, reason: Option.getOrUndefined(options.reason) }])
}))
const todo = Command.make('todo').pipe(Command.withSubcommands([
  Command.make('complete', { task: taskArg, todos: Argument.string('todos').pipe(Argument.withSchema(S.Ref), Argument.variadic({ min: 1, max: 200 })), revision: revisionFlag }, Effect.fn('cli.complete')(function* (options) {
    yield* updateTask(options.task, options.revision, [{ type: 'todo.complete', todoIds: options.todos }])
  })),
  Command.make('add', { task: taskArg, titles: Argument.string('titles').pipe(Argument.withSchema(S.Title), Argument.variadic({ min: 1, max: 200 })), revision: revisionFlag }, Effect.fn('cli.addTodos')(function* (options) {
    yield* updateTask(options.task, options.revision, options.titles.map(title => ({ type: 'todo.add', title })))
  })),
]))
const note = Command.make('note').pipe(Command.withSubcommands([
  Command.make('add', { task: taskArg, text: Argument.string('text'), revision: revisionFlag }, Effect.fn('cli.note')(function* (options) {
    yield* updateTask(options.task, options.revision, [{ type: 'note.add', text: options.text }])
  })),
]))
const schemas = { create: CreateBody, update: UpdateBody, operation: S.Operation, 'update-many': S.UpdateManyBody } as const
const schema = Command.make('schema', { name: Argument.withSchema(Argument.string('name'), Schema.Literals(['create', 'update', 'operation', 'update-many'])) }, Effect.fn('cli.schema')(function* ({ name }) {
  const document = Schema.toJsonSchemaDocument(schemas[name])
  yield* print({ ...document.schema, $defs: document.definitions })
})).pipe(Command.withDescription('Print a JSON input schema without loading every operation into context'))
const cli = root.pipe(Command.withSubcommands([init, checkout, Command.make('task').pipe(Command.withSubcommands([create, list, get, getMany, update, updateMany, move, stage, status])), todo, note, schema]))

// Buffer parser help so failed commands leave stdout empty for agent callers.
const output: string[] = []
const cliConsole: Console.Console = { ...console, log: (...args: unknown[]) => { output.push(args.map(String).join(' ')) } }
await Effect.runPromise(Command.runWith(cli, { version, renderErrors: false })(process.argv.slice(2)).pipe(
  Effect.provide(BunServices.layer),
  Effect.provideService(Console.Console, cliConsole),
  Effect.match({
    onSuccess: () => { for (const line of output) console.log(line) },
    onFailure: error => {
      if (error._tag === 'ShowHelp' && error.errors.length === 0) { for (const line of output) console.log(line); return }
      const code = error instanceof S.SdsError ? error.code : 'INVALID_INPUT'
      const message = error._tag === 'ShowHelp' ? error.errors.map(error => error.message).join('; ') : error.message
      console.error(JSON.stringify({ error: { code, message } }))
      process.exitCode = code === 'INVALID_INPUT' ? 2 : 1
    },
  }),
)).catch(error => { console.error(JSON.stringify({ error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } })); process.exitCode = 1 })
