/**
 * Between the device and the reader: what is captured waits here until read, and a read takes all of it at once,
 * so a reader that keeps up on average misses nothing, however long each read takes.
 * Bounded: past `limit` bytes unread, push refuses the block; its owner then stops capture and ends the queue
 * with overflow(). What waits is still read, then that error, then the end. Nothing is dropped silently.
 */
export default function queue(limit = Infinity, join = concat) {
  let held = [], bytes = 0, waiting = [], done = false, error = null

  return { push, end, read }

  // a captured block: to the read waiting for it, else held; false when not taken (ended, or past the limit)
  function push(chunk) {
    if (done) return false
    if (waiting.length) return waiting.shift()(null, chunk), true
    if (bytes + chunk.length > limit) return false
    held.push(chunk), bytes += chunk.length
    return true
  }

  // no more blocks; err, if any, is read after what waits
  function end(err) {
    if (done) return
    done = true, error = err || null
    for (let cb of waiting.splice(0)) settle(cb)
  }

  // all that waits, else the next block as it comes; once ended and drained: the error once, then null
  function read(cb) {
    if (bytes) {
      let out = held.length === 1 ? held[0] : join(held, bytes)
      held = [], bytes = 0
      return cb(null, out)
    }
    if (done) return settle(cb)
    waiting.push(cb)
  }

  function settle(cb) { let e = error; error = null; cb(e, null) }
}

/** The error a read gets once more than `ms` of audio went unread: capture stopped there */
export const overflow = ms => Object.assign(new Error(`mic: reading fell over ${ms} ms behind; capture stopped (backlog)`), { code: 'EOVERFLOW' })

/** read(cb) as an async iterator: a chunk per step, an error thrown, done at the end; leaving the loop stops capture */
export const iterator = read => () => ({
  next: () => new Promise((resolve, reject) => read((err, chunk) => err ? reject(err) : resolve({ done: !chunk, value: chunk || undefined }))),
  return: value => (read(null), Promise.resolve({ done: true, value }))
})

function concat(list, n) {
  let out = new Uint8Array(n), o = 0
  for (let c of list) out.set(c, o), o += c.length
  return out
}
