import test from 'tst'
import { ok, is } from 'tst'

const isBrowser = typeof window !== 'undefined'
const isCI = !!process.env?.CI

if (isBrowser) test.manual = true

const { default: mic } = await import(isBrowser ? './browser.js' : './index.js')

const open = (opts) => isBrowser ? mic(opts) : mic(opts)

// helper: read N chunks then close
function capture(read, n = 1) {
  return new Promise((resolve, reject) => {
    const chunks = []
    ;(function next() {
      if (chunks.length >= n) { read.close(); return resolve(chunks) }
      read((err, chunk) => {
        if (err) return reject(err)
        if (!chunk) { read.close(); return resolve(chunks) }
        chunks.push(chunk)
        next()
      })
    })()
  })
}

// --- core ---

test('capture audio', async () => {
  const read = open()
  ok(read.backend, 'has backend')
  const chunks = await capture(read, 3)
  ok(chunks.length >= 1, 'got ' + chunks.length + ' chunks')
  ok(chunks[0].length > 0, 'chunk has data')
})

test('null stops capture', async () => {
  const read = open()
  read(null)
  // should not throw or hang
})

test('multiple chunks', async () => {
  const read = open()
  const chunks = await capture(read, 5)
  is(chunks.length, 5)
  for (const chunk of chunks) {
    ok(chunk.length > 0, 'non-empty chunk')
  }
})

test('double close is safe', async () => {
  const read = open()
  const chunks = await capture(read, 1)
  read.close() // second close — should not throw
})

// --- devices ---

test('devices: the inputs, each with its id and name, one the default; a device by name or part of it', { skip: isBrowser && 'browser: names need permission' }, async () => {
  const { devices, pick } = await import('./index.js')
  const all = await devices()
  ok(Array.isArray(all), `${all.length} inputs`)
  for (const d of all) ok(typeof d.id === 'string' && typeof d.name === 'string' && typeof d.default === 'boolean', `${d.name} (${d.id})`)
  ok(all.length === 0 || all.filter(d => d.default).length <= 1, 'at most one default')
  const fake = [{ id: 'a1', name: 'Built-in Microphone', default: true }, { id: 'b2', name: 'USB Audio CODEC', default: false }]
  is(pick(fake, 'b2'), 'b2', 'by id')
  is(pick(fake, 'Built-in Microphone'), 'a1', 'by name')
  is(pick(fake, 'usb'), 'b2', 'by part of its name, any case')
  is(pick(fake, 'o'), 'o', 'two hold it: as given, for the backend to refuse')
  if (!all.length) return
  const read = open({ device: all.at(-1).name })
  const chunks = await capture(read, 2)
  ok(chunks[0].length > 0, `captured from ${all.at(-1).name}`)
  let threw = null
  try { open({ device: 'no such device ' + Math.random() }) } catch (e) { threw = e }
  is(threw?.code, 'ENODEVICE', 'an unknown device: an error, not another device')
})

// --- formats ---

test('mono', async () => {
  const read = open({ channels: 1 })
  const chunks = await capture(read, 2)
  ok(chunks.length >= 1)
})

test('stereo', async () => {
  const read = open({ channels: 2 })
  const chunks = await capture(read, 2)
  ok(chunks.length >= 1)
})

test('48kHz', async () => {
  const read = open({ sampleRate: 48000 })
  const chunks = await capture(read, 2)
  ok(chunks.length >= 1)
})

test('22050Hz sample rate', async () => {
  const read = open({ sampleRate: 22050 })
  const chunks = await capture(read, 2)
  ok(chunks.length >= 1)
})

test('96kHz sample rate', async () => {
  const read = open({ sampleRate: 96000 })
  const chunks = await capture(read, 2)
  ok(chunks.length >= 1)
})

// --- timing ---

