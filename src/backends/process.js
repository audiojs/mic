/**
 * Process backend — capture PCM from system audio tools (last resort)
 */
import { spawn, execSync } from 'node:child_process'
import { platform } from 'node:os'

function tryExec(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true } catch { return false }
}

// device: the tool's own name for it (avfoundation's, PulseAudio's, ALSA's, SoX's AUDIODEV)
function findRecorder(sampleRate, channels, bitDepth, device) {
  const os = platform()
  const fmt = bitDepth === 8 ? 'u8' : bitDepth === 32 ? 'f32le' : `s${bitDepth}le`

  if (os === 'darwin' && tryExec('ffmpeg -version'))
    return ['ffmpeg', ['-f', 'avfoundation', '-i', ':' + (device || 'default'), '-f', fmt, '-ar', sampleRate, '-ac', channels, '-']]

  if (os === 'linux' && tryExec('ffmpeg -version'))
    return ['ffmpeg', ['-f', 'pulse', '-i', device || 'default', '-f', fmt, '-ar', sampleRate, '-ac', channels, '-']]

  if (tryExec('sox --version'))
    return ['sox', ['-d', '-t', 'raw', '-r', sampleRate, '-c', channels, '-b', bitDepth, '-e', 'signed-integer', '-L', '-'], device && { AUDIODEV: device }]

  if (os === 'linux' && tryExec('arecord --version')) {
    const afmt = bitDepth === 8 ? 'U8' : bitDepth === 32 ? 'FLOAT_LE' : `S${bitDepth}_LE`
    return ['arecord', ['-f', afmt, '-r', sampleRate, '-c', channels, '-t', 'raw', ...device ? ['-D', device] : []]]
  }

  return null
}

/** The tools don't list devices: none known */
export const devices = () => []

export function open({ sampleRate = 44100, channels = 1, bitDepth = 16, device } = {}) {
  const recorder = findRecorder(sampleRate, channels, bitDepth, device)
  if (!recorder) throw new Error('No audio recorder found (install ffmpeg or sox)')

  const [cmd, args, env] = recorder
  const proc = spawn(cmd, args.map(String), { stdio: ['ignore', 'pipe', 'ignore'], env: env ? { ...process.env, ...env } : process.env })

  let closed = false
  let pending = null

  // the recorder gone on its own: a read waiting is told, not left hanging
  proc.on('close', () => {
    closed = true
    const cb = pending
    pending = null
    cb?.(new Error('Process exited'), null)
  })

  // flowing only while a read waits: paused, the pipe holds what comes next, none dropped
  proc.stdout.on('data', (chunk) => {
    const cb = pending
    pending = null
    proc.stdout.pause()
    cb(null, chunk)
  })
  proc.stdout.pause()

  proc.stdout.on('error', () => {})

  return {
    read(cb) {
      if (closed) return cb?.(new Error('Process exited'), null)
      pending = cb
      proc.stdout.resume()
    },

    close() {
      if (closed) return
      closed = true
      pending = null
      proc.stdout.destroy()
      proc.kill()
    }
  }
}
