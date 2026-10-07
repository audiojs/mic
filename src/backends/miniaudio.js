/**
 * Miniaudio backend — N-API addon wrapping miniaudio.h capture
 *
 * Read strategy:
 * - readAsync: blocks on worker thread until capture data available
 * - Callback fires with each captured chunk — true push from hardware
 *
 * Load order:
 * 1. build/Release/ or build/Debug/ (a local node-gyp build: a clone's own, newer than any prebuilt; never published)
 * 2. @audio/mic-{platform}-{arch} (platform package)
 * 3. packages/mic-{platform}-{arch}/
 * 4. prebuilds/{platform}-{arch}/
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch, platform } from 'node:os'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const plat = `${platform()}-${arch()}`

let addon
const loaders = [
  () => require(join(root, 'build', 'Release', 'mic.node')),
  () => require(join(root, 'build', 'Debug', 'mic.node')),
  () => require(`@audio/mic-${plat}`),
  () => require(join(root, 'packages', `mic-${plat}`, 'mic.node')),
  () => require(join(root, 'prebuilds', plat, 'audio-mic.node')),
  () => require(join(root, 'prebuilds', plat, 'mic.node')),
]
for (const load of loaders) {
  try { addon = load(); break } catch {}
}
if (!addon) throw new Error('miniaudio addon not found — install @audio/mic-' + plat + ' or run npm run build')

/** The inputs: [{ id, name, default }], ids the platform's own (CoreAudio's UID, WASAPI's endpoint id, ALSA's name) */
export const devices = () => addon.devices?.() ?? []

export function open({ sampleRate = 44100, channels = 1, bitDepth = 16, bufferSize = 50, device = '' } = {}) {
  // an addon from before devices could be chosen would open the default one: say so instead
  if (device && !addon.devices) throw Object.assign(new Error(`@audio/mic-${plat} predates choosing a device: update it`), { code: 'ENODEVICE' })
  const handle = addon.open(sampleRate, channels, bitDepth, bufferSize, device)
  const bpf = channels * (bitDepth / 8)

  return {
    read(cb) {
      const buf = Buffer.alloc(Math.round(sampleRate * bufferSize / 1000) * bpf)
      addon.readAsync(handle, buf, (err, frames) => {
        if (frames > 0) cb?.(err, buf.subarray(0, frames * bpf))
        else cb?.(err, null)
      })
    },

    close() {
      addon.close(handle)
    }
  }
}
