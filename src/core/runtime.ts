import { Effect, Layer, ManagedRuntime } from 'effect'
import { Storage } from './storage'
import { Tasks } from './service'
import type { SdsError } from './schema'

export function createRuntime(stateDir: string) {
  return ManagedRuntime.make(Tasks.layer.pipe(Layer.provide(Storage.live(stateDir))))
}
export type Runtime = ReturnType<typeof createRuntime>
export function run<A>(runtime: Runtime, effect: Effect.Effect<A, SdsError, Tasks>) {
  return runtime.runPromise(effect.pipe(Effect.match({
    onFailure: error => ({ ok: false as const, error: { code: error.code, message: error.message } }),
    onSuccess: data => ({ ok: true as const, data }),
  })))
}
