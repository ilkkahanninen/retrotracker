/*
 * pt2-render — headless WAV renderer using pt2-clone's replayer.
 *
 * Usage: pt2-render <input.mod> <output.wav> [--rate=N] [--loops=N]
 *
 * Loads a .mod, drives pt2-clone's `tickReplayer` + `outputAudio` exactly
 * the way mod2WavThreadFunc does, and writes a 16-bit stereo PCM WAV.
 * No SDL, no window, no audio device — just deterministic file output.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "pt2_header.h"
#include "pt2_structs.h"
#include "pt2_config.h"
#include "pt2_audio.h"
#include "pt2_paula.h"
#include "pt2_replayer.h"
#include "pt2_module_loader.h"
#include "pt2_downsample2x.h"

#define TICKS_PER_CHUNK 64
#define DEFAULT_RATE 44100
#define DEFAULT_LOOPS 0

extern module_t *song;

static long parse_long_arg(const char *prefix, const char *arg, long fallback) {
    size_t plen = strlen(prefix);
    if (strncmp(arg, prefix, plen) != 0) return fallback;
    return strtol(arg + plen, NULL, 10);
}

typedef struct {
    uint32_t chunkID, chunkSize, format;
    uint32_t subchunk1ID, subchunk1Size;
    uint16_t audioFormat, numChannels;
    uint32_t sampleRate, byteRate;
    uint16_t blockAlign, bitsPerSample;
    uint32_t subchunk2ID, subchunk2Size;
} __attribute__((packed)) wav_header_t;

static void write_wav_header(FILE *f, uint32_t rate, uint32_t numFramesStereo) {
    wav_header_t h;
    h.chunkID = 0x46464952;       // "RIFF"
    h.format = 0x45564157;        // "WAVE"
    h.subchunk1ID = 0x20746D66;   // "fmt "
    h.subchunk1Size = 16;
    h.audioFormat = 1;            // PCM
    h.numChannels = 2;
    h.sampleRate = rate;
    h.bitsPerSample = 16;
    h.byteRate = rate * 2 * 2;    // rate * channels * bytesPerSample
    h.blockAlign = 2 * 2;
    h.subchunk2ID = 0x61746164;   // "data"
    h.subchunk2Size = numFramesStereo * 2 * sizeof(int16_t);
    h.chunkSize = 36 + h.subchunk2Size;
    fwrite(&h, sizeof(h), 1, f);
}

int main(int argc, char *argv[]) {
    const char *inPath = NULL;
    const char *outPath = NULL;
    long rate = DEFAULT_RATE;
    long loops = DEFAULT_LOOPS;

    for (int i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--rate=", 7) == 0) rate = parse_long_arg("--rate=", argv[i], rate);
        else if (strncmp(argv[i], "--loops=", 8) == 0) loops = parse_long_arg("--loops=", argv[i], loops);
        else if (!inPath) inPath = argv[i];
        else if (!outPath) outPath = argv[i];
    }

    if (!inPath || !outPath) {
        fprintf(stderr,
            "Usage: pt2-render <input.mod> <output.wav> [--rate=N] [--loops=N]\n"
            "  --rate=N    output sample rate in Hz (default %d)\n"
            "  --loops=N   number of additional song loops (default %d)\n",
            DEFAULT_RATE, DEFAULT_LOOPS);
        return 2;
    }

    /* Defaults that the replayer / module loader read from `config`. */
    memset(&config, 0, sizeof(config));
    config.maxSampleLength    = 65534;
    config.amigaModel         = 0;        // 0 = A1200, 1 = A500
    config.stereoSeparation   = 20;       // %
    config.soundFrequency     = (uint32_t)rate;
    config.soundBufferSize    = 1024;
    config.audioInputFrequency = 44100;
    config.mod2WavOutputFreq  = (uint32_t)rate;
    config.enableE8xEffect    = false;

    /* Reasonable editor defaults the replayer touches. */
    memset(&editor, 0, sizeof(editor));
    editor.timingMode               = TEMPO_MODE_CIA;
    editor.initialTempo             = 125;
    editor.initialSpeed             = 6;
    editor.mod2WavFadeOut           = false;
    editor.mod2WavFadeOutSeconds    = 0;
    editor.mod2WavNumLoops          = (int8_t)loops;
    editor.songPlaying              = true;
    editor.programRunning           = true;

    /* Reuse pt2_audio.c's setupAudio: it allocates dMixBufferL/R, runs
     * paulaSetup, generates the BPM table, etc. With our SDL shim,
     * SDL_OpenAudioDevice succeeds without opening anything, and the
     * audioCallback is never actually invoked (no SDL_PauseAudioDevice
     * effect). */
    if (!setupAudio()) {
        fprintf(stderr, "setupAudio failed\n");
        return 1;
    }

    /* Allocate the empty song the way pt2_main.c does. */
    song = createEmptyMod();
    if (!song) {
        fprintf(stderr, "createEmptyMod failed\n");
        return 1;
    }

    /* loadModFromArg owns the song-replacement dance: modFree, swap pointers,
     * setupLoadedMod, set song->loaded = true. */
    loadModFromArg((char *)inPath);
    if (!song || !song->loaded) {
        fprintf(stderr, "failed to load module: %s\n", inPath);
        return 1;
    }

    /* Begin rendering. mod2WavOngoing tells the replayer to skip GUI hooks. */
    editor.mod2WavOngoing = true;
    storeTempVariables();
    modSetTempo(song->currBPM, true);
    restartSong();

    FILE *out = fopen(outPath, "wb");
    if (!out) {
        fprintf(stderr, "failed to open output: %s\n", outPath);
        return 1;
    }
    /* Skip the header — we'll fill it in once we know the sample count. */
    fseek(out, sizeof(wav_header_t), SEEK_SET);

    const int32_t paulaRate = audio.oversamplingFlag ? (int32_t)audio.outputRate * 2 : (int32_t)audio.outputRate;
    const int32_t maxSamplesPerTick = (int32_t)((paulaRate / (MIN_BPM / 2.5)) + 1);
    int16_t *buf = malloc((size_t)TICKS_PER_CHUNK * (size_t)maxSamplesPerTick * 2 * sizeof(int16_t));
    if (!buf) {
        fclose(out);
        fprintf(stderr, "out of memory\n");
        return 1;
    }

    uint64_t totalFrames = 0;
    uint64_t fracAccum = 0;
    int8_t loopsLeft = (int8_t)loops;
    bool done = false;

    while (!done) {
        uint32_t framesInChunk = 0;
        int16_t *p = buf;
        for (int i = 0; i < TICKS_PER_CHUNK && !done; i++) {
            if (!tickReplayer()) {
                if (--loopsLeft < 0) {
                    done = true;
                    break;
                }
                memset(editor.rowVisitTable, 0, sizeof(editor.rowVisitTable));
            }
            uint32_t samplesToMix = audio.samplesPerTickInt;
            fracAccum += audio.samplesPerTickFrac;
            if (fracAccum >= BPM_FRAC_SCALE) {
                fracAccum &= BPM_FRAC_MASK;
                samplesToMix++;
            }
            outputAudio(p, (int32_t)samplesToMix);
            p += samplesToMix * 2;
            framesInChunk += samplesToMix;
        }
        if (framesInChunk > 0) {
            fwrite(buf, sizeof(int16_t), (size_t)framesInChunk * 2, out);
            totalFrames += framesInChunk;
        }
    }

    free(buf);

    /* Now write the real WAV header at the start. */
    rewind(out);
    write_wav_header(out, (uint32_t)rate, (uint32_t)totalFrames);
    fclose(out);

    fprintf(stderr, "rendered %llu frames @ %ld Hz -> %s\n",
            (unsigned long long)totalFrames, rate, outPath);
    return 0;
}
