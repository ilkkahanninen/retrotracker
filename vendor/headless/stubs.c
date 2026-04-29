/*
 * Stubs for pt2-clone's GUI/sampler/scopes/disk-op layer.
 * Kept minimal — only what the replayer + module loader actually call.
 *
 * Many of these are wholesale no-ops; the replayer code path doesn't care
 * whether visual updates happen. The few that observably matter
 * (e.g. clearing pattern undo buffers) are handled where needed instead.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "pt2_header.h"
#include "pt2_structs.h"

/* ───────── stub-friendly globals ─────────────────────────────────────── */
/* `song` is normally defined in pt2_main.c. Provide it here. */
module_t *song = NULL;

/* ───────── stubs ─────────────────────────────────────────────────────── */

/* pt2_visuals.h */
void displayMainScreen(void) {}
void displayErrorMsg(const char *msg) { fprintf(stderr, "[pt2-render] %s\n", msg); }
void displayMsg(const char *msg) { fprintf(stderr, "[pt2-render] %s\n", msg); }
void setMsgPointer(void) {}
void statusAllRight(void) {}
void statusOutOfMemory(void) {}
void setStatusMessage(const char *msg, int32_t carry) { (void)msg; (void)carry; }
void pointerSetMode(int32_t mode, int32_t carry) { (void)mode; (void)carry; }
void pointerSetPreviousMode(void) {}
void pointerErrorMode(void) {}
/* updateWindowTitle is defined by pt2_helpers.c (which we keep) */
void renderTextEditCursor(void) {}
void removeTextEditMarker(void) {}
void exitGetTextLine(int32_t cancel) { (void)cancel; }
void redrawSample(void) {}
void updateCurrSample(void) {}
void updateSongInfo1(void) {}
void updateSongInfo2(void) {}
void displayMainScreen2(void) {}
void editOpScreen(void) {}
void renderAskDialog(void) {}
void removeAskBox(void) {}
void renderClearScreen(void) {}
void displayDiskOpScreen(void) {}
void updatePosEdScrollBar(void) {}
void renderPosEdScreen(void) {}
void updatePosEd(void) {}
void fillToVuMetersBgBuffer(void) {}
void updateMod2WavDialog(void) {}
void drawMod2WavProgressDialog(void) {}
void drawSamplerScreen(void) {}
void redrawSampleData(void) {}
void displaySample(void) {}
void displayCurrentSampleNumber(void) {}
void displayCurrentSampleName(void) {}

/* pt2_textout.h */
void charOut(uint16_t x, uint16_t y, char chr, uint32_t color) { (void)x; (void)y; (void)chr; (void)color; }
void textOut(uint16_t x, uint16_t y, const char *text, uint32_t color) { (void)x; (void)y; (void)text; (void)color; }
void textOut2(uint16_t x, uint16_t y, const char *text) { (void)x; (void)y; (void)text; }
void textOutTight(uint16_t x, uint16_t y, const char *text, uint32_t color) { (void)x; (void)y; (void)text; (void)color; }
void textOutBigBold(uint16_t x, uint16_t y, const char *text, uint32_t color) { (void)x; (void)y; (void)text; (void)color; }
void printTwoDecimalsBig(int32_t x, int32_t y, uint32_t value, uint32_t color) { (void)x; (void)y; (void)value; (void)color; }
void printThreeDecimalsBig(int32_t x, int32_t y, uint32_t value, uint32_t color) { (void)x; (void)y; (void)value; (void)color; }
void printFourDecimalsBig(int32_t x, int32_t y, uint32_t value, uint32_t color) { (void)x; (void)y; (void)value; (void)color; }

/* pt2_mouse.h */
void resetMouseInput(void) {}

/* pt2_scopes.h */
void updateScopes(void) {}
void resetCachedScopePeriod(void) {}
void clearScopes(void) {}

/* pt2_visuals_sync.h */
void resetChSyncQueue(void) {}

