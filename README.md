# @audio/mic

Try it in the browser: [Tuner](https://audiojs.dev/util/tuner/), [Audio recorder](https://audiojs.dev/util/recorder/), [Room and speaker measurement](https://audiojs.dev/util/measure/). Runs on this package, nothing is uploaded.

Capture audio from microphone in node or browser.

## Usage

```js
import mic from '@audio/mic'

let read = mic({
  sampleRate: 44100,
  channels: 1,
  bitDepth: 16,
  // bufferSize: 50,       // the most one block holds, ms (default 50)
  // backlog: 10000,       // the most held unread, ms (default 10000)
  // backend: 'miniaudio', // force backend
})

read((err, pcmBuffer) => {
  // process chunk
})
read(null) // stop capture
```

### Async iterable

```js
import mic from '@audio/mic'

let read = mic({ sampleRate: 44100, channels: 1 })
for await (let chunk of read) {
  // process PCM chunk
}
```

A `break` out of the loop stops capture. An overflow (see [`read(cb)`](#readcb)) is thrown.

### Devices

```js
import mic, { devices } from '@audio/mic'

await devices()
// [{ id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', default: true }, …]

let read = mic({ device: 'USB' })   // by id, by name, or by part of its name when only one holds it
```

Ids are the platform's own: CoreAudio's UID, WASAPI's endpoint id, the ALSA or PulseAudio name. A device that isn't there is an error (`code: 'ENODEVICE'`), never another device. In the browser, `devices()` reads `enumerateDevices()` (names show once the page may use the microphone) and `device` becomes the `deviceId` getUserMedia asks for.

### Record to disk

```js
import { record } from '@audio/mic'

let take = record('take.wav', { device: 'Scarlett', channels: [1, 2] })   // inputs from 1, as the interface labels them
take.status()          // { seconds, peaks, clips, silenced, stalled, rerouted, missed, done, error }: peaks since the last call
take.read()            // Float32Array: the audio written since the last read, interleaved, to draw or hear it as it comes
await take.stop()      // the same, once the file is closed

// several files from one device, one clock: tracks of one take, sample for sample together
record({ 'voice.wav': [1], 'guitar.wav': [2], 'room.wav': [3, 4] }, { device: 'Scarlett' })

// no files: every input's level, nothing written, to set levels before recording
record({}, { device: 'Scarlett' }).status().peaks
```

The addon writes the file itself, from a ring of 20 s the device fills, so nothing in JS reaches the take: an event loop held for minutes, a crash, a kill. The device runs at its own rate and gives float; nothing is resampled unless `sampleRate` asks for another rate, and then the device switches to it (on macOS, as Audio MIDI Setup would).

- **On disk as it comes.** Every second the header tells the length so far and the file is flushed to the disk itself (`F_FULLFSYNC` on macOS, where `fsync` stops at the drive's cache). A process killed or a power cut leaves a WAV that plays to its last second; `recover(path)` gives it the rest. `process.exit()` and an ending environment close it whole.
- **Nothing lost quietly.** Frames the ring had no room for (a disk stalled 20 s) are written as silence where they were, so the take keeps time, and counted in `silenced`. A device that stops, unplugged, ends the take with `error.code === 'EDEVICELOST'`, written to its last frame; seconds without audio from it read as `stalled`; the system moving its default input elsewhere counts in `rerouted`.
- **Never over a take.** A file already there is an error (`EEXIST`) unless `overwrite: true`; an input the device lacks is `ECHANNEL`; either before anything is written.
- **WAV as every program reads it**: PCM 16-bit (TPDF-dithered) or 24-bit, or 32-bit float; `WAVE_FORMAT_EXTENSIBLE` over two channels; past 4 GB the header turns RF64 in place (EBU Tech 3306), into the JUNK chunk kept for it.

On macOS an input opened while the system still asks for the microphone permission waits for the answer, and the thread that opened it with it: an app asks first (`AVCaptureDevice.requestAccess`), and opens an input once it is answered.

Options: `device`, `channels` (inputs, default the first two or the one), `bitDepth` (`16`, `24` (default), `32`), `sampleRate` (default the device's own), `ring` (seconds, default 20), `overwrite`. The take tells `sampleRate`, `channels` (the device's), `device` (its name) and `files` (`[{ path, channels }]`).

```js
import { recover } from '@audio/mic'
recover('take.wav')    // → { frames, before }: the frames the file holds, and those its header told
```

### Node Readable

```js
import MicReadable from '@audio/mic/stream'

MicReadable({ sampleRate: 44100, channels: 1 }).pipe(dest)
```

## Backends

Tried in order; first successful one wins.

| Backend | How | Latency | Install |
|---|---|---|---|
| `miniaudio` | N-API addon wrapping [miniaudio.h](https://github.com/mackron/miniaudio) | Low | Prebuilt via `@audio/mic-*` packages |
| `process` | Pipes from ffmpeg/sox/arecord | High | System tool must be installed |
| `null` | Silent, maintains timing contract | — | Built-in (CI/headless fallback) |
| `mediastream` | getUserMedia + AudioWorklet (browser) | Low | Built-in |

## API

### `read = mic(opts?)`

Returns a source function. Options:

- `sampleRate` — default `44100`
- `channels` — default `1`
- `bitDepth` — `8`, `16` (default), `24`, `32`
- `bufferSize` — the most one block from the device holds, in ms, default `50`
- `backlog` – the most audio held unread, in ms, default `10000` (see [`read(cb)`](#readcb))
- `device` — an input by id or name (`devices()`), default the system's
- `backend` — force a specific backend

### `read(cb)`

Read PCM data. Callback fires with each captured chunk: `(err, buffer) => {}`.

Capture doesn't wait for reads: what comes between them is held, and the next read takes all of it in one buffer, so a reader that takes its time loses nothing. Past `backlog` held unread, capture stops: what was held still reads, then an error with `code: 'EOVERFLOW'`, then the end (`null`). In node the device's own ring holds what comes while the event loop is busy, `backlog`'s worth up to 2 s, and overflows the same way. A device that stops of itself (unplugged) ends it the same way, with `code: 'EDEVICELOST'`.

### `read(null)`

Stop capture. Closes the audio device. What was captured before it still reads, then `null`.

### `read.close()`

Immediately close the audio device.

### `read.backend`

Name of the active backend (`'miniaudio'`, `'process'`, `'null'`, `'mediastream'`).

## Building

```sh
npm run build          # compile native addon locally
npm test               # run tests
```

## Publishing

```sh
# JS-only change (no native code changed):
npm version patch && git push && git push --tags
npm publish

# Native code changed — rebuild platform packages:
npm version patch && git push && git push --tags
gh run watch                    # wait for CI
rm -rf artifacts
gh run download --dir artifacts \
  -n mic-darwin-arm64 -n mic-darwin-x64 \
  -n mic-linux-x64 -n mic-linux-arm64 -n mic-win32-x64

# (fallback) If darwin-x64 CI is unavailable, cross-compile locally:
npx node-gyp@latest rebuild --arch=x64
mkdir -p artifacts/mic-darwin-x64
cp build/Release/mic.node artifacts/mic-darwin-x64/

for pkg in packages/mic-*/; do
  cp artifacts/$(basename $pkg)/mic.node $pkg/
  (cd $pkg && npm publish)
done
npm publish
```

## License

MIT

<a href="https://github.com/krishnized/license/">ॐ</a>
