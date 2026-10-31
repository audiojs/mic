/*
 * Recording to disk: the device's frames, as it gives them (its own rate, float, every channel), into a ring the
 * audio thread fills; a thread of its own takes them from there into WAV files, so nothing the JS side does (a held
 * event loop, a crash, a kill) reaches the take. Several files from one device at once, each its own inputs, start
 * on the same sample: tracks of one take.
 *
 * Safe on disk as it goes: the audio is written as it comes (the system holds it through a killed process); every
 * second the header is made to tell the length so far and the file is flushed to the disk itself (F_FULLFSYNC on
 * macOS, where fsync stops at the drive's cache). A take cut short reads to its last second; recover() reads the rest.
 * A JUNK chunk keeps room for ds64, so past 4 GB the header turns RF64 in place (EBU Tech 3306).
 *
 * Nothing is lost quietly: frames the ring had no room for are written as silence where they were, so the take keeps
 * time, and counted; a device that stops (unplugged) ends the take, written to its last frame, with EDEVICELOST; time
 * without frames from the device reads as `stalled`.
 *
 * What is written can be heard too, as it is written: read() hands JS the take's audio (the first file's channels, or
 * every channel with no file) from a ring of its own, 2 s, for a page to draw it or play it back. A reader that falls
 * behind misses audio there (counted, `missed`), never in the file.
 *
 * Include after miniaudio.h (its implementation: threads, sleep), node_api.h, devices.h and NAPI_CALL.
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <math.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

#define REC_JUNK 28           /* ds64's size: riff, data and sample count (64-bit each) and an empty table */
#define REC_BLOCK 4096        /* frames converted at a time */
#define REC_RING_BYTES (128u << 20)
#define REC_CLIP 0.99997f     /* within one 16-bit step of full scale */

typedef struct {
  int fd;
  char* path;
  ma_uint32 nch;
  ma_uint32* map;            /* the device channel each of the file's channels takes */
  ma_uint64 data;            /* bytes of audio written */
  int rf64;
  int made;                  /* opened here: removed if the take never starts */
} rec_file;

typedef struct rec_t {
  ma_device device;
  ma_pcm_rb rb;
  ma_thread thread;
  ma_mutex lock;             /* what status() reads */
  ma_mutex once;             /* stop runs once, from whichever asks first: stop(), exit, GC */
  ma_uint32 in_ch, rate, bits, bpf;
  ma_uint32 nfiles;
  rec_file* files;
  ma_uint64 rf64_at;         /* the RIFF size past which the header turns RF64 */
  ma_uint32 dropped;         /* frames the ring had no room for (atomic) */
  ma_uint32 stopping;        /* stop asked: the device's stop is ours, not a loss (atomic) */
  ma_uint32 drain;           /* no more frames will come: the writer ends once the ring is empty (atomic) */
  ma_uint32 lost;            /* the device stopped of itself (atomic) */
  ma_uint32 rerouted;        /* the system moved the default input elsewhere (atomic) */
  ma_uint32 rng;
  int stopped, threaded, failed, hooked;
  ma_uint8* out;
  ma_pcm_rb tap;             /* what read() hands JS: the first file's channels, or every channel */
  ma_uint32 tap_ch;
  ma_uint32* tap_map;
  float* tap_buf;
  int tapped;
  /* under lock */
  ma_uint64 frames, silenced, missed;
  ma_uint32 stalled_ms;
  float* peak;               /* per device channel, since the last status */
  ma_uint64* clips;          /* per device channel, all along */
  const char* code;
  char message[256];
  int done;                  /* the writer closed the files */
  napi_env env;
  struct rec_t* next;        /* the takes going, for exit */
} rec_t;

static void put16(ma_uint8* p, ma_uint32 v) { p[0] = v & 255; p[1] = v >> 8 & 255; }
static void put32(ma_uint8* p, ma_uint32 v) { put16(p, v & 0xFFFF); put16(p + 2, v >> 16); }
static void put64(ma_uint8* p, ma_uint64 v) { put32(p, (ma_uint32)v); put32(p + 4, (ma_uint32)(v >> 32)); }