/* pt2_posed.h */
void posEdScrollDown(void) {}
void posEdScrollUp(void) {}

/* pt2_sampler.h */
void redrawSampler(void) {}
void exitFromSam(void) {}
void clearSamplerLine(void) {}
void redrawCurrentSampleData(void) {}
void invertRange(void) {}
void killSample(void) {}
void freeAllSampleData(void) {}
bool allocSamplerVars(void) { return true; }
void deAllocSamplerVars(void) {}
void clearSampleSelection(void) {}
void renderSampleData(void) {}
void redrawCurrSampleName(void) {}
void redrawSamplerData(void) {}
void updateSamplePos(void) {}
void fixSampleBeep(void *s) { (void)s; }
void enterSampler(void) {}

/* pt2_sample_loader.h */
bool loadSample(const UNICHAR *fileName, char *entryName) { (void)fileName; (void)entryName; return false; }

/* pt2_module_saver.h */
bool modSave(char *fileName) { (void)fileName; return false; }
bool saveModule(int32_t checkIfFileExist, int32_t giveNewFreeFilename) { (void)checkIfFileExist; (void)giveNewFreeFilename; return false; }

/* pt2_askbox.h */
int32_t askBox(int32_t type, const char *msg) { (void)type; (void)msg; return 1; /* default to "yes" — overwrite */ }

/* pt2_diskop.h */
void diskOpSetInitPath(void) {}

/* pt2_chordmaker.h */
void recalcChordLength(void) {}
void mixChordSample(void) {}

/* pt2_pat2smp.h */
void setupPat2SmpDialog(void) {}

/* pt2_pattern_viewer.h */
void renderPatternData(void) {}

/* pt2_edit.h */
void backupPatternData(void) {}
void restorePatternData(void) {}
void clearPatternBuffer(void) {}

/* pt2_textedit.h */
void exitGetTextLineNoEdit(void) {}
void getTextLineEnd(void) {}

/* pt2_keyboard.h */
void readKeyModifiers(void) {}

/* pt2_visuals_sync.h — periodic visualizer state pushed by replayer */
void setVisualsDataPtr(int32_t ch, const int8_t *data) { (void)ch; (void)data; }
void setVisualsLength(int32_t ch, int32_t length) { (void)ch; (void)length; }
void setVisualsPeriod(int32_t ch, int32_t period) { (void)ch; (void)period; }
void setVisualsVolume(int32_t ch, int32_t volume) { (void)ch; (void)volume; }
void setVisualsDMACON(int32_t ch, int32_t dmacon) { (void)ch; (void)dmacon; }
void setSyncTickTimeLen(uint32_t intLen, uint64_t fracLen) { (void)intLen; (void)fracLen; }

/* pt2_visuals.h — pointer/cursor + mute buttons referenced from replayer */
void pointerSetModeThreadSafe(int32_t mode, int32_t carry) { (void)mode; (void)carry; }
void setErrPointer(void) {}
void updateCursorPos(void) {}
void renderMuteButtons(void) {}
void posEdClearNames(void) {}

/* pt2_config.c references these palette-/sampler-side helpers */
uint32_t analyzerColors[36] = {0};
uint32_t vuMeterColors[48] = {0};
void createSampleMarkTable(void) {}
void changePathToHome(void) {}

/* pt2_module_loader.c calls into the sampler edit history */
void fillSampleRedoBuffer(int32_t sampleNum) { (void)sampleNum; }

/* pt2_audio.c references the latency calc helper from elsewhere */
void calcAudioLatencyVars(uint32_t bufSize, uint32_t rate) { (void)bufSize; (void)rate; }

/* pt2_hpc.h — high-perf clock globals; not used during headless render */
#include "pt2_hpc.h"
hpcFreq_t hpcFreq;

/* showErrorMsgBox is provided by pt2_helpers.c (which we keep). */
