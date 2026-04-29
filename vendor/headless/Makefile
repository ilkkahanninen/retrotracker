# Headless pt2-render build.
# Compiles only the replayer + module loader from pt2-clone, plus our main +
# stubs. No SDL2, no GUI.

PT2_SRC := ../pt2-clone/src
HL_DIR  := .
OUT_DIR := build
BIN_DIR := ../bin

CC := cc
CFLAGS := -O2 -DNDEBUG -DRETROTRACKER_HEADLESS \
          -Wall -Wno-unused-parameter -Wno-unused-variable \
          -Wno-unused-function -Wno-unused-but-set-variable \
          -Wno-incompatible-pointer-types -Wno-pointer-sign \
          -ffast-math \
          -I$(PT2_SRC) -I$(HL_DIR)
LDFLAGS := -lm

# Pulled from pt2-clone (the audio replayer core)
PT2_OBJS := \
  $(OUT_DIR)/pt2_replayer.o \
  $(OUT_DIR)/pt2_audio.o \
  $(OUT_DIR)/pt2_paula.o \
  $(OUT_DIR)/pt2_blep.o \
  $(OUT_DIR)/pt2_downsample2x.o \
  $(OUT_DIR)/pt2_rcfilters.o \
  $(OUT_DIR)/pt2_module_loader.o \
  $(OUT_DIR)/pt2_tables.o \
  $(OUT_DIR)/pt2_helpers.o \
  $(OUT_DIR)/pt2_structs.o \
  $(OUT_DIR)/pt2_config.o \
  $(OUT_DIR)/pt2_unicode.o \
  $(OUT_DIR)/pt2_load_mod15.o \
  $(OUT_DIR)/pt2_load_mod31.o \
  $(OUT_DIR)/pt2_xpk_unpack.o \
  $(OUT_DIR)/pt2_pp_unpack.o

# Our headless adapter
HL_OBJS := \
  $(OUT_DIR)/main.o \
  $(OUT_DIR)/stubs.o

ALL_OBJS := $(PT2_OBJS) $(HL_OBJS)

.PHONY: all clean
all: $(BIN_DIR)/pt2-render

$(BIN_DIR)/pt2-render: $(ALL_OBJS) | $(BIN_DIR)
	$(CC) $(ALL_OBJS) -o $@ $(LDFLAGS)

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

$(OUT_DIR)/%.o: $(PT2_SRC)/%.c | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(OUT_DIR)/%.o: $(PT2_SRC)/modloaders/%.c | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(OUT_DIR)/%.o: $(HL_DIR)/%.c | $(OUT_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -rf $(OUT_DIR) $(BIN_DIR)/pt2-render