static const char* rec_errno(int e) {
  switch (e) {
    case ENOSPC: return "ENOSPC";
    case EACCES: return "EACCES";
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case EISDIR: return "EISDIR";
    case EROFS:  return "EROFS";
#ifdef EDQUOT
    case EDQUOT: return "EDQUOT";
#endif
    case EFBIG:  return "EFBIG";
    default:     return "EIO";
  }
}

/* the first error is the one told */
static void rec_fail(rec_t* r, const char* code, const char* what, const char* path) {
  ma_mutex_lock(&r->lock);
  if (!r->code) {
    r->code = code;
    snprintf(r->message, sizeof r->message, "%s%s%s", what, path ? ": " : "", path ? path : "");
  }
  ma_mutex_unlock(&r->lock);
}

/* ---- files ---- */

static int rec_fopen(const char* path, int overwrite) {
#ifdef _WIN32
  wchar_t wpath[1024];
  if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, 1024)) { errno = ENOENT; return -1; }
  return _wopen(wpath, _O_WRONLY | _O_CREAT | _O_BINARY | (overwrite ? _O_TRUNC : _O_EXCL), _S_IREAD | _S_IWRITE);
#else
  return open(path, O_WRONLY | O_CREAT | (overwrite ? O_TRUNC : O_EXCL), 0644);
#endif
}

static void rec_close(int fd) {
#ifdef _WIN32
  _close(fd);
#else
  close(fd);
#endif
}

static int rec_write(int fd, const void* buf, size_t n) {
  const ma_uint8* p = (const ma_uint8*)buf;
  while (n) {
#ifdef _WIN32
    int w = _write(fd, p, (unsigned)(n > 0x40000000 ? 0x40000000 : n));
#else
    ssize_t w = write(fd, p, n);
#endif
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    if (w == 0) { errno = ENOSPC; return -1; }
    p += w, n -= (size_t)w;
  }
  return 0;
}

/* at an offset, the file position kept: only the writer thread touches the file */
static int rec_pwrite(int fd, const void* buf, size_t n, ma_int64 at) {
#ifdef _WIN32
  __int64 here = _lseeki64(fd, 0, SEEK_CUR);
  if (here < 0 || _lseeki64(fd, at, SEEK_SET) < 0) return -1;
  int e = rec_write(fd, buf, n);
  return _lseeki64(fd, here, SEEK_SET) < 0 ? -1 : e;
#else
  off_t here = lseek(fd, 0, SEEK_CUR);
  if (here < 0 || lseek(fd, (off_t)at, SEEK_SET) < 0) return -1;
  int e = rec_write(fd, buf, n);
  return lseek(fd, here, SEEK_SET) < 0 ? -1 : e;
#endif
}

/* to the disk itself, not its cache */
static int rec_flush(int fd) {
#ifdef _WIN32
  return _commit(fd);
#else
#ifdef F_FULLFSYNC
  if (fcntl(fd, F_FULLFSYNC) == 0) return 0;
#endif
  return fsync(fd);
#endif
}

/* fmt as the file holds it: PCM, IEEE float, or WAVE_FORMAT_EXTENSIBLE over two channels (no speaker positions:
 * inputs, not speakers); float has a fact chunk */
static ma_uint32 rec_fmt_size(const rec_t* r, const rec_file* f) { return f->nch > 2 ? 40 : r->bits == 32 ? 18 : 16; }
static ma_uint32 rec_header_size(const rec_t* r, const rec_file* f) {
  return 12 + 8 + REC_JUNK + 8 + rec_fmt_size(r, f) + (r->bits == 32 ? 12 : 0) + 8;
}