test('callback pacing: captured data volume matches real-time', { skip: !!process.env.CI && 'shared CI runners cannot guarantee real-time capture pacing (macos-18 leg measured 0.06x)' }, async () => {
  const sr = 44100, ch = 1, bps = 2
  const read = open({ sampleRate: sr, channels: ch, bitDepth: 16, bufferSize: 50 })
  const durationMs = 1000

  const wallStart = performance.now()
  const chunks = []
  await new Promise((resolve) => {
    ;(function next() {
      if (performance.now() - wallStart >= durationMs) { read.close(); return resolve() }
      read((err, chunk) => {
        if (chunk) chunks.push(chunk)
        next()
      })
    })()
  })
  const wallMs = performance.now() - wallStart

  const totalBytes = chunks.reduce((a, c) => a + c.length, 0)
  const audioMs = totalBytes / (sr * ch * bps) * 1000
  const ratio = audioMs / wallMs
  // device startup can eat 100-200ms on CI, so allow 0.3x lower bound
  ok(ratio > 0.3, `rate ${ratio.toFixed(2)}x (${audioMs.toFixed(0)}ms audio in ${wallMs.toFixed(0)}ms wall)`)
  ok(ratio < 2.0, `rate not too fast: ${ratio.toFixed(2)}x`)
})

// --- edge cases ---

test('rapid open/close', async () => {
  for (let i = 0; i < 5; i++) {
    const read = open()
    read.close()
  }
})

test('close during active read must not crash', async () => {
  const read = open()
  read((err, chunk) => {})
  await new Promise(resolve => setTimeout(resolve, 5))
  read.close()
  ok(true, 'no crash on close during active read')
})

// --- Node-only ---

