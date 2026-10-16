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
