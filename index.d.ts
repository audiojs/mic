export interface MicOptions {
  sampleRate?: number
  channels?: number
  bitDepth?: 8 | 16 | 24 | 32
  /** the most one block from the device holds, in ms (default 50) */
  bufferSize?: number
  /** the most audio held unread, in ms (default 10000): past it capture stops; what was held still reads, then an EOVERFLOW error, then the end */
  backlog?: number
  backend?: 'miniaudio' | 'process' | 'null'
  /** an input by its id or name (from devices()), else the one whose name holds it (any case); none: the default */
  device?: string
}

export interface Device {
  /** the platform's own: CoreAudio's UID, WASAPI's endpoint id, ALSA's or PulseAudio's name */
  id: string
  name: string
  default: boolean
}

/** The inputs */
export function devices(opts?: { backend?: 'miniaudio' | 'process' | 'null' }): Promise<Device[]>
/** A device's id by its id or name, else the one whose name holds `device` (any case) when only one does */
export function pick(all: Device[], device?: string): string | undefined

export interface ReadFn {
  (cb: (err: Error | null, chunk?: Buffer | Uint8Array | null) => void): void
  (cb: null): void
  end(): void
  close(): void
  backend: string
  [Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array>
}

export interface RecordOptions {
  /** an input by its id or name (from devices()), else the one whose name holds it; none: the default */
  device?: string
  /** the device's inputs to take, from 1 (default the first two, or the one) */
  channels?: number | number[]
  /** 16 (TPDF-dithered), 24 (default) or 32 (float) */
  bitDepth?: 16 | 24 | 32
  /** default the device's own; another switches the device to it */
  sampleRate?: number
  /** seconds the device's ring holds while the disk is slow (default 20) */
  ring?: number
  /** write over a file already there (default false: EEXIST) */
  overwrite?: boolean
}

export interface RecordStatus {
  /** frames written to each file, and as seconds */
  frames: number
  seconds: number
  /** each device input's peak since the last status (0..1), and its samples at full scale all along */
  peaks: number[]
  clips: number[]
  /** frames lost to a full ring, written as silence where they were */
  silenced: number
  /** frames read() missed, its reader more than 2 s behind (the file has them) */
  missed: number
  /** seconds since the device last gave audio */
  stalled: number
  /** times the system moved its default input elsewhere */
  rerouted: number
  /** the files are closed */
  done: boolean
  /** what ended the take: EDEVICELOST, ENOSPC, EIO… */
  error?: Error & { code: string }
}

export interface Take {
  sampleRate: number
  /** the device's input count */
  channels: number
  /** the device's name */
  device: string
  /** the device's own rate: differs from sampleRate only where it would not switch and the audio is converted */
  deviceRate: number
  bitDepth: number
  files: { path: string, channels: number[] }[]
  status(): RecordStatus
  /** the audio written since the last read, interleaved: the first file's channels, or every channel with no file; a
   *  reader more than 2 s behind misses audio here (RecordStatus.missed), never in the file */
  read(): Float32Array
  stop(): Promise<RecordStatus>
}

/** Record to WAV files, written by the addon as the audio comes: a path, or { path: inputs } for several at once */
export function record(to: string | Record<string, number | number[]>, opts?: RecordOptions & { backend?: 'miniaudio' }): Take

/** A WAV whose writer never finished: its header to the whole frames the file holds */
export function recover(path: string): { frames: number, before: number }

export default function mic(opts?: MicOptions): ReadFn