if (!isBrowser) {
  test('stream: Readable', async () => {
    const { default: readable } = await import('./stream.js')
    const stream = readable({ bufferSize: 50 })
    const chunks = []

    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => {
        chunks.push(chunk)
        if (chunks.length >= 3) stream.destroy()
      })
      stream.on('close', resolve)
      stream.on('error', reject)
    })

    ok(chunks.length >= 3, 'got ' + chunks.length + ' stream chunks')
    ok(chunks[0].length > 0, 'stream chunk has data')
  })

  test('stream: highWaterMark matches buffer size', async () => {
    const { default: readable } = await import('./stream.js')
    const stream = readable({ sampleRate: 44100, channels: 1, bitDepth: 16, bufferSize: 50 })
    // 50ms × 44100Hz × 1ch × 2bytes = 4410 bytes
    is(stream.readableHighWaterMark, 4410)
    stream.destroy()
    await new Promise(resolve => stream.on('close', resolve))
  })

  test('stream: destroy mid-capture', async () => {
    const { default: readable } = await import('./stream.js')
    const stream = readable()
    stream.resume()
    stream.destroy()
    await new Promise(resolve => stream.on('close', resolve))
  })

  test('explicit miniaudio backend', async () => {
    const read = open({ backend: 'miniaudio' })
    is(read.backend, 'miniaudio')
    const chunks = await capture(read, 1)
    ok(chunks.length >= 1)
  })

  test('captured PCM has valid samples', async () => {
    const read = open({ channels: 1, bitDepth: 16 })
    const chunks = await capture(read, 5)

    const all = Buffer.concat(chunks)
    ok(all.length > 0, 'captured data is non-empty')
    ok(all.length % 2 === 0, 'data aligned to 16-bit frames')

    let valid = 0
    for (let i = 0; i < all.length - 1; i += 2) {
      const sample = all.readInt16LE(i)
      if (sample >= -32768 && sample <= 32767) valid++
    }
    is(valid, all.length / 2, 'all samples in valid int16 range')
  })

  test('capture: verify chunk sizes match buffer config', async () => {
    const { open } = await import('./src/backends/miniaudio.js')
    const device = open({ sampleRate: 44100, channels: 1, bitDepth: 16, bufferSize: 50 })
    const bpf = 2

    const chunks = []
    await new Promise((resolve) => {
      let n = 0
      ;(function next() {
        if (n >= 5) { device.close(); return resolve() }
        device.read((err, chunk) => {
          if (chunk) chunks.push(chunk)
          n++
          next()
        })
      })()
    })

    ok(chunks.length >= 1, 'got chunks from miniaudio backend')
    for (const chunk of chunks) {
      ok(chunk.length > 0, 'chunk is non-empty')
      ok(chunk.length % bpf === 0, 'chunk length aligned to frame size')
    }
  })

  // --- a reader slower than capture ---

  const bpms = 88.2 // bytes a ms at 44100 Hz, mono, 16-bit
  const next = read => new Promise(r => read((err, chunk) => r([err, chunk])))

  // a reader taking `delay` ms over each chunk for `ms`: the chunks it got, and their audio against the time passed
  async function pace(opts, delay, ms = 1500) {
    const read = open({ sampleRate: 44100, channels: 1, bitDepth: 16, ...opts })
    const t0 = performance.now(), sizes = []
    for await (const chunk of read) {
      sizes.push(chunk.length)
      if (performance.now() - t0 > ms) break
      if (delay) await new Promise(r => setTimeout(r, delay))
    }
    return { sizes, ratio: sizes.reduce((a, b) => a + b, 0) / bpms / (performance.now() - t0) }
  }

  test('slow reader: every sample, 200 ms over each read', async () => {
    const { ratio, sizes } = await pace({ backend: 'null' }, 200)
    ok(ratio > 0.9 && ratio < 1.02, `${ratio.toFixed(3)}x the time passed, in ${sizes.length} reads`)
    ok(sizes.some(n => n > 4410), 'a read takes all that waited')
  })

  test('slow reader: every sample from the device', { skip: isCI && 'shared CI runners cannot guarantee real-time capture pacing' }, async () => {
    const { ratio, sizes } = await pace({}, 200)
    ok(ratio > 0.9 && ratio < 1.1, `${ratio.toFixed(3)}x the time passed, in ${sizes.length} reads`)
  })

  test('fast reader: each block as it comes', async () => {
    const { ratio, sizes } = await pace({ backend: 'null' }, 0)
    ok(sizes.every(n => n === 4410), `${sizes.length} blocks of 50 ms`)
    ok(ratio > 0.9 && ratio < 1.02, `${ratio.toFixed(3)}x the time passed`)
    if (isCI) return
    const dev = await pace({}, 0, 500)
    ok(dev.sizes.every(n => n <= 4410), `device: ${dev.sizes.length} blocks, none past bufferSize`)
  })

  test('stop while audio waits: it is read, then the end', async () => {
    const read = open({ backend: 'null' })
    await new Promise(r => setTimeout(r, 300))
    read.close()
    const sizes = []
    for await (const chunk of read) sizes.push(chunk.length)
    is(sizes.length, 1, 'all of it in one read')
    ok(sizes[0] / bpms >= 200 && sizes[0] / bpms <= 300, `${sizes[0] / bpms} ms captured before the stop`)
    is(await next(read), [null, null], 'then the end')
  })

  test('overflow: past backlog capture stops; what was held reads, then EOVERFLOW, then the end', async () => {
    const read = open({ backend: 'null', backlog: 300 }), iter = open({ backend: 'null', backlog: 300 })
    await new Promise(r => setTimeout(r, 700))
    const [err, held] = await next(read)
    is(err, null)
    is(held.length, 300 * bpms, 'the backlog held: 300 ms')
    const [over, none] = await next(read)
    is(over?.code, 'EOVERFLOW', over?.message)
    is(none, null)
    is(await next(read), [null, null], 'then the end')

    let got = 0, thrown = null
    try { for await (const chunk of iter) got += chunk.length } catch (e) { thrown = e }
    is(got, 300 * bpms, 'for await: the backlog held')
    is(thrown?.code, 'EOVERFLOW', 'then the error, thrown')
  })

  test('event loop held past the device ring: what came reads, then EOVERFLOW', { skip: isCI && 'shared CI runners cannot guarantee real-time capture pacing' }, async () => {
    const read = open({ backlog: 100, bufferSize: 10 }) // the ring: 100 ms, 186 ms as a power of two
    let got = 0, err = null, held = false
    await new Promise(done => (function more() {
      read((e, chunk) => {
        if (e) return err = e, more()
        if (!chunk) return done()
        got += chunk.length
        if (!held && got > 200 * bpms) { held = true; const t = performance.now(); while (performance.now() - t < 600); }
        more()
      })
    })())
    is(err?.code, 'EOVERFLOW', err?.message)
    ok(/event loop/.test(err?.message), 'the ring overflowed, not the backlog')
    ok(got / bpms > 300, `${(got / bpms).toFixed(0)} ms read before it`)
  })
}

