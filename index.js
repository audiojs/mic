/**
 * @module audio-mic
 *
 * Capture audio data from microphone.
 * let read = mic({ sampleRate: 44100 })
 * read((err, chunk) => {})
 * read(null) // stop
 */
import { open, devices as list } from './src/backend.js'
import queue, { iterator, overflow } from './src/queue.js'

const defaults = {
  sampleRate: 44100,
  channels: 1,
  bitDepth: 16,
  bufferSize: 50,
  backlog: 10000
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
  const { sampleRate, channels, bitDepth, backlog } = config

  // what is captured waits here until read; the device is read all the time, so a slow reader loses none
  const q = queue(backlog * sampleRate * channels * bitDepth / 8000, Buffer.concat)
  let closed = false
  pump()

  read.close = () => stop()
  read.end = () => stop()
  read.backend = name
  read[Symbol.asyncIterator] = iterator(read)

  return read

  function read(cb) {
    if (cb == null) return stop()
    q.read(cb)
  }

  // the device's next block into the queue, then the one after, while capture lasts
  function pump() {
    device.read((err, chunk) => {
      if (closed) return
      if (err || !chunk) return stop(err)
      if (!q.push(chunk)) return stop(overflow(backlog))
      if (!closed) pump()
    })
  }

  // capture stops; what was captured still reads, then err if any, then the end
  function stop(err) {
    if (closed) return
    closed = true
    device.close()
    q.end(err)
  }
}
