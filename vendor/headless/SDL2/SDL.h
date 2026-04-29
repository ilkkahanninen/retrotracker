/*
 * Minimal SDL2 shim for headless pt2-render builds.
 *
 * pt2-clone's headers and a couple of source files name SDL types and call a
 * narrow set of SDL functions. We never actually run those code paths in
 * headless mode (no audio device, no window), so we just need the symbols to
 * compile and link without pulling in real SDL2.
 *
 * Anything missing here just means: add it. Don't add real behavior.
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

/* SDL primitive type aliases */
typedef uint8_t  Uint8;
typedef int8_t   Sint8;
typedef uint16_t Uint16;
typedef int16_t  Sint16;
typedef uint32_t Uint32;
typedef int32_t  Sint32;
typedef uint64_t Uint64;
typedef int64_t  Sint64;

/* ── opaque forward types for struct fields the replayer/audio never read ── */
typedef int SDL_Scancode;
typedef int SDL_Keycode;
typedef struct SDL_Window SDL_Window;
typedef struct SDL_Renderer SDL_Renderer;
typedef struct SDL_Texture SDL_Texture;
typedef struct SDL_Thread SDL_Thread;
typedef struct SDL_Mutex SDL_mutex;
typedef struct SDL_Surface SDL_Surface;

typedef struct SDL_Rect { int x, y, w, h; } SDL_Rect;
typedef struct SDL_Cursor SDL_Cursor;
typedef uint32_t SDL_AudioDeviceID;

/* ── audio shim — types used by pt2_audio.c ────────────────────────────── */
typedef uint16_t SDL_AudioFormat;
typedef void (*SDL_AudioCallback)(void *userdata, uint8_t *stream, int len);

typedef struct SDL_AudioSpec {
    int freq;
    SDL_AudioFormat format;
    uint8_t channels;
    uint8_t silence;
    uint16_t samples;
    uint16_t padding;
    uint32_t size;
    SDL_AudioCallback callback;
    void *userdata;
} SDL_AudioSpec;

#define AUDIO_F32         0x8120
#define AUDIO_S16         0x8010
#define AUDIO_S32         0x8020
#define SDL_AUDIO_ALLOW_FREQUENCY_CHANGE 0x00000001

/* ── message-box shim ─────────────────────────────────────────────────── */
#define SDL_MESSAGEBOX_ERROR    0x10
#define SDL_MESSAGEBOX_WARNING  0x20

/* ── stub functions: never executed, but must link. ──────────────────── */
static inline SDL_AudioDeviceID SDL_OpenAudioDevice(
    const char *device, int iscapture,
    const SDL_AudioSpec *desired, SDL_AudioSpec *obtained, int allowed_changes)
{
    (void)device; (void)iscapture; (void)allowed_changes;
    /* Pretend we opened a device with the exact requested spec. This lets
     * pt2_audio.c proceed past setupAudio's checks and allocate the mix
     * buffers, which the headless renderer needs. The audioCallback is
     * never invoked because we never actually pause/run an SDL device. */
    if (obtained && desired) *obtained = *desired;
    return 1;
}
static inline void SDL_CloseAudioDevice(SDL_AudioDeviceID dev) { (void)dev; }
static inline void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on) { (void)dev; (void)pause_on; }
static inline void SDL_LockAudioDevice(SDL_AudioDeviceID dev) { (void)dev; }
static inline void SDL_UnlockAudioDevice(SDL_AudioDeviceID dev) { (void)dev; }
static inline const char *SDL_GetError(void) { return "headless build: no SDL"; }
static inline int SDL_ShowSimpleMessageBox(uint32_t flags, const char *title,
                                           const char *message, SDL_Window *window) {
    (void)flags; (void)title; (void)window;
    fprintf(stderr, "[pt2-render] %s\n", message ? message : "");
    return 0;
}
static inline void SDL_SetWindowTitle(SDL_Window *w, const char *title) { (void)w; (void)title; }

/* used by replayer/audio in a few non-execution contexts */
static inline void SDL_Delay(uint32_t ms) { (void)ms; }
static inline uint32_t SDL_GetTicks(void) { return 0; }

/* atomics / threading: pt2 occasionally typedefs these in shared headers */
typedef int SDL_atomic_t;
static inline int SDL_AtomicGet(SDL_atomic_t *a) { return *a; }
static inline void SDL_AtomicSet(SDL_atomic_t *a, int v) { *a = v; }

/* SDL_assert: pt2_helpers.c may use ASSERT() that funnels to SDL */
#ifndef SDL_assert
#define SDL_assert(x) ((void)0)
#endif

#ifdef __cplusplus
}
#endif

#include <stdio.h>  /* for the message-box fallback printf */