// --- recording to disk (the addon writes; nothing JS does reaches the take) ---

if (!isBrowser) {
  const { record, recover, devices } = await import('./index.js')
  const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync, spawn } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'mic-record-'))
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  const none = !(await devices()).length && 'no input device'
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const has = cmd => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false } }
  // the references: Apple's AudioFile (afinfo) and FFmpeg (ffprobe) read the files as any other program would
  const afinfo = process.platform === 'darwin' && has('afinfo'), ffprobe = has('ffprobe')
  const probe = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path])).streams[0]
  const afDuration = path => +execFileSync('afinfo', [path]).toString().match(/estimated duration: ([\d.]+)/)[1]
  // afinfo prints six decimals: the length to the microsecond, under a frame at any rate
  const afIs = (path, seconds, msg) => ok(Math.abs(afDuration(path) - seconds) < 1e-6, `${msg}: ${afDuration(path)} s`)

  // the header as written: RIFF or RF64, fmt, fact, data; sizes as ds64 tells them past 4 GB
  function wav(path) {
    const b = readFileSync(path), out = { id: b.toString('latin1', 0, 4), riff: b.readUInt32LE(4), size: b.length }
    for (let at = 12; at + 8 <= b.length;) {
      const name = b.toString('latin1', at, at + 4), len = b.readUInt32LE(at + 4)
      if (name === 'fmt ') Object.assign(out, { tag: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), block: b.readUInt16LE(at + 20), bits: b.readUInt16LE(at + 22) })
      if (name === 'ds64') Object.assign(out, { riff64: Number(b.readBigUInt64LE(at + 8)), data64: Number(b.readBigUInt64LE(at + 16)), samples64: Number(b.readBigUInt64LE(at + 24)) })
      if (name === 'fact') out.fact = b.readUInt32LE(at + 8)
      if (name === 'data') { out.at = at + 8; out.data = len === 0xFFFFFFFF ? out.data64 : len; out.audio = b.subarray(at + 8, at + 8 + Math.min(out.data, b.length - at - 8)); break }
      at += 8 + len + (len & 1)
    }
    return out
  }

  // a child process recording, which the test then kills or lets exit: ready once the device has given audio, and how
  // long that took (a device can be slow to start: that is the device's, not what these tests are about)
  const child = (path, after) => new Promise((done, fail) => {
    const code = `import { record } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)}
      const t0 = performance.now(), take = record(${JSON.stringify(path)})
      const id = setInterval(() => { if (!take.status().frames) return; clearInterval(id); console.log(Math.round(performance.now() - t0)); ${after} }, 2)
      setTimeout(() => { if (!take.status().frames) console.log(-1), process.exit(1) }, 5000)`
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
    p.stdout.once('data', d => done(Object.assign(p, { started: +d })))
    p.once('error', fail)
  })

  test('record: the device at its own rate, its first two inputs (or its one), 24-bit, as it comes', { skip: none }, async () => {
    const path = join(dir, 'take.wav'), take = record(path)
    ok(take.sampleRate > 0 && take.channels > 0, `${take.device}: ${take.channels} in at ${take.sampleRate} Hz`)
    is(take.deviceRate, take.sampleRate, 'the device\'s own rate: nothing resampled')
    is(take.files, [{ path, channels: take.channels > 1 ? [1, 2] : [1] }])
    await sleep(1500)
    const mid = take.status(), head = wav(path)
    ok(mid.frames > 0 && !mid.done && !mid.error, `${mid.seconds.toFixed(2)} s written while recording`)
    is(mid.peaks.length, take.channels, 'a peak for each input')
    ok(head.data > 0 && head.data <= head.size - head.at, `the header already tells ${head.data} bytes`)
    const end = await take.stop()
    ok(end.done && !end.error && end.silenced === 0, 'stopped: done, nothing lost')
    // shared CI runners can't keep a device's real time (macos-18 measured 0.06x): the length checked on a machine of one's own
    if (!isCI) ok(end.seconds > 1.2 && end.seconds < 2.2, `${end.seconds.toFixed(3)} s`)
    is(await take.stop(), end, 'stop again: the same')
    const w = wav(path)
    is([w.id, w.tag, w.bits, w.rate, w.channels], ['RIFF', 1, 24, take.sampleRate, take.channels > 1 ? 2 : 1], 'RIFF, PCM 24-bit, the device rate')
    is(w.data, end.frames * w.block, 'data: every frame')
    is(w.riff + 8, w.size, 'RIFF size: the file')
    if (afinfo) afIs(path, end.frames / take.sampleRate, 'afinfo reads it whole')
    if (ffprobe) is(+probe(path).duration_ts, end.frames, 'ffprobe reads it whole')
  })

  test('record: 16-bit (dithered), 24-bit, 32-bit float', { skip: none }, async () => {
    for (const [bitDepth, codec, tag] of [[16, 'pcm_s16le', 1], [24, 'pcm_s24le', 1], [32, 'pcm_f32le', 3]]) {
      const path = join(dir, `bits${bitDepth}.wav`), take = record(path, { bitDepth, channels: [1] })
      await sleep(400)
      const end = await take.stop(), w = wav(path)
      is([w.tag, w.bits, w.block, w.data], [tag, bitDepth, bitDepth / 8, end.frames * bitDepth / 8], `${bitDepth}-bit: header`)
      if (bitDepth === 32) is(w.fact, end.frames, 'float: fact tells the frames')
      if (ffprobe) is([probe(path).codec_name, +probe(path).duration_ts], [codec, end.frames], `ffprobe: ${codec}`)
    }
  })

  test('record: several files, one clock: the same input in each, sample for sample', { skip: none }, async () => {
    const a = join(dir, 'a.wav'), b = join(dir, 'b.wav'), c = join(dir, 'c.wav')
    const take = record({ [a]: 1, [b]: [1, 1], [c]: [1, 1, 1] })
    is(take.files.map(f => f.channels), [[1], [1, 1], [1, 1, 1]])
    await sleep(800)
    const end = await take.stop(), wa = wav(a), wb = wav(b), wc = wav(c)
    is([wa.data / 3, wb.data / 6, wc.data / 9], [end.frames, end.frames, end.frames], 'each: every frame')
    is(wc.tag, 0xFFFE, 'three channels: WAVE_FORMAT_EXTENSIBLE')
    let same = true
    for (let i = 0; i < end.frames && same; i++) {
      const x = wa.audio.readIntLE(i * 3, 3)
      same = x === wb.audio.readIntLE(i * 6, 3) && x === wb.audio.readIntLE(i * 6 + 3, 3) && x === wc.audio.readIntLE(i * 9 + 6, 3)
    }
    ok(same, 'every sample the same in every file and channel')
    if (ffprobe) is(+probe(c).channels, 3, 'ffprobe: three channels')
  })

  test('record: no files: every input\'s level, nothing written', { skip: none }, async () => {
    const watch = record({})
    is(watch.files, [])
    await sleep(500)
    const s = watch.status()
    ok(s.frames > 0 && s.peaks.length === watch.channels, `${s.frames} frames heard, ${s.peaks.length} levels`)
    const end = await watch.stop()
    ok(end.done && !end.error, 'stopped')
  })

  test('record: refused before anything is written: an input the device lacks, a file already there', { skip: none }, async () => {
    const path = join(dir, 'refused.wav')
    let e = null
    try { record(path, { channels: [99] }) } catch (err) { e = err }
    is(e?.code, 'ECHANNEL', e?.message)
    ok(!existsSync(path), 'no file left')
    try { record(path, { channels: [0] }) } catch (err) { e = err }
    is(e?.code, 'ECHANNEL', 'inputs count from 1')
    writeFileSync(path, 'a take from before')
    e = null
    try { record(path) } catch (err) { e = err }
    is(e?.code, 'EEXIST', e?.message)
    is(readFileSync(path, 'utf8'), 'a take from before', 'the file there untouched')
    const take = record(path, { overwrite: true })
    await sleep(200)
    await take.stop()
    is(wav(path).id, 'RIFF', 'overwrite: true writes over it')
  })

  test('record: the event loop held 3 s: every frame written', { skip: none || isCI && 'shared CI runners cannot guarantee real-time capture pacing' }, async () => {
    const path = join(dir, 'held.wav'), take = record(path), t0 = performance.now()
    await sleep(200)
    while (performance.now() - t0 < 3200);
    await sleep(300)
    const end = await take.stop(), wall = (performance.now() - t0) / 1000
    is(end.silenced, 0, 'nothing lost')
    ok(end.seconds > wall - 0.4 && end.seconds <= wall + 0.1, `${end.seconds.toFixed(2)} s written in ${wall.toFixed(2)} s`)
  })

  test('record: killed mid-take: the header tells all but the last second; recover() the rest', { skip: none }, async () => {
    const path = join(dir, 'killed.wav'), p = await child(path, 'setInterval(() => {}, 1000)')
    ok(p.started >= 0, p.started < 0 ? 'the device gave no audio in 5 s' : `the device gave audio ${p.started} ms in`)
    await sleep(2500)
    is(p.exitCode ?? p.signalCode, null, 'the child recording still, when killed')
    p.kill('SIGKILL')
    await new Promise(r => p.once('exit', r))
    const w = wav(path), held = w.size - w.at, second = w.rate * w.block
    ok(w.data > 0 && w.data <= held && held - w.data <= 1.3 * second, `the header: ${(w.data / second).toFixed(2)} s of the ${(held / second).toFixed(2)} s there`)
    const { frames, before } = recover(path), r = wav(path)
    is(before, w.data / w.block, 'recover: what the header told')
    is([frames, r.data, r.riff + 8], [Math.floor(held / w.block), frames * w.block, r.size], 'recover: every whole frame there')
    if (!isCI) ok(frames / w.rate > 2.4 && frames / w.rate < 3.2, `${(frames / w.rate).toFixed(2)} s of the 2.5 s after the first audio`)
    if (afinfo) afIs(path, frames / w.rate, 'afinfo reads it whole')
  })

  test('record: process.exit() with the take going: closed whole', { skip: none }, async () => {
    const path = join(dir, 'exited.wav'), p = await child(path, 'setTimeout(() => process.exit(0), 700)')
    ok(p.started >= 0, p.started < 0 ? 'the device gave no audio in 5 s' : `the device gave audio ${p.started} ms in`)
    await new Promise(r => p.exitCode != null ? r() : p.once('exit', r))
    const w = wav(path)
    ok(w.data > 0, `${(w.data / w.block / w.rate).toFixed(2)} s`)
    is(w.data, w.size - w.at, 'the header tells every byte')
  })

  test('record: past 4 GB RIFF turns RF64 in place (rf64At brings 4 GB near)', { skip: none }, async () => {
    const path = join(dir, 'long.wav'), take = record(path, { channels: [1], rf64At: 4096 })
    await sleep(1500)
    const end = await take.stop(), w = wav(path)
    is([w.id, w.riff], ['RF64', 0xFFFFFFFF], 'RF64, its RIFF size -1')
    is([w.riff64, w.data64, w.samples64], [w.size - 8, end.frames * 3, end.frames], 'ds64: the sizes')
    if (ffprobe) is(+probe(path).duration_ts, end.frames, 'ffprobe reads RF64')
    if (afinfo) afIs(path, end.frames / w.rate, 'afinfo reads RF64')
    const { frames } = recover(path)
    is(frames, end.frames, 'recover: RF64 as well')
  })
}
