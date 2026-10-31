/**
 * Recording to disk, in the addon: the device at its own rate, float, into WAV files a thread of the addon writes as
 * the audio comes, so a held event loop, a crash or a kill costs the take nothing (see native/record.h).
 *
 * let take = record('take.wav', { device: 'Scarlett', channels: [1, 2], bitDepth: 24 })
 * take.status()      // { seconds, frames, peaks, clips, silenced, stalled, rerouted, done, error }
 * await take.stop()  // the same, once the files are closed
 *
 * Inputs count from 1, as an interface labels them. Several files at once, each its own inputs, one clock:
 * record({ 'voice.wav': [1], 'guitar.wav': [2] }) — tracks of one take, sample for sample together.
 * No files, record({}): the device's levels alone, every input, to set them before recording.
 */
import { resolve } from 'node:path'
import { openSync, readSync, writeSync, fstatSync, closeSync } from 'node:fs'

export function record(addon, to, { channels, sampleRate = 0, bitDepth = 24, ring = 20, overwrite = false, device = '', rf64At = 0 } = {}) {
  if (!addon?.record) throw new Error('record: this @audio/mic addon predates recording to disk: update @audio/mic-' + process.platform + '-' + process.arch)
  const files = (typeof to === 'string' ? [[to, channels]] : Object.entries(to)).map(([path, ch]) => ({
    path: resolve(path),
    channels: ch == null ? null : [].concat(ch).map(c => {
      if (!Number.isInteger(c) || c < 1) throw Object.assign(new RangeError(`record: input ${c}: inputs count from 1`), { code: 'ECHANNEL' })
      return c - 1
    })
  }))
  const handle = addon.record(files, device ?? '', sampleRate, bitDepth, ring, overwrite, rf64At)
  const info = addon.recordInfo(handle)
  const seconds = s => (s.seconds = s.frames / info.sampleRate, s)
  let stopped
  return {
    ...info,
    bitDepth,
    files: files.map(f => ({ path: f.path, channels: (f.channels ?? [0, 1].slice(0, Math.min(2, info.channels))).map(c => c + 1) })),
    status: () => seconds(addon.recordStatus(handle)),
    // the audio written since the last read, interleaved: the first file's channels, or every channel with no file
    read: () => addon.recordRead ? addon.recordRead(handle) : new Float32Array(0),
    stop: () => stopped ??= addon.recordStop(handle).then(seconds)
  }
}

/**
 * A WAV whose writer never finished (killed, power cut): its header to the audio the file holds, whole frames.
 * → { frames, before }: the frames it holds now, and those its header told before.
 */
export function recover(path) {
  const fd = openSync(path, 'r+')
  try {
    const size = fstatSync(fd).size, head = Buffer.alloc(Math.min(size, 1 << 16))
    readSync(fd, head, 0, head.length, 0)
    const id = head.toString('latin1', 0, 4)
    if ((id !== 'RIFF' && id !== 'RF64') || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`recover: not a WAV file: ${path}`)
    let at = 12, block = 0, fact = -1, ds64 = -1, junk = -1, data = -1
    while (at + 8 <= head.length) {
      const name = head.toString('latin1', at, at + 4), len = head.readUInt32LE(at + 4)
      if (name === 'fmt ') block = head.readUInt16LE(at + 8 + 12)
      else if (name === 'fact') fact = at + 8
      else if (name === 'ds64') ds64 = at + 8
      else if (name === 'JUNK' && len >= 28) junk = at
      else if (name === 'data') { data = at; break }
      at += 8 + len + (len & 1)
    }
    if (data < 0 || !block) throw new Error(`recover: no fmt or data chunk: ${path}`)
    const bytes = Math.floor((size - data - 8) / block) * block, frames = bytes / block
    const told = ds64 >= 0 ? Number(head.readBigUInt64LE(ds64 + 8)) : head.readUInt32LE(data + 4)
    const riff = data + 8 + bytes - 8, put = (buf, at) => writeSync(fd, buf, 0, buf.length, at)
    const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }, u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
    if (riff > 0xFFFFFFFF) {
      // past RIFF's 4 GB: RF64, ds64 in the JUNK kept for it (EBU Tech 3306)
      if (ds64 < 0 && junk < 0) throw new Error(`recover: over 4 GB and no room for ds64: ${path}`)
      if (ds64 < 0) put(Buffer.from('ds64'), junk), ds64 = junk + 8
      put(Buffer.from('RF64'), 0), put(u32(0xFFFFFFFF), 4), put(u32(0xFFFFFFFF), data + 4)
      put(u64(riff), ds64), put(u64(bytes), ds64 + 8), put(u64(frames), ds64 + 16)
      if (fact >= 0) put(u32(0xFFFFFFFF), fact)
    } else if (ds64 >= 0) {
      put(u64(riff), ds64), put(u64(bytes), ds64 + 8), put(u64(frames), ds64 + 16)
    } else {
      put(u32(riff), 4), put(u32(bytes), data + 4)
      if (fact >= 0) put(u32(frames), fact)
    }
    return { frames, before: Math.floor(told / block) }
  } finally { closeSync(fd) }
}