/* the header as the file stands: `pad`, the byte an odd data chunk ends with, once it is final */
static ma_uint32 rec_header(const rec_t* r, rec_file* f, ma_uint8* h, int pad) {
  ma_uint32 hs = rec_header_size(r, f), fs = rec_fmt_size(r, f), bps = r->bits / 8, block = f->nch * bps;
  ma_uint64 riff = (ma_uint64)hs - 8 + f->data + (pad ? f->data & 1 : 0);
  ma_uint64 samples = f->data / block;
  if (riff > r->rf64_at) f->rf64 = 1;
  memset(h, 0, hs);
  memcpy(h, f->rf64 ? "RF64" : "RIFF", 4);
  put32(h + 4, f->rf64 ? 0xFFFFFFFF : (ma_uint32)riff);
  memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, f->rf64 ? "ds64" : "JUNK", 4);
  put32(h + 16, REC_JUNK);
  if (f->rf64) put64(h + 20, riff), put64(h + 28, f->data), put64(h + 36, samples);
  ma_uint8* p = h + 20 + REC_JUNK;
  memcpy(p, "fmt ", 4);
  put32(p + 4, fs);
  put16(p + 8, f->nch > 2 ? 0xFFFE : r->bits == 32 ? 3 : 1);
  put16(p + 10, f->nch);
  put32(p + 12, r->rate);
  put32(p + 16, r->rate * block);
  put16(p + 20, block);
  put16(p + 22, r->bits);
  if (fs >= 18) put16(p + 24, fs - 18);
  if (fs == 40) {
    put16(p + 26, r->bits);
    put32(p + 28, 0);
    put32(p + 32, r->bits == 32 ? 3 : 1);   /* KSDATAFORMAT_SUBTYPE_IEEE_FLOAT / _PCM: {0000000X-0000-0010-8000-00AA00389B71} */
    static const ma_uint8 guid[12] = { 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 };
    memcpy(p + 36, guid, 12);
  }
  p += 8 + fs;
  if (r->bits == 32) {
    memcpy(p, "fact", 4);
    put32(p + 4, 4);
    put32(p + 8, f->rf64 ? 0xFFFFFFFF : (ma_uint32)samples);
    p += 12;
  }
  memcpy(p, "data", 4);
  put32(p + 4, f->rf64 ? 0xFFFFFFFF : (ma_uint32)f->data);
  return hs;
}

/* every file's header to its length so far, and to the disk */
static void rec_sync(rec_t* r, int final) {
  ma_uint8 h[128];
  for (ma_uint32 i = 0; i < r->nfiles; i++) {
    rec_file* f = &r->files[i];
    if (f->fd < 0) continue;
    if (final && (f->data & 1)) { ma_uint8 z = 0; rec_write(f->fd, &z, 1); }
    ma_uint32 n = rec_header(r, f, h, final);
    if (rec_pwrite(f->fd, h, n, 0) < 0 || rec_flush(f->fd) < 0) {
      int e = errno;
      if (!r->failed) rec_fail(r, rec_errno(e), strerror(e), f->path);
      r->failed = 1;
    }
  }
}

/* ---- the writer ---- */

static float rec_dither(rec_t* r) {
  /* TPDF, ±1 step: the difference of two uniform draws (xorshift32) */
  ma_uint32 x = r->rng;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  float a = (float)(x >> 8) / 16777216.0f;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  r->rng = x;
  return a - (float)(x >> 8) / 16777216.0f;
}

/* n frames (n ≤ REC_BLOCK) of the device's float, null for silence, to every file */
/* n frames (silence for null) to the ring read() reads; past its room, missed */
static void rec_tap(rec_t* r, const float* in, ma_uint32 n) {
  if (!r->tapped) return;
  for (ma_uint32 i = 0; i < n; i++)
    for (ma_uint32 c = 0; c < r->tap_ch; c++) r->tap_buf[(size_t)i * r->tap_ch + c] = in ? in[(size_t)i * r->in_ch + r->tap_map[c]] : 0.0f;
  ma_uint32 done = 0;
  while (done < n) {
    ma_uint32 k = n - done;
    void* buf;
    if (ma_pcm_rb_acquire_write(&r->tap, &k, &buf) != MA_SUCCESS || !k) break;
    memcpy(buf, r->tap_buf + (size_t)done * r->tap_ch, (size_t)k * r->tap_ch * sizeof(float));
    ma_pcm_rb_commit_write(&r->tap, k);
    done += k;
  }
  if (done < n) { ma_mutex_lock(&r->lock); r->missed += n - done; ma_mutex_unlock(&r->lock); }
}

