/**
 * @module audio-mic/browser
 *
 * Browser audio capture via getUserMedia + AudioWorklet.
 * Falls back to ScriptProcessorNode if AudioWorklet unavailable.
 *
 * Note: unlike node, browser mic() is async because getUserMedia requires permission.
 */
import queue, { iterator, overflow } from './src/queue.js'

/** The inputs: [{ id, name, default }] (names show once the page has been allowed the microphone) */
export async function devices() {
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
    .map(d => ({ id: d.deviceId, name: d.label, default: d.deviceId === 'default' }))
}

export default async function mic(opts = {}) {
  const channels = opts.channels || 1
  const sampleRate = opts.sampleRate || 44100
  const bitDepth = opts.bitDepth || 16
  const backlog = opts.backlog ?? 10000

  const constraints = {
    audio: {
      sampleRate: { ideal: sampleRate },
      channelCount: { ideal: channels },
      echoCancellation: opts.echoCancellation ?? false,
      noiseSuppression: opts.noiseSuppression ?? false,
      autoGainControl: opts.autoGainControl ?? false,
    }
  }
  // a device by its id, or by its name as enumerateDevices gives it
  if (opts.device) {
    let all = await devices(), d = String(opts.device).toLowerCase()
    let hit = all.find(x => x.id === opts.device || x.name === opts.device) ?? (m => m.length === 1 ? m[0] : null)(all.filter(x => x.name.toLowerCase().includes(d)))
    constraints.audio.deviceId = { exact: hit?.id ?? opts.device }
  }

  const stream = await navigator.mediaDevices.getUserMedia(constraints)

  const ownCtx = !opts.context
  const ctx = opts.context || new AudioContext({ sampleRate })
  const source = ctx.createMediaStreamSource(stream)

  // what is captured waits here until read: a read takes all of it, so a slow reader loses none
  const q = queue(backlog * ctx.sampleRate * channels * bitDepth / 8000)
  let closed = false

  // try AudioWorklet, fall back to ScriptProcessor
  let node
  if (ctx.audioWorklet) {
    const workletCode = `
      class MicProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0]
          if (input && input.length > 0) {
            const channels = []
            for (let i = 0; i < input.length; i++) channels.push(input[i].slice())
            this.port.postMessage(channels)
          }
          return true
        }
      }
      registerProcessor('mic-processor', MicProcessor)
    `
    const blob = new Blob([workletCode], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)

    node = new AudioWorkletNode(ctx, 'mic-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: channels,
      channelCountMode: 'explicit', // stereo devices are mixed down to the requested count, not interleaved as-is
      channelInterpretation: 'speakers'
    })
    source.connect(node)

    node.port.onmessage = (e) => {
      if (!closed && !q.push(float32ToPCM(e.data, bitDepth))) close(overflow(backlog))
    }
  } else {
    // ScriptProcessorNode fallback (deprecated but wider support)
    const bufSize = 2048
    node = ctx.createScriptProcessor(bufSize, channels, 1)
    source.connect(node)
    node.connect(ctx.destination) // required for processing to run

    node.onaudioprocess = (e) => {
      if (closed) return
      const chans = []
      for (let i = 0; i < channels; i++) chans.push(e.inputBuffer.getChannelData(i).slice())
      if (!q.push(float32ToPCM(chans, bitDepth))) close(overflow(backlog))
    }
  }

  read.close = () => close()
  read.end = () => close()
  read.backend = 'mediastream'
  read[Symbol.asyncIterator] = iterator(read)

  return read

  function read(cb) {
    if (cb == null) return close()
    // resume suspended context (autoplay policy)
    if (!closed && ctx.state === 'suspended') ctx.resume()
    q.read(cb)
  }

  // capture stops; what was captured still reads, then err if any, then the end
  function close(err) {
    if (closed) return
    closed = true
    source.disconnect()
    stream.getTracks().forEach(t => t.stop())
    if (ownCtx) ctx.close?.()
    q.end(err)
  }

  function float32ToPCM(channelData, bits) {
    const ch = channelData.length
    const len = channelData[0].length
    const bps = bits / 8
    const buf = new Uint8Array(len * ch * bps)
    const view = new DataView(buf.buffer)

    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const sample = channelData[c][i]
        const offset = (i * ch + c) * bps
        if (bits === 16) {
          view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true)
        } else if (bits === 32) {
          view.setFloat32(offset, sample, true)
        } else if (bits === 8) {
          buf[offset] = Math.max(0, Math.min(255, Math.round((sample + 1) * 127.5)))
        }
      }
    }
    return buf
  }
}
