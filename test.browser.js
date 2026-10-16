/**
 * Browser tests: browser.js in headless Chromium, its fake microphone playing a 997 Hz sine from a file.
 * A lost block shows as a break in the sine: 997 cycles a second never fit a whole number of 128-frame blocks at 48 kHz,
 * and a second of it loops seamlessly.
 */
import test, { ok, is } from 'tst'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

test.manual = true

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/\/+$/, '')
const sr = 48000, f = 997, amp = 0.5

const dir = await mkdtemp(join(tmpdir(), 'mic-'))
const wav = join(dir, 'sine.wav')
await writeFile(wav, sine(10))

const server = createServer(async (req, res) => {
  const path = resolve(root, normalize(req.url.split('?')[0]).replace(/^\//, ''))
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }), res.end('<!doctype html>')
  if (!path.startsWith(root + sep)) return res.writeHead(403), res.end()
  try { res.writeHead(200, { 'content-type': 'text/javascript' }), res.end(await readFile(path)) }
  catch { res.writeHead(404), res.end() }
})
await new Promise(r => server.listen(0, r))

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav, '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
page.on('pageerror', e => console.error('page:', e.message))
await page.goto(`http://localhost:${server.address().port}/`)

// a reader taking `delay` ms over each chunk, through for await, for `ms`: its samples, chunk sizes and the time passed
const pace = (delay, ms = 2000) => page.evaluate(async ({ delay, ms, sr }) => {
  const { default: mic } = await import('/browser.js')
  const read = await mic({ sampleRate: sr })
  const t0 = performance.now(), parts = []
  for await (const c of read) {
    parts.push(new Int16Array(c.buffer, c.byteOffset, c.byteLength / 2))
    if (performance.now() - t0 > ms) break
    if (delay) await new Promise(r => setTimeout(r, delay))
  }
  return { elapsed: performance.now() - t0, sizes: parts.map(p => p.length), x: parts.flatMap(p => [...p]) }
}, { delay, ms, sr })

test('slow reader: every sample, 200 ms over each read', { timeout: 15000 }, async () => {
  const { x, sizes, elapsed } = await pace(200)
  const ratio = x.length / (elapsed / 1000 * sr)
  ok(ratio > 0.9 && ratio < 1.05, `${x.length} samples in ${elapsed.toFixed(0)} ms: ${ratio.toFixed(3)}x`)
  ok(sizes.slice(1).every(n => n > 128), `a read takes all that waited: ${sizes.length} reads`)
  is(breaks(x), [], 'the sine unbroken')
})

test('fast reader: each block as it comes', { timeout: 15000 }, async () => {
  const { x, sizes, elapsed } = await pace(0)
  const ratio = x.length / (elapsed / 1000 * sr)
  ok(ratio > 0.9 && ratio < 1.05, `${ratio.toFixed(3)}x`)
  ok(sizes.every(n => n === 128), `${sizes.length} blocks of 128 frames`)
  is(breaks(x), [], 'the sine unbroken')
})

test('stop while audio waits: it is read, then the end', { timeout: 15000 }, async () => {
  const r = await page.evaluate(async ({ sr }) => {
    const { default: mic } = await import('/browser.js')
    const read = await mic({ sampleRate: sr })
    const next = () => new Promise(r => read((err, chunk) => r([err, chunk])))
    const pcm = c => [...new Int16Array(c.buffer, c.byteOffset, c.byteLength / 2)]
    // the block after the sine has come in, so its seam with what is held is checked
    let first
    while (!pcm((first = (await next())[1])).some(v => Math.abs(v) > 0.45 * 32767));
    first = (await next())[1]
    await new Promise(r => setTimeout(r, 300))
    read(null)
    const [err, held] = await next(), end = await next()
    return { x: [...pcm(first), ...pcm(held)], held: held.byteLength / 2, err, end }
  }, { sr })
  is(r.err, null)
  ok(r.held >= 0.25 * sr && r.held <= 0.4 * sr, `${(r.held / sr * 1000).toFixed(0)} ms captured before the stop, in one read`)
  is(breaks(r.x), [], 'the sine unbroken from the first read on')
  is(r.end, [null, null], 'then the end')
})

test('overflow: a reader that never reads; past backlog capture stops, what was held reads, then EOVERFLOW, then the end', { timeout: 15000 }, async () => {
  const r = await page.evaluate(async ({ sr }) => {
    const { default: mic } = await import('/browser.js')
    const read = await mic({ sampleRate: sr, backlog: 200 })
    await new Promise(r => setTimeout(r, 700))
    const parts = []
    let thrown = null
    try { for await (const c of read) parts.push(...new Int16Array(c.buffer, c.byteOffset, c.byteLength / 2)) } catch (e) { thrown = { code: e.code, message: e.message } }
    const end = await new Promise(r => read((err, chunk) => r([err, chunk])))
    return { x: parts, thrown, end }
  }, { sr })
  is(r.x.length, 0.2 * sr, 'the backlog held: 200 ms')
  is(breaks(r.x), [], 'the sine unbroken')
  is(r.thrown?.code, 'EOVERFLOW', r.thrown?.message)
  is(r.end, [null, null], 'then the end')
})

try { process.exitCode = (await test.run()).failed.length ? 1 : 0 }
finally { await browser.close(), server.close(), await rm(dir, { recursive: true }) }

// where the sine breaks: x[n] = 2cos(w)x[n-1] - x[n-2] holds to a few LSB for a sine, a lost block misses by far more
function breaks(x) {
  const c = 2 * Math.cos(2 * Math.PI * f / sr), out = []
  const from = x.findIndex(v => Math.abs(v) > 0.9 * amp * 32767) + 32 // the fake device starts silent, then fades in
  if (from < 32) return ['no sine']
  for (let i = Math.max(2, from); i < x.length; i++) if (Math.abs(x[i] - c * x[i - 1] + x[i - 2]) > 0.01 * 32767) out.push(i)
  return out
}

// `s` seconds of the sine, 16-bit mono WAV at sr
function sine(s) {
  const n = sr * s, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0), b.writeUInt32LE(36 + n * 2, 4), b.write('WAVEfmt ', 8), b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20), b.writeUInt16LE(1, 22), b.writeUInt32LE(sr, 24), b.writeUInt32LE(sr * 2, 28)
  b.writeUInt16LE(2, 32), b.writeUInt16LE(16, 34), b.write('data', 36), b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(2 * Math.PI * f * i / sr)), 44 + i * 2)
  return b
}
