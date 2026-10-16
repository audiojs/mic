export interface BrowserMicOptions {
  sampleRate?: number
  channels?: number
  bitDepth?: 8 | 16 | 32
  context?: AudioContext
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  /** the most audio held unread, in ms (default 10000): past it capture stops; what was held still reads, then an EOVERFLOW error, then the end */
  backlog?: number
  /** an input by its id or name (from devices()), else the one whose name holds it */
  device?: string
}

export interface Device { id: string, name: string, default: boolean }

/** The inputs (names show once the page has been allowed the microphone) */
export function devices(): Promise<Device[]>

export interface ReadFn {
  (cb: (err: Error | null, chunk?: Uint8Array | null) => void): void
  (cb: null): void
  end(): void
  close(): void
  backend: 'mediastream'
}

export default function mic(opts?: BrowserMicOptions): Promise<ReadFn>