static void rec_put(rec_t* r, const float* in, ma_uint32 n) {
  rec_tap(r, in, n);
  if (in) {
    ma_mutex_lock(&r->lock);
    for (ma_uint32 c = 0; c < r->in_ch; c++) {
      float pk = r->peak[c];
      ma_uint64 clips = 0;
      for (ma_uint32 i = 0; i < n; i++) {
        float v = fabsf(in[i * r->in_ch + c]);
        if (v > pk) pk = v;
        if (v >= REC_CLIP) clips++;
      }
      r->peak[c] = pk, r->clips[c] += clips;
    }
    ma_mutex_unlock(&r->lock);
  }
  if (r->failed) return;
  ma_uint32 bps = r->bits / 8;
  for (ma_uint32 k = 0; k < r->nfiles; k++) {
    rec_file* f = &r->files[k];
    ma_uint8* o = r->out;
    for (ma_uint32 i = 0; i < n; i++)
      for (ma_uint32 c = 0; c < f->nch; c++) {
        float v = in ? in[i * r->in_ch + f->map[c]] : 0.0f;
        if (bps == 4) { memcpy(o, &v, 4); o += 4; continue; }
        double s = bps == 2 ? v * 32768.0 + (in ? rec_dither(r) : 0) : v * 8388608.0;
        double lo = bps == 2 ? -32768.0 : -8388608.0, hi = -lo - 1;
        ma_int32 q = (ma_int32)floor((s < lo ? lo : s > hi ? hi : s) + 0.5);
        o[0] = q & 255, o[1] = q >> 8 & 255;
        if (bps == 3) o[2] = q >> 16 & 255;
        o += bps;
      }
    size_t len = (size_t)(o - r->out);
    if (rec_write(f->fd, r->out, len) < 0) {
      int e = errno;
      rec_fail(r, rec_errno(e), strerror(e), f->path);
      r->failed = 1;
      rec_sync(r, 0);  /* the header to what is there */
      return;
    }
    f->data += len;
  }
  ma_mutex_lock(&r->lock);
  r->frames += n;
  if (!in) r->silenced += n;
  ma_mutex_unlock(&r->lock);
}

static ma_thread_result MA_THREADCALL rec_writer(void* data) {
  rec_t* r = (rec_t*)data;
  ma_uint64 unsynced = 0;
  for (;;) {
    ma_uint32 drain = ma_atomic_load_32(&r->drain);   /* before the ring: once set, nothing more is written to it */
    ma_uint32 n = ma_pcm_rb_available_read(&r->rb);
    if (!n) {
      if (drain) break;
      ma_sleep(5);
      ma_mutex_lock(&r->lock); r->stalled_ms += 5; ma_mutex_unlock(&r->lock);
      continue;
    }
    ma_mutex_lock(&r->lock); r->stalled_ms = 0; ma_mutex_unlock(&r->lock);
    /* exactly what was there (the ring may wrap: two runs), then the frames lost after it, as silence */
    while (n) {
      ma_uint32 k = n < REC_BLOCK ? n : REC_BLOCK;
      void* buf;
      if (ma_pcm_rb_acquire_read(&r->rb, &k, &buf) != MA_SUCCESS || !k) break;
      rec_put(r, (const float*)buf, k);
      ma_pcm_rb_commit_read(&r->rb, k);
      n -= k, unsynced += k;
    }
    for (ma_uint32 d = ma_atomic_exchange_32(&r->dropped, 0); d; ) {
      ma_uint32 k = d < REC_BLOCK ? d : REC_BLOCK;
      rec_put(r, NULL, k);
      d -= k, unsynced += k;
    }
    if (unsynced >= r->rate && !r->failed) rec_sync(r, 0), unsynced = 0;
  }
  if (!r->failed) rec_sync(r, 1);
  for (ma_uint32 i = 0; i < r->nfiles; i++) if (r->files[i].fd >= 0) rec_close(r->files[i].fd), r->files[i].fd = -1;
  if (ma_atomic_load_32(&r->lost)) rec_fail(r, "EDEVICELOST", "the input device stopped (unplugged?); the take is written to its last frame", NULL);
  ma_mutex_lock(&r->lock); r->done = 1; ma_mutex_unlock(&r->lock);
  return (ma_thread_result)0;
}

/* ---- the device ---- */

static void rec_callback(ma_device* device, void* output, const void* input, ma_uint32 count) {
  rec_t* r = (rec_t*)device->pUserData;
  ma_uint32 done = 0;
  while (done < count) {
    ma_uint32 k = count - done;
    void* buf;
    if (ma_pcm_rb_acquire_write(&r->rb, &k, &buf) != MA_SUCCESS || !k) break;
    memcpy(buf, (const float*)input + (size_t)done * r->in_ch, (size_t)k * r->bpf);
    ma_pcm_rb_commit_write(&r->rb, k);
    done += k;
  }
  if (done < count) ma_atomic_fetch_add_32(&r->dropped, count - done);
  (void)output;
}

