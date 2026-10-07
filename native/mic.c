/*
 * audio-mic native addon
 * Minimal miniaudio N-API binding: capture device → ring buffer → JS reads
 *
 * Architecture:
 * - Capture callback pushes frames into ring buffer
 * - readSync: non-blocking memcpy from ring buffer (for polling)
 * - readAsync: blocks on worker thread until data available, then fires callback
 * - JS calls readAsync in a loop — callback fires with each captured chunk
 */

#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_GENERATION
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <node_api.h>
#include <string.h>
#include "devices.h"

#define NAPI_CALL(env, call)                                          \
  do {                                                                \
    napi_status status = (call);                                      \
    if (status != napi_ok) {                                          \
      const napi_extended_error_info* error_info = NULL;              \
      napi_get_last_error_info((env), &error_info);                   \
      const char* msg = (error_info && error_info->error_message)     \
        ? error_info->error_message : "Unknown N-API error";          \
      napi_throw_error((env), NULL, msg);                             \
      return NULL;                                                    \
    }                                                                 \
  } while (0)

/* Mic instance */
typedef struct {
  ma_device device;
  ma_pcm_rb ring_buffer;
  ma_uint32 channels;
  ma_uint32 sample_rate;
  ma_format format;
  int started;
  volatile int closed;
} mic_t;

/* Async read work */
typedef struct {
  mic_t* mic;
  void* data;
  size_t byte_length;
  ma_uint32 frames_read;
  napi_async_work work;
  napi_ref callback_ref;
  napi_ref buffer_ref;
} read_work_t;

/* Capture callback — pushes into ring buffer */
static void capture_callback(ma_device* device, void* output, const void* input, ma_uint32 frame_count) {
  mic_t* mic = (mic_t*)device->pUserData;
  ma_uint32 bpf = ma_get_bytes_per_frame(mic->format, mic->channels);

  ma_uint32 total_written = 0;
  while (total_written < frame_count) {
    ma_uint32 to_write = frame_count - total_written;
    void* write_buf;
    if (ma_pcm_rb_acquire_write(&mic->ring_buffer, &to_write, &write_buf) != MA_SUCCESS || to_write == 0) break;
    memcpy(write_buf, (const ma_uint8*)input + total_written * bpf, to_write * bpf);
    ma_pcm_rb_commit_write(&mic->ring_buffer, to_write);
    total_written += to_write;
  }

  (void)output;
}

/* GC destructor */
static void mic_destructor(napi_env env, void* data, void* hint) {
  mic_t* mic = (mic_t*)data;
  if (!mic) return;
  if (!mic->closed) {
    mic->closed = 1;
    if (mic->started) {
      ma_device_stop(&mic->device);
      mic->started = 0;
    }
    ma_device_uninit(&mic->device);
  }
  /* Ring buffer freed here, not in close — avoids race with async worker */
  ma_pcm_rb_uninit(&mic->ring_buffer);
  free(mic);
  (void)env;
  (void)hint;
}

