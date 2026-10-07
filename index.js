/**
 * @module audio-mic
 *
 * Capture audio data from microphone.
 * let read = mic({ sampleRate: 44100 })
 * read((err, chunk) => {})
 * read(null) // stop
 */
import { open, devices as list } from './src/backend.js'

const defaults = {
  sampleRate: 44100,
  channels: 1,
  bitDepth: 16,
  bufferSize: 50
}

/** The inputs: [{ id, name, default }] */
export async function devices(opts = {}) { return list(opts.backend) }

/** A device by its id or name, else the one whose name holds it (any case), when only one does */
export function pick(all, device) {
  if (device == null || device === '') return
  let d = String(device), lower = d.toLowerCase()
  let hit = all.find(x => x.id === d || x.name === d), some = hit ? [] : all.filter(x => x.name.toLowerCase().includes(lower))
  return (hit ?? (some.length === 1 ? some[0] : null))?.id ?? d
}

export default function mic(opts) {
  const config = { ...defaults, ...opts }
  if (config.device != null) config.device = pick(list(config.backend), config.device)
  const { name, device } = open(config, config.backend)

  read.close = () => { device.close() }
  read.end = () => { device.close() }
  read.backend = name
  read[Symbol.asyncIterator] = () => ({
    next: () => new Promise((resolve, reject) => {
      device.read((err, chunk) => {
        if (err) return reject(err)
        if (!chunk) return resolve({ done: true, value: undefined })
        resolve({ done: false, value: chunk })
      })
    })
  })

  return read

  function read(cb) {
    if (cb == null) {
      device.close()
      return
    }
    device.read(cb)
  }
}