static void rec_notify(const ma_device_notification* n) {
  rec_t* r = (rec_t*)n->pDevice->pUserData;
  if (n->type == ma_device_notification_type_stopped && !ma_atomic_load_32(&r->stopping)) {
    ma_atomic_store_32(&r->lost, 1);
    ma_atomic_store_32(&r->drain, 1);
  }
  else if (n->type == ma_device_notification_type_rerouted) ma_atomic_fetch_add_32(&r->rerouted, 1);
}

/* the device stopped, the ring written out, the files closed: once, whoever asks */
static void rec_stop_now(rec_t* r) {
  ma_mutex_lock(&r->once);
  if (!r->stopped) {
    r->stopped = 1;
    ma_atomic_store_32(&r->stopping, 1);
    ma_device_stop(&r->device);
    ma_atomic_store_32(&r->drain, 1);
    if (r->threaded) ma_thread_wait(&r->thread);
    ma_device_uninit(&r->device);
  }
  ma_mutex_unlock(&r->once);
}

/* the takes going: process.exit() runs no environment cleanup hooks, but it does run exit(), so atexit closes them */
static rec_t* rec_live;
static ma_mutex rec_live_lock;
static int rec_live_ready;

static void rec_atexit(void) {
  ma_mutex_lock(&rec_live_lock);
  for (rec_t* r = rec_live; r; r = r->next) rec_stop_now(r);
  ma_mutex_unlock(&rec_live_lock);
}

static void rec_live_add(rec_t* r) {
  if (!rec_live_ready) rec_live_ready = 1, ma_mutex_init(&rec_live_lock), atexit(rec_atexit);
  ma_mutex_lock(&rec_live_lock);
  r->next = rec_live, rec_live = r;
  ma_mutex_unlock(&rec_live_lock);
}

static void rec_live_remove(rec_t* r) {
  if (!rec_live_ready) return;
  ma_mutex_lock(&rec_live_lock);
  for (rec_t** p = &rec_live; *p; p = &(*p)->next) if (*p == r) { *p = r->next; break; }
  ma_mutex_unlock(&rec_live_lock);
}

static void rec_free(rec_t* r) {
  rec_live_remove(r);
  for (ma_uint32 i = 0; i < r->nfiles; i++) free(r->files[i].map), free(r->files[i].path);
  free(r->files), free(r->peak), free(r->clips), free(r->out);
  ma_pcm_rb_uninit(&r->rb);
  if (r->tapped) ma_pcm_rb_uninit(&r->tap);
  free(r->tap_map), free(r->tap_buf);
  ma_mutex_uninit(&r->lock), ma_mutex_uninit(&r->once);
  free(r);
}

/* the environment ends (a worker's, the process's at its natural end) with the take still going: written out first */
static void rec_cleanup(void* data) { rec_t* r = (rec_t*)data; r->hooked = 0; rec_stop_now(r); }

static void rec_finalize(napi_env env, void* data, void* hint) {
  rec_t* r = (rec_t*)data;
  rec_stop_now(r);
  if (r->hooked) napi_remove_env_cleanup_hook(env, rec_cleanup, r);
  rec_free(r);
  (void)hint;
}

/* ---- JS ---- */

static napi_value rec_throw(napi_env env, const char* code, const char* msg) {
  napi_throw_error(env, code, msg);
  return NULL;
}

static napi_value rec_set_num(napi_env env, napi_value obj, const char* key, double v) {
  napi_value x;
  napi_create_double(env, v, &x);
  napi_set_named_property(env, obj, key, x);
  return obj;
}

/* record(files: [{ path, channels: [0-based device channels] | null }], device, sampleRate, bitDepth, ringSeconds,
 *        overwrite, rf64At) → external; files open and the device runs before it returns, or it throws. No files: the
 *        device's levels alone, an input watched before anything is recorded from it */
