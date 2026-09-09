import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
// Installed launchers are symlinks; resolve the executable to locate its assets.
process.env.SDS_DIST_DIR ??= join(dirname(realpathSync(process.execPath)), 'dist')
await import('../src/server/main')
