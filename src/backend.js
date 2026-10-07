/**
 * Backend detection — static imports, tries in priority order
 */
let miniaudio, process_, null_

try { miniaudio = await import('./backends/miniaudio.js') } catch {}
try { process_ = await import('./backends/process.js') } catch {}
try { null_ = await import('./backends/null.js') } catch {}

const backends = [
  miniaudio && { name: 'miniaudio', open: miniaudio.open, devices: miniaudio.devices },
  process_ && { name: 'process', open: process_.open, devices: process_.devices },
  null_ && { name: 'null', open: null_.open, devices: null_.devices },
].filter(Boolean)

/** The first backend's inputs that can list them: [{ id, name, default }] */
export function devices(preference) {
  for (const b of preference ? backends.filter(b => b.name === preference) : backends) {
    try { return b.devices() } catch {}
  }
  return []
}

export function open(opts, preference) {
  const order = preference
    ? backends.filter(b => b.name === preference)
    : backends
  let lastErr

  for (const { name, open } of order) {
    try { return { name, device: open(opts) } }
    catch (e) { if (e.code === 'ENODEVICE') throw e; lastErr = e }   // no such device: another backend won't have it
  }

  throw new Error(
    'No audio backend available. Install @audio/mic-* for your platform or run npm run build.' +
    (lastErr ? ` Last error: ${lastErr.message}` : '')
  )
}
