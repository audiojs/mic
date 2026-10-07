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
  // bufferSize: 50,       // ring buffer ms (default 50)
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

### Devices

```js
import mic, { devices } from '@audio/mic'

await devices()
// [{ id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', default: true }, …]

let read = mic({ device: 'USB' })   // by id, by name, or by part of its name when only one holds it
```

Ids are the platform's own: CoreAudio's UID, WASAPI's endpoint id, the ALSA or PulseAudio name. A device that isn't there is an error (`code: 'ENODEVICE'`), never another device. In the browser, `devices()` reads `enumerateDevices()` (names show once the page may use the microphone) and `device` becomes the `deviceId` getUserMedia asks for.

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
- `bufferSize` — ring buffer in ms, default `50`
- `device` — an input by id or name (`devices()`), default the system's
- `backend` — force a specific backend

### `read(cb)`

Read PCM data. Callback fires with each captured chunk: `(err, buffer) => {}`.

### `read(null)`

Stop capture. Closes the audio device.

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