static napi_value rec_open(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value argv[7];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 7) return rec_throw(env, NULL, "record(files, device, sampleRate, bitDepth, ringSeconds, overwrite, rf64At)");

  ma_uint32 rate, bits, nfiles;
  double ring_s, rf64_at;
  bool overwrite;
  NAPI_CALL(env, napi_get_array_length(env, argv[0], &nfiles));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[2], &rate));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[3], &bits));
  NAPI_CALL(env, napi_get_value_double(env, argv[4], &ring_s));
  NAPI_CALL(env, napi_get_value_bool(env, argv[5], &overwrite));
  NAPI_CALL(env, napi_get_value_double(env, argv[6], &rf64_at));
  if (bits != 16 && bits != 24 && bits != 32) return rec_throw(env, "EINVAL", "bitDepth: 16, 24 or 32 (float)");

  ma_device_id id;
  int chosen = device_arg(env, argc, argv, 1, ma_device_type_capture, &id);
  if (chosen < 0) return NULL;

  rec_t* r = (rec_t*)calloc(1, sizeof(rec_t));
  if (!r) return rec_throw(env, NULL, "record: out of memory");
  ma_mutex_init(&r->lock);
  ma_mutex_init(&r->once);
  r->env = env;
  r->bits = bits;
  r->rng = 0x9E3779B9u;
  r->rf64_at = rf64_at > 0 ? (ma_uint64)rf64_at : 0xFFFFFFFFull;
  r->stopped = 1;  /* nothing to stop until there is a device */

  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.format = ma_format_f32;   /* what Core Audio and WASAPI give: nothing converted */
  config.capture.channels = 0;             /* every channel the device has */
  if (chosen) config.capture.pDeviceID = &id;
  config.sampleRate = rate;                /* 0: the device's own */
  config.coreaudio.allowNominalSampleRateChange = rate != 0;   /* a rate asked for: the device switches, not a resampler */
  config.dataCallback = rec_callback;
  config.notificationCallback = rec_notify;
  config.pUserData = r;
  config.performanceProfile = ma_performance_profile_conservative;   /* nobody listens: larger periods, fewer chances to miss one */
  if (ma_device_init(NULL, &config, &r->device) != MA_SUCCESS) { rec_free(r); return rec_throw(env, "EDEVICE", "record: the input device would not open"); }
  r->stopped = 0;
  r->in_ch = r->device.capture.channels;
  r->rate = r->device.sampleRate;
  r->bpf = r->in_ch * sizeof(float);

  const char* err_code = NULL;
  char err[600] = "";
  r->files = (rec_file*)calloc(nfiles, sizeof(rec_file));
  r->nfiles = nfiles;
  for (ma_uint32 i = 0; i < nfiles; i++) r->files[i].fd = -1;
  for (ma_uint32 i = 0; i < nfiles && !err_code; i++) {
    napi_value item, v;
    napi_get_element(env, argv[0], i, &item);
    napi_get_named_property(env, item, "path", &v);
    size_t len;
    napi_get_value_string_utf8(env, v, NULL, 0, &len);
    r->files[i].path = (char*)malloc(len + 1);
    napi_get_value_string_utf8(env, v, r->files[i].path, len + 1, &len);
    napi_get_named_property(env, item, "channels", &v);
    bool is_array = false;
    napi_is_array(env, v, &is_array);
    ma_uint32 nch = r->in_ch < 2 ? r->in_ch : 2;   /* none given: the first two, or the one */
    if (is_array) napi_get_array_length(env, v, &nch);
    if (!nch || nch > 0xFFFF) { err_code = "ECHANNEL"; snprintf(err, sizeof err, "record: %s takes no channels", r->files[i].path); break; }
    r->files[i].nch = nch;
    r->files[i].map = (ma_uint32*)malloc(nch * sizeof(ma_uint32));
    for (ma_uint32 c = 0; c < nch; c++) {
      ma_uint32 ch = c;
      if (is_array) { napi_value x; napi_get_element(env, v, c, &x); napi_get_value_uint32(env, x, &ch); }
      if (ch >= r->in_ch) { err_code = "ECHANNEL"; snprintf(err, sizeof err, "record: input %u: %s has %u", ch + 1, r->device.capture.name, r->in_ch); break; }
      r->files[i].map[c] = ch;
    }
  }

  ma_uint32 ring = (ma_uint32)(ring_s * r->rate);
  if (!err_code) {
    if (ring < r->rate / 10) ring = r->rate / 10;
    if ((ma_uint64)ring * r->bpf > REC_RING_BYTES) ring = REC_RING_BYTES / r->bpf;
    r->peak = (float*)calloc(r->in_ch, sizeof(float));
    r->clips = (ma_uint64*)calloc(r->in_ch, sizeof(ma_uint64));
    ma_uint32 widest = 0;
    for (ma_uint32 i = 0; i < nfiles; i++) if (r->files[i].nch > widest) widest = r->files[i].nch;
    r->out = (ma_uint8*)malloc((size_t)REC_BLOCK * (widest ? widest : 1) * 4);   /* no file: the levels alone */
    /* read()'s ring: the first file's channels, or every channel */
    r->tap_ch = nfiles ? r->files[0].nch : r->in_ch;
    r->tap_map = (ma_uint32*)malloc(r->tap_ch * sizeof(ma_uint32));
    r->tap_buf = (float*)malloc((size_t)REC_BLOCK * r->tap_ch * sizeof(float));
    if (r->tap_map) for (ma_uint32 c = 0; c < r->tap_ch; c++) r->tap_map[c] = nfiles ? r->files[0].map[c] : c;
    r->tapped = r->tap_map && r->tap_buf && ma_pcm_rb_init(ma_format_f32, r->tap_ch, r->rate * 2, NULL, NULL, &r->tap) == MA_SUCCESS;
    if (!r->peak || !r->clips || !r->out || ma_pcm_rb_init(ma_format_f32, r->in_ch, ring, NULL, NULL, &r->rb) != MA_SUCCESS)
      err_code = "ENOMEM", snprintf(err, sizeof err, "record: no memory for %u s of %u channels", ring / r->rate, r->in_ch);
  }

  /* every file opened, its header there, before the first frame */
  for (ma_uint32 i = 0; i < nfiles && !err_code; i++) {
    rec_file* f = &r->files[i];
    f->fd = rec_fopen(f->path, overwrite);
    f->made = f->fd >= 0;
    ma_uint8 h[128];
    ma_uint32 n = rec_header(r, f, h, 0);
    if (f->fd < 0 || rec_write(f->fd, h, n) < 0) {
      int e = errno;
      err_code = rec_errno(e);
      snprintf(err, sizeof err, "record: %s: %s", e == EEXIST ? "already there (overwrite: true to write over it)" : strerror(e), f->path);
    }
  }

  if (!err_code) {
    if (ma_thread_create(&r->thread, ma_thread_priority_normal, 0, rec_writer, r, NULL) != MA_SUCCESS) err_code = "EIO", snprintf(err, sizeof err, "record: no thread to write with");
    else r->threaded = 1;
  }
  if (!err_code && ma_device_start(&r->device) != MA_SUCCESS) err_code = "EDEVICE", snprintf(err, sizeof err, "record: %s would not start", r->device.capture.name);
  if (err_code) {
    /* nothing recorded: the device and the writer stopped, the files made here gone */
    rec_stop_now(r);
    for (ma_uint32 i = 0; i < nfiles; i++) {
      if (r->files[i].fd >= 0) rec_close(r->files[i].fd);
      if (r->files[i].made) remove(r->files[i].path);
    }
    rec_free(r);
    return rec_throw(env, err_code, err);
  }

  napi_add_env_cleanup_hook(env, rec_cleanup, r);
  r->hooked = 1;
  rec_live_add(r);
  napi_value external;
  NAPI_CALL(env, napi_create_external(env, r, rec_finalize, NULL, &external));
  return external;
}