/* mic_open(sampleRate, channels, bitDepth[, bufferMs, device]) → external; device: an id or a name from devices() */
static napi_value mic_open(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 3) {
    napi_throw_error(env, NULL, "mic_open requires (sampleRate, channels, bitDepth[, bufferMs, device])");
    return NULL;
  }

  ma_uint32 sample_rate, channels, bit_depth, buffer_ms;
  NAPI_CALL(env, napi_get_value_uint32(env, argv[0], &sample_rate));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[1], &channels));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[2], &bit_depth));

  buffer_ms = 50;
  if (argc > 3) NAPI_CALL(env, napi_get_value_uint32(env, argv[3], &buffer_ms));
  if (buffer_ms < 10) buffer_ms = 10;
  if (buffer_ms > 2000) buffer_ms = 2000;

  ma_device_id id;
  int chosen = device_arg(env, argc, argv, 4, ma_device_type_capture, &id);
  if (chosen < 0) return NULL;

  ma_format format;
  switch (bit_depth) {
    case 8:  format = ma_format_u8;  break;
    case 16: format = ma_format_s16; break;
    case 24: format = ma_format_s24; break;
    case 32: format = ma_format_f32; break;
    default:
      napi_throw_error(env, NULL, "Unsupported bitDepth (use 8, 16, 24, 32)");
      return NULL;
  }

  mic_t* mic = (mic_t*)calloc(1, sizeof(mic_t));
  if (!mic) {
    napi_throw_error(env, NULL, "Failed to allocate mic");
    return NULL;
  }

  mic->channels = channels;
  mic->sample_rate = sample_rate;
  mic->format = format;

  /* ring buffer — power of 2 sized */
  ma_uint32 rb_frames = (sample_rate * buffer_ms) / 1000;
  ma_uint32 rb_pow2 = 1;
  while (rb_pow2 < rb_frames) rb_pow2 <<= 1;

  ma_result result = ma_pcm_rb_init(format, channels, rb_pow2, NULL, NULL, &mic->ring_buffer);
  if (result != MA_SUCCESS) {
    free(mic);
    napi_throw_error(env, NULL, "Failed to init ring buffer");
    return NULL;
  }

  /* capture device */
  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.format = format;
  config.capture.channels = channels;
  if (chosen) config.capture.pDeviceID = &id;
  config.sampleRate = sample_rate;
  config.dataCallback = capture_callback;
  config.pUserData = mic;
  config.performanceProfile = ma_performance_profile_low_latency;

  result = ma_device_init(NULL, &config, &mic->device);
  if (result != MA_SUCCESS) {
    ma_pcm_rb_uninit(&mic->ring_buffer);
    free(mic);
    napi_throw_error(env, NULL, "Failed to init capture device");
    return NULL;
  }

  /* start capturing immediately */
  result = ma_device_start(&mic->device);
  if (result != MA_SUCCESS) {
    ma_device_uninit(&mic->device);
    ma_pcm_rb_uninit(&mic->ring_buffer);
    free(mic);
    napi_throw_error(env, NULL, "Failed to start capture device");
    return NULL;
  }
  mic->started = 1;

  napi_value external;
  NAPI_CALL(env, napi_create_external(env, mic, mic_destructor, NULL, &external));
  return external;
}

/*
 * mic_readSync(handle, buffer) → framesRead
 * Non-blocking: reads as many frames as available right now.
 */
static napi_value mic_read_sync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  mic_t* mic;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&mic));

  if (mic->closed) {
    napi_value result;
    NAPI_CALL(env, napi_create_int32(env, 0, &result));
    return result;
  }

  void* data;
  size_t byte_length;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[1], &data, &byte_length));

  ma_uint32 bpf = ma_get_bytes_per_frame(mic->format, mic->channels);
  if (bpf == 0) {
    napi_value result;
    NAPI_CALL(env, napi_create_int32(env, 0, &result));
    return result;
  }

  ma_uint32 max_frames = (ma_uint32)(byte_length / bpf);
  ma_uint32 frames_read = 0;

  while (frames_read < max_frames) {
    ma_uint32 to_read = max_frames - frames_read;
    void* read_buf;
    ma_result res = ma_pcm_rb_acquire_read(&mic->ring_buffer, &to_read, &read_buf);
    if (res != MA_SUCCESS || to_read == 0) break;
    memcpy((ma_uint8*)data + frames_read * bpf, read_buf, to_read * bpf);
    ma_pcm_rb_commit_read(&mic->ring_buffer, to_read);
    frames_read += to_read;
  }

  napi_value result;
  NAPI_CALL(env, napi_create_uint32(env, frames_read, &result));
  return result;
}

