/*
 * Devices: listing them and finding one by the platform's own id (CoreAudio's UID, WASAPI's endpoint id, the ALSA or
 * PulseAudio name) or by its name. The same file in @audio/mic and @audio/speaker; include after miniaudio.h and
 * node_api.h.
 */

#include <stdio.h>
#include <string.h>

/* A device's id as text: the backend's own string, else its number, else (a DirectSound GUID) its bytes in hex */
static void device_id_text(ma_backend backend, const ma_device_id* id, char* out, size_t n) {
  switch (backend) {
    case ma_backend_coreaudio:  snprintf(out, n, "%s", id->coreaudio); return;
    case ma_backend_alsa:       snprintf(out, n, "%s", id->alsa); return;
    case ma_backend_pulseaudio: snprintf(out, n, "%s", id->pulse); return;
    case ma_backend_sndio:      snprintf(out, n, "%s", id->sndio); return;
    case ma_backend_audio4:     snprintf(out, n, "%s", id->audio4); return;
    case ma_backend_oss:        snprintf(out, n, "%s", id->oss); return;
    case ma_backend_winmm:      snprintf(out, n, "%u", (unsigned)id->winmm); return;
    case ma_backend_jack:       snprintf(out, n, "%d", id->jack); return;
    case ma_backend_aaudio:     snprintf(out, n, "%d", (int)id->aaudio); return;
    case ma_backend_opensl:     snprintf(out, n, "%u", (unsigned)id->opensl); return;
    case ma_backend_null:       snprintf(out, n, "%d", id->nullbackend); return;
    case ma_backend_wasapi: {
      /* UTF-16 to UTF-8 */
      size_t o = 0;
      for (int i = 0; i < 64 && id->wasapi[i] && o + 5 < n; i++) {
        unsigned c = id->wasapi[i];
        if (c >= 0xD800 && c < 0xDC00 && i + 1 < 64 && id->wasapi[i + 1] >= 0xDC00 && id->wasapi[i + 1] < 0xE000)
          c = 0x10000 + ((c - 0xD800) << 10) + (id->wasapi[++i] - 0xDC00);
        if (c < 0x80) out[o++] = (char)c;
        else if (c < 0x800) { out[o++] = (char)(0xC0 | c >> 6); out[o++] = (char)(0x80 | (c & 63)); }
        else if (c < 0x10000) { out[o++] = (char)(0xE0 | c >> 12); out[o++] = (char)(0x80 | (c >> 6 & 63)); out[o++] = (char)(0x80 | (c & 63)); }
        else { out[o++] = (char)(0xF0 | c >> 18); out[o++] = (char)(0x80 | (c >> 12 & 63)); out[o++] = (char)(0x80 | (c >> 6 & 63)); out[o++] = (char)(0x80 | (c & 63)); }
      }
      out[o] = 0;
      return;
    }
    default: {
      const unsigned char* b = (const unsigned char*)id;
      size_t o = 0;
      for (int i = 0; i < 16 && o + 3 <= n; i++) o += snprintf(out + o, n - o, "%02x", b[i]);
      return;
    }
  }
}

/* The devices of one direction (capture or playback) on the default backend */
static ma_result device_list(ma_context* ctx, ma_device_type type, ma_device_info** list, ma_uint32* count) {
  ma_result r = ma_context_init(NULL, 0, NULL, ctx);
  if (r != MA_SUCCESS) return r;
  ma_device_info *play, *cap;
  ma_uint32 np, nc;
  r = ma_context_get_devices(ctx, &play, &np, &cap, &nc);
  if (r != MA_SUCCESS) { ma_context_uninit(ctx); return r; }
  *list = type == ma_device_type_capture ? cap : play;
  *count = type == ma_device_type_capture ? nc : np;
  return MA_SUCCESS;
}

/* [{ id, name, default }] */
static napi_value device_array(napi_env env, ma_device_type type) {
  ma_context ctx;
  ma_device_info* list;
  ma_uint32 n;
  if (device_list(&ctx, type, &list, &n) != MA_SUCCESS) {
    napi_throw_error(env, NULL, "Failed to list audio devices");
    return NULL;
  }
  napi_value arr;
  napi_create_array_with_length(env, n, &arr);
  for (ma_uint32 i = 0; i < n; i++) {
    char id[512];
    device_id_text(ctx.backend, &list[i].id, id, sizeof id);
    napi_value obj, v;
    napi_create_object(env, &obj);
    napi_create_string_utf8(env, id, NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, obj, "id", v);
    napi_create_string_utf8(env, list[i].name, NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, obj, "name", v);
    napi_get_boolean(env, list[i].isDefault != 0, &v);
    napi_set_named_property(env, obj, "default", v);
    napi_set_element(env, arr, i, obj);
  }
  ma_context_uninit(&ctx);
  return arr;
}

/* The device whose id text or name is `want`, its id into `out`; 0 when there is none */
static int device_find(ma_device_type type, const char* want, ma_device_id* out) {
  ma_context ctx;
  ma_device_info* list;
  ma_uint32 n;
  if (device_list(&ctx, type, &list, &n) != MA_SUCCESS) return 0;
  int found = 0;
  for (ma_uint32 i = 0; i < n && !found; i++) {
    char id[512];
    device_id_text(ctx.backend, &list[i].id, id, sizeof id);
    if (!strcmp(id, want)) { *out = list[i].id; found = 1; }
  }
  for (ma_uint32 i = 0; i < n && !found; i++)
    if (!strcmp(list[i].name, want)) { *out = list[i].id; found = 1; }
  ma_context_uninit(&ctx);
  return found;
}

/* argv[i], when it is a string, as the device to open: its id into `id`, and 1; 0 for the default; -1 (thrown, code
 * ENODEVICE) when none has that id or name */
static int device_arg(napi_env env, size_t argc, napi_value* argv, size_t i, ma_device_type type, ma_device_id* id) {
  if (argc <= i) return 0;
  napi_valuetype t;
  napi_typeof(env, argv[i], &t);
  if (t != napi_string) return 0;
  char want[512];
  size_t len;
  napi_get_value_string_utf8(env, argv[i], want, sizeof want, &len);
  if (!len) return 0;
  if (device_find(type, want, id)) return 1;
  char msg[600];
  snprintf(msg, sizeof msg, "No audio %s device '%s'", type == ma_device_type_capture ? "input" : "output", want);
  napi_throw_error(env, "ENODEVICE", msg);
  return -1;
}
