/**
 * Null backend — silent fallback for headless/CI environments.
 * Maintains timing contract: callback fires after audio duration,
 * delivering silence buffers at real-time rate.
 */
/** No devices: silence stands in for one */
export const devices = () => []

export function open({ sampleRate = 44100, channels = 1, bitDepth = 16, bufferSize = 50 } = {}) {
  const bpf = channels * (bitDepth / 8)
  const chunkFrames = Math.round(sampleRate * bufferSize / 1000)
  const chunkBytes = chunkFrames * bpf
  const t0 = performance.now()
  let closed = false, sent = 0

  return {
    // each block once the clock has passed its end, as a device would have it: a late read gets it at once
    read(cb) {
      if (closed) return cb?.(null, null)
      setTimeout(() => {
        if (closed) return cb?.(null, null)
        sent += chunkFrames
        cb?.(null, Buffer.alloc(chunkBytes))
      }, (sent + chunkFrames) * 1000 / sampleRate - (performance.now() - t0))
    },
    close() { closed = true }
  }
}