/* recordInfo(handle) → { sampleRate, channels, device, deviceRate }: what the device gives (deviceRate, its own rate,
 * differs from sampleRate only where the device would not switch and miniaudio converts) */
static napi_value rec_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], obj, v;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  rec_t* r;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&r));
  napi_create_object(env, &obj);
  rec_set_num(env, obj, "sampleRate", r->rate);
  rec_set_num(env, obj, "channels", r->in_ch);
  rec_set_num(env, obj, "deviceRate", r->device.capture.internalSampleRate);
  napi_create_string_utf8(env, r->device.capture.name, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "device", v);
  return obj;
}

static napi_value rec_status_value(napi_env env, rec_t* r) {
  napi_value obj, peaks, clips, v;
  napi_create_object(env, &obj);
  napi_create_array_with_length(env, r->in_ch, &peaks);
  napi_create_array_with_length(env, r->in_ch, &clips);
  ma_mutex_lock(&r->lock);
  for (ma_uint32 c = 0; c < r->in_ch; c++) {
    napi_create_double(env, r->peak[c], &v); napi_set_element(env, peaks, c, v);
    napi_create_double(env, (double)r->clips[c], &v); napi_set_element(env, clips, c, v);
    r->peak[c] = 0;
  }
  rec_set_num(env, obj, "frames", (double)r->frames);
  rec_set_num(env, obj, "silenced", (double)r->silenced);
  rec_set_num(env, obj, "stalled", r->stalled_ms / 1000.0);
  rec_set_num(env, obj, "rerouted", ma_atomic_load_32(&r->rerouted));
  rec_set_num(env, obj, "missed", (double)r->missed);
  napi_get_boolean(env, r->done, &v);
  napi_set_named_property(env, obj, "done", v);
  if (r->code) {
    napi_value code, msg, e;
    napi_create_string_utf8(env, r->code, NAPI_AUTO_LENGTH, &code);
    napi_create_string_utf8(env, r->message, NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, code, msg, &e);
    napi_set_named_property(env, obj, "error", e);
  }
  ma_mutex_unlock(&r->lock);
  napi_set_named_property(env, obj, "peaks", peaks);
  napi_set_named_property(env, obj, "clips", clips);
  return obj;
}

