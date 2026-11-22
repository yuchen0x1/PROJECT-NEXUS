import { electronAdapter } from './electron.mjs'
import { tauriAdapter } from './tauri.mjs'
import { pythonAdapter } from './python.mjs'
import { dotnetAdapter } from './dotnet.mjs'
import { webPwaAdapter } from './web-pwa.mjs'

export const adapters = [electronAdapter, tauriAdapter, pythonAdapter, dotnetAdapter, webPwaAdapter]

export function inspectComponents(files) {
  return adapters.filter((adapter) => adapter.detect(files)).map((adapter) => ({
    adapter: adapter.id,
    name: adapter.name,
    ...adapter.inspect(files)
  }))
}