/* Async read — blocks on worker thread until data available */
static void read_execute(napi_env env, void* data) {
  read_work_t* w = (read_work_t*)data;
  mic_t* mic = w->mic;
  ma_uint32 bpf = ma_get_bytes_per_frame(mic->format, mic->channels);
  if (bpf == 0) { w->frames_read = 0; return; }

  ma_uint32 max_frames = (ma_uint32)(w->byte_length / bpf);
  ma_uint32 frames_read = 0;

  /* Wait until we have data or device is closed.
   * Read whatever is available once data arrives — don't wait to fill the whole buffer.
   * This gives lowest latency: callback fires as soon as any data is captured. */
  while (frames_read == 0 && !mic->closed) {
    ma_uint32 to_read = max_frames - frames_read;
    void* read_buf;
    ma_result res = ma_pcm_rb_acquire_read(&mic->ring_buffer, &to_read, &read_buf);
    if (res == MA_SUCCESS && to_read > 0) {
      memcpy((ma_uint8*)w->data + frames_read * bpf, read_buf, to_read * bpf);
      ma_pcm_rb_commit_read(&mic->ring_buffer, to_read);
      frames_read += to_read;
    } else {
      ma_sleep(1);
    }
  }

  w->frames_read = frames_read;
  (void)env;
}

static void read_complete(napi_env env, napi_status status, void* data) {
  read_work_t* w = (read_work_t*)data;

  napi_value callback, global, argv[2];
  napi_get_reference_value(env, w->callback_ref, &callback);
  napi_get_global(env, &global);

  napi_get_null(env, &argv[0]);
  napi_create_uint32(env, w->frames_read, &argv[1]);
  napi_call_function(env, global, callback, 2, argv, NULL);

  napi_delete_reference(env, w->callback_ref);
  napi_delete_reference(env, w->buffer_ref);
  napi_delete_async_work(env, w->work);
  free(w);
  (void)status;
}

/* mic_readAsync(handle, buffer, callback) */
static napi_value mic_read_async(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  mic_t* mic;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&mic));

  if (mic->closed) {
    napi_throw_error(env, NULL, "Mic is closed");
    return NULL;
  }

  void* data;
  size_t byte_length;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[1], &data, &byte_length));

  read_work_t* w = (read_work_t*)calloc(1, sizeof(read_work_t));
  w->mic = mic;
  w->data = data;
  w->byte_length = byte_length;

  NAPI_CALL(env, napi_create_reference(env, argv[2], 1, &w->callback_ref));
  NAPI_CALL(env, napi_create_reference(env, argv[1], 1, &w->buffer_ref));

  napi_value work_name;
  NAPI_CALL(env, napi_create_string_utf8(env, "mic_read", NAPI_AUTO_LENGTH, &work_name));
  NAPI_CALL(env, napi_create_async_work(env, NULL, work_name, read_execute, read_complete, w, &w->work));
  NAPI_CALL(env, napi_queue_async_work(env, w->work));

  return NULL;
}

/* mic_close(handle) */
static napi_value mic_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  mic_t* mic;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], (void**)&mic));

  if (!mic->closed) {
    mic->closed = 1;
    if (mic->started) {
      ma_device_stop(&mic->device);
      mic->started = 0;
    }
    ma_device_uninit(&mic->device);
    /* Ring buffer freed by GC destructor — worker may still be blocked */
  }

  return NULL;
}

/* devices() → [{ id, name, default }]: the inputs */
static napi_value mic_devices(napi_env env, napi_callback_info info) {
  return device_array(env, ma_device_type_capture);
}

/* Module init */
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "devices",   NULL, mic_devices,    NULL, NULL, NULL, napi_default, NULL },
    { "open",      NULL, mic_open,       NULL, NULL, NULL, napi_default, NULL },
    { "readSync",  NULL, mic_read_sync,  NULL, NULL, NULL, napi_default, NULL },
    { "readAsync", NULL, mic_read_async, NULL, NULL, NULL, napi_default, NULL },
    { "close",     NULL, mic_close,      NULL, NULL, NULL, napi_default, NULL },
  };
  NAPI_CALL(env, napi_define_properties(env, exports, 5, props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