/* recordStatus(handle) → { frames, silenced, stalled, rerouted, done, error?, peaks, clips }; peaks since the last call */
static napi_value rec_status(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  rec_t* r;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&r));
  return rec_status_value(env, r);
}

/* recordRead(handle) → Float32Array: the audio written since the last read, interleaved (the first file's channels, or
 * every channel) */
static napi_value rec_read(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], buffer, out;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  rec_t* r;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&r));
  ma_uint32 n = r->tapped ? ma_pcm_rb_available_read(&r->tap) : 0;
  float* data;
  NAPI_CALL(env, napi_create_arraybuffer(env, (size_t)n * r->tap_ch * sizeof(float), (void**)&data, &buffer));
  for (ma_uint32 got = 0; got < n;) {
    ma_uint32 k = n - got;
    void* buf;
    if (ma_pcm_rb_acquire_read(&r->tap, &k, &buf) != MA_SUCCESS || !k) break;
    memcpy(data + (size_t)got * r->tap_ch, buf, (size_t)k * r->tap_ch * sizeof(float));
    ma_pcm_rb_commit_read(&r->tap, k);
    got += k;
  }
  NAPI_CALL(env, napi_create_typedarray(env, napi_float32_array, (size_t)n * r->tap_ch, buffer, 0, &out));
  return out;
}

typedef struct {
  rec_t* r;
  napi_deferred deferred;
  napi_ref keep;   /* the handle lives while it stops */
  napi_async_work work;
} rec_stop_work;

static void rec_stop_execute(napi_env env, void* data) { rec_stop_now(((rec_stop_work*)data)->r); (void)env; }

static void rec_stop_complete(napi_env env, napi_status status, void* data) {
  rec_stop_work* w = (rec_stop_work*)data;
  napi_resolve_deferred(env, w->deferred, rec_status_value(env, w->r));
  napi_delete_reference(env, w->keep);
  napi_delete_async_work(env, w->work);
  free(w);
  (void)status;
}

/* recordStop(handle) → Promise<status>: the device stopped, all it gave written, the files closed */
static napi_value rec_stop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], promise, name;
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  rec_stop_work* w = (rec_stop_work*)calloc(1, sizeof(rec_stop_work));
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&w->r));
  NAPI_CALL(env, napi_create_promise(env, &w->deferred, &promise));
  NAPI_CALL(env, napi_create_reference(env, argv[0], 1, &w->keep));
  NAPI_CALL(env, napi_create_string_utf8(env, "mic_record_stop", NAPI_AUTO_LENGTH, &name));
  NAPI_CALL(env, napi_create_async_work(env, NULL, name, rec_stop_execute, rec_stop_complete, w, &w->work));
  NAPI_CALL(env, napi_queue_async_work(env, w->work));
  return promise;
}
