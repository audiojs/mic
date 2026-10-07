export interface MicOptions {
  sampleRate?: number
  channels?: number
  bitDepth?: 8 | 16 | 24 | 32
  bufferSize?: number
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

export default function mic(opts?: MicOptions): ReadFn
