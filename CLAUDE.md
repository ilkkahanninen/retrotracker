# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RetroTracker is a web-based tracker (Solid + Vite + TypeScript) that edits both ProTracker `.mod` (strict 4-channel "M.K.", no xCHN/FLT4/etc.) and FastTracker 2 `.xm` (variable channel count, up to 128 instruments with nested samples, volume column, Gxx..Xxx extended effects). The Paula replayer is the centerpiece on the PT side; the XM path runs through a parallel mixer.

## Commands

```bash
npm run dev              # Vite dev server
npm run dev:env          # dev server with .env loaded (OIDC + DATABASE_URL)
npm run dev:db           # start dev Postgres via docker compose, then dev:env
npm run build            # tsc -b && vite build
npm run typecheck        # tsc -b --noEmit
npm test                 # vitest run (includes accuracy test bed)
npm run test:watch
npm run render -- in.mod out.wav [--seconds=N] [--rate=44100]   # offline render via our replayer

# Local Postgres for the share-link feature (compose.dev.yml)
npm run db:up            # start the dev DB in the background, wait for ready
npm run db:down          # stop without deleting data
npm run db:logs          # tail
npm run db:reset         # nuke the data volume (then `db:up` for a fresh DB)
```

Run a single test file: `npx vitest run tests/render-accuracy.test.ts`. Filter by name: `npx vitest run -t "00-baseline"`.

Tests under `tests/ui/**` run in jsdom (mounting Solid components, simulating keypresses with `@testing-library/user-event`); everything else runs on node. The split is configured in [vitest.config.ts](vitest.config.ts) via `environmentMatchGlobs` — UI test files use the `.test.tsx` extension by convention. Module-level signals (`cursor`, `song`, `transport`, …) persist across tests in the same file, so reset them in `beforeEach`.

Fixture / reference workflow (see [tests/fixtures/README.md](tests/fixtures/README.md)):

```bash
npm run fixtures:generate    # rebuild .mod fixtures from generate.ts (deterministic)
npm run pt2-clone:build      # build vendor/bin/pt2-render (one-time, ~1s, clones pt2-clone)
npm run fixtures:render      # render every .mod → .reference.wav via pt2-render
```

The accuracy test auto-builds `vendor/bin/pt2-render` and any missing `.reference.wav` on first run, so a clean `npm test` works without these scripts. Reference WAVs are gitignored; `.mod` fixtures are committed.

## Architecture

### One Replayer, two drivers

[src/core/audio/replayer.ts](src/core/audio/replayer.ts) is a pure state machine — no DOM, no `AudioContext`, no `sampleRate` global. The same instance powers two consumers:

- **Live playback**: [src/core/audio/worklet.ts](src/core/audio/worklet.ts) (`AudioWorkletProcessor`) runs inside the audio thread. [src/core/audio/engine.ts](src/core/audio/engine.ts) is the main-thread wrapper that registers the worklet and proxies `load`/`play`/`stop` over `port.postMessage`. Vite bundles the worklet via `import workletUrl from './worklet?worker&url'`.
- **Offline render**: [src/core/audio/offlineRender.ts](src/core/audio/offlineRender.ts) loops `replayer.process()` into Float32 buffers in 1024-frame chunks. Used by the test bed and the `render` CLI ([tests/lib/render-cli.ts](tests/lib/render-cli.ts)).

When changing replayer behavior, both paths get it for free. Don't fork mixing logic into the worklet.

### Replayer model

`Replayer.process(left, right, frames, offset)` writes interleaved-by-buffer Float32 samples. Mixing is delegated to [Paula](src/core/audio/paula.ts), which does BLEP synthesis, RC + LED filters, and 2× FIR downsampling. The replayer alternates `mixChunk` (drives Paula) with `advanceTick` (per-tick effects, row advancement, song state). Tick scheduling uses CIA-timer math (`tickHz = 709379 / (floor(1773447/BPM)+1)`) with a fractional-sample accumulator to match pt2-clone's exact timing.

Effect implementation reference is **8bitbubsy/pt2-clone**, not OpenMPT or any other tracker. PT-specific quirks are intentional and bug-for-bug: PatternBreak's decimal-encoded param, period clamp 113..856, sine table sign bit, song-end via `(order, row)` revisit set, vibrato waveform 3 = square, ramp-tremolo's vibratoPos half-check, E5y applied before period lookup, EC0 cuts at tick 0 (via setPeriod → checkMoreEffects path), Fxx tempo deferred 1 tick (CIA reload quirk). See the comment block at the top of [replayer.ts](src/core/audio/replayer.ts) for the current implementation list — only 8xy panning is intentionally a no-op (PT 2.3D ignores it).

### Format modules

[src/core/mod/](src/core/mod/) and [src/core/xm/](src/core/xm/) are independent of the replayer. Each holds its own data model, parser/writer, mutations, and clipboard ops.

- PT: [types.ts](src/core/mod/types.ts) defines `ModSong`/`Pattern`/`Note`/`Sample`. `Note.period` is a Paula period (0 = no note); `sample` is 1-indexed (0 = no sample change). [format.ts](src/core/mod/format.ts) holds `PERIOD_TABLE[finetune][noteIndex]` (16×36 — finetune rows, finetune 8..15 stored as -8..-1), `Effect`/`ExtendedEffect` enums, `PAULA_CLOCK_PAL/NTSC`, and the `empty*()` factories. [parser.ts](src/core/mod/parser.ts) / [writer.ts](src/core/mod/writer.ts) handle strict M.K. parse/write — the parser throws on any other signature.
- XM: [src/core/xm/types.ts](src/core/xm/types.ts) defines `XmSong`/`XmPattern`/`XmNote`/`XmInstrument`/`XmSample`. `XmNote.note` is the 1-based MIDI-style note number (1..96 = C-0..B-7, 97 = key-off, 0 = no note). Variable channel count and per-pattern row count. Instruments hold a list of samples plus a 96-note keyMap.
- [src/state/song.ts](src/state/song.ts) exposes `song` (union `ModSong | XmSong | null`) plus narrowed `pt2Song` / `xm2Song` memos for type-specific call sites. The commit path is split too — `commitEdit` / `commitEditWithWorkbenches` for PT, `commitEditXm` / `commitEditXmWithWorkbenches` for XM.

### Accuracy test bed

[tests/render-accuracy.test.ts](tests/render-accuracy.test.ts) renders every `tests/fixtures/*.mod` at the reference WAV's sample rate, then compares channel-for-channel via [tests/lib/compare.ts](tests/lib/compare.ts) (RMS + peak). Bit-exact match against pt2-clone is not the goal — we tolerate `RMS < 0.005` and `peak < 0.05` for floating-point and BLEP edge-case drift.

The "ground truth" tool is [vendor/bin/pt2-render](vendor/headless/), a headless build of pt2-clone with a custom `main.c` and SDL2 shim — no audio device, no GUI. [vendor/build-pt2-clone.sh](vendor/build-pt2-clone.sh) clones pt2-clone fresh on every run (`git reset --hard origin/HEAD`); local edits to `vendor/pt2-clone/` will be lost.

Each fixture targets exactly one behavior (resampler, filter, vibrato waveform, etc.) — see [tests/fixtures/README.md](tests/fixtures/README.md). Don't pile features into one fixture; add a new one.

### State + shared factories

[src/state/song.ts](src/state/song.ts) holds the loaded `Song` as a Solid signal. The `Song` itself is not deeply reactive — every commit replaces the whole signal value.

The PT and XM tracks share factored-out helpers so most of the editing logic lives once:

- [workbenchStore.ts](src/state/workbenchStore.ts) — `createWorkbenchStore<K, V>()` powers both `sampleWorkbench.ts` (PT, slot keyed by number) and `xmSampleWorkbench.ts` (XM, keyed by `${inst}:${sampleIdx}`).
- [sampleSelectionStore.ts](src/state/sampleSelectionStore.ts) — half-open `{start, end}` signal shared by PT and XM waveform selections (XM indexes by frame, not byte).
- [editPrimitives.ts](src/state/editPrimitives.ts) — `createRangedSignal` factory used by [edit.ts](src/state/edit.ts) (octave / sample / editStep) and [xmEdit.ts](src/state/xmEdit.ts) (octave / instrument / sample-index).
- [cursorPrimitives.ts](src/state/cursorPrimitives.ts) — `moveAlongFields` + `cycleChannel`, shared by both cursors' left/right/tab primitives. Row movement stays format-specific (PT walks `flattenSong` for Dxx-aware cross-order traversal; XM walks per-pattern row counts).
- [orderEditCore.ts](src/state/orderEditCore.ts) — `createOrderEdit<S>(adapter)` factory for jump/insert/delete/step ops. Both [orderEdit.ts](src/state/orderEdit.ts) and [xmOrderEdit.ts](src/state/xmOrderEdit.ts) instantiate it. PT's `cleanupOrderList` (patternNames remap) stays format-specific.
- [patternEditCore.ts](src/state/patternEditCore.ts) — `createPatternEdit<S, C, Cell>(adapter)` covers applyCursor / extendSelection / step helpers / selectAllStep / clipboard ops (copy/cut/paste/transpose) / backspace / insertEmpty / clearAtCursor / repeatLastEffect. Format-specific note entry, hex entry, XM-only effect-letter / key-off / row-count / channel-count handlers stay in [patternEdit.ts](src/state/patternEdit.ts) / [xmPatternEdit.ts](src/state/xmPatternEdit.ts).
- [samplePipeline.ts](src/state/samplePipeline.ts) — `makePipelineActions<W>(host)` handles addEffect / removeEffect / moveEffect / patchEffect / setEffectBypass plus the four envelope-point handlers. Format-specific persistence (slot addressing, source-kind toggles, applyChainToSource loop-pin) stays in [sampleEdit.ts](src/state/sampleEdit.ts) / [xmSampleEdit.ts](src/state/xmSampleEdit.ts).
- [keybindHelpers.ts](src/state/keybindHelpers.ts) — `PIANO_KEYS`, `HEX_KEYS`, `DIGIT_QUICK_PICK` tables shared by both registration files. The registration files themselves stay separate (PT defaults; XM gates on `isFt2Mode`).

When extending behavior: most operations belong in the core factories; only format-specific quirks (PT period clamp, XM volume column nibbles, XM extended effect codes G..X, etc.) go in the per-format file.

### Views

The app has four top-level views — `'pattern'`, `'sample'`, `'info'`, `'settings'` — driven by the `view` signal in [src/state/view.ts](src/state/view.ts). They occupy the same `<main>` slot; the layout's `grid-template-columns` flips between 3 columns (samples / main / order) for `pattern`, 2 (samples / main) for `sample`, and main-only for `info` / `settings` via the `.app--view-*` class on the root. The sample list pane is shared across pattern and sample views; `currentSample()` from [src/state/edit.ts](src/state/edit.ts) is what both the pattern grid and the sample editor read. All four panes stay mounted at all times — toggling the view just flips a `view-hidden` class.

Sample editing has its own mutations (`setSample`, `clearSample`, `replaceSampleData` in [src/core/mod/mutations.ts](src/core/mod/mutations.ts)) and an importer ([src/core/mod/sampleImport.ts](src/core/mod/sampleImport.ts)) that converts a parsed WAV into 8-bit signed mono. The WAV reader/writer lives at [src/core/audio/wav.ts](src/core/audio/wav.ts) and is shared between the runtime importer and the offline-render test bed.

### Sample pipeline

The sample editor wraps each loaded WAV in a [SampleWorkbench](src/core/audio/sampleWorkbench.ts) (PT) or [XmSampleWorkbench](src/core/audio/sampleWorkbench.ts) (XM): a source `WavData` plus an editable list of pure `WavData → WavData` effect nodes (gain, normalize, reverse, crop, fade in/out) terminated by a format-specific transformer (PT: mono mix + int8 quantise; XM: mono mix + 8/16-bit quantise). Workbenches are **session-only** (cleared on `.mod` / `.xm` load, never serialised back into those formats). Whenever a workbench changes, the format-specific update path re-runs the pipeline and pushes the resulting sample bytes into the slot. Playback never sees the workbench — it reads the int8 / int16 result like any other sample. Sampler sources (the input WAV bytes) and chiptune params persist via `.retro` so a project round-trips with its full pipeline; the chain itself does too.

Chain + envelope mutations go through the shared `makePipelineActions<W>` factory (see _State + shared factories_ above); only format-specific persistence (source-kind toggles, loop policy, slot addressing) lives in the per-format file.

### Optional backend

The app is a static SPA by default. An optional Node backend at [server/](server/) (Hono) exposes `/api/{projects,samples,modules}` for listing / GET / PUT / DELETE of `.retro` projects, `.wav` samples, and `.mod` / `.xm` modules — names may include slashes for subdirectories; [server/storage.ts](server/storage.ts) rejects `..`, dotfiles, wrong extensions, and resolves paths under the configured root.

Wiring:

- **Dev**: [server/vitePlugin.ts](server/vitePlugin.ts) registers the Hono `fetch` handler as Vite middleware so `npm run dev` runs both on one port. Backend is always on in dev; data lives in `./data/{projects,samples,modules}` (gitignored). Override with `RETROTRACKER_DATA_DIR`.
- **Prod**: [server/index.ts](server/index.ts) is the entry — Node `http` that serves `dist/` (with SPA fallback to `index.html`) and conditionally mounts the API. esbuild bundles it (`npm run build:server`) to `dist-server/index.mjs`. Backend is **off by default** and activates only when `RETROTRACKER_BACKEND=1` is set at runtime, so CI-built images stay inert until an operator opts in. Default data dir is `/`, so volumes mount as `/projects`, `/samples`, `/modules`.
- **Frontend**: [src/state/backend.ts](src/state/backend.ts) pings `/api/health` on boot and flips the `backendAvailable` signal. When set, [App.tsx](src/App.tsx) adds "Open from cloud…" / "Save to cloud…" entries to the File menu (rendered by [ServerBrowser](src/components/ServerBrowser.tsx)). "Open from cloud" lists `.retro` projects and `.mod` / `.xm` modules merged — the user sees one list of songs, not two buckets. Loading routes through `loadServerBytes` → `loadFile` so file-picker, drag-drop, and cloud paths share format sniffing.

#### Optional OIDC auth (per-user namespaces)

Auth is opt-in via five env vars: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_COOKIE_SECRET` (≥ 32 bytes, base64 or UTF-8). All-or-nothing — partial config throws at boot. When unset the backend serves a single shared bucket at the flat `<dataDir>/{projects,samples,modules}` paths (unchanged behavior). When set, every CRUD route requires a signed session cookie (401 otherwise) and storage is namespaced under `<dataDir>/users/<sha256(sub).b64url.slice(0,32)>/{projects,…}` — see [hashUserId](server/storage.ts) and [userScope](server/storage.ts).

- **Provider**: Logto Cloud (free tier) is the recommended target; the code talks pure OIDC (discovery + PKCE auth-code + JWKS-verified ID token) so Authentik / Keycloak / Auth0 all work by swapping env vars.
- **Routes** ([server/auth/routes.ts](server/auth/routes.ts)): `/api/auth/{login,callback,logout,status}`. Login uses PKCE with S256, state + nonce in HttpOnly cookies. Callback verifies state, exchanges code, validates `id_token` against issuer JWKS, then sets a 7-day HMAC-signed session cookie (HS256 via [jose](https://github.com/panva/jose)).
- **No-leak invariant**: when auth is on, every CRUD route runs through `requireUser` and `userScope(cfg, null)` throws — the anonymous flat-path bucket is unreachable from any HTTP path. Files left over from an anonymous-era deploy stay on disk but become invisible to the API; operators migrate manually (`mv data/projects data/users/<hash>/projects`). Verified by a regression test in [tests/server/auth.test.ts](tests/server/auth.test.ts).
- **Frontend** ([src/state/auth.ts](src/state/auth.ts)): `probeBackend()` follows up with `/api/auth/status`; signals `authRequired()` + `currentUser()` drive the File menu. Auth-required + not-signed-in → only **Sign in to cloud…** appears, cloud Open/Save are hidden, and ⌘O / ⌘S fall back to the local pickers.

#### Shareable cloud song links

When `DATABASE_URL` is set on the backend, signed-in users can mint a `/share/<token>` link from any `.retro` / `.mod` / `.xm` they've saved to the cloud. Anyone with the link can open the song (no sign-in required); to keep a copy they sign in and use **Save to cloud…** in their own bucket.

- **Storage**: PostgreSQL via `pg`. Schema lives in [server/db/migrate.ts](server/db/migrate.ts) as a single idempotent `CREATE TABLE IF NOT EXISTS` block (`shares (token, owner_sub, resource, name, created_at)` + a unique index on `(owner_sub, resource, name)` that makes share creation idempotent). [server/db/pool.ts](server/db/pool.ts) is a thin `pg.Pool` wrapper. Migration runs at boot from both [server/index.ts](server/index.ts) and [server/vitePlugin.ts](server/vitePlugin.ts) — refuses to start on connect failure (same posture as `assertSecureIssuer`).
- **Routes** ([server/shareRoutes.ts](server/shareRoutes.ts)): `GET /api/shares/:token` is **public** (no `requireUser`, no origin guard — it's the whole point), returns the file bytes with `Content-Disposition: attachment`. `POST /api/shares`, `GET /api/shares` (list-my-shares), and `DELETE /api/shares/:token` require a session. Auth is enforced per-handler via `requireSession(cfg)` rather than a path-prefix `app.use("/shares", requireUser)` so the public GET can't be accidentally protected by a future mount-order change.
- **Frontend** ([src/state/share.ts](src/state/share.ts), [src/state/shareLoad.ts](src/state/shareLoad.ts), [src/components/ShareModal.tsx](src/components/ShareModal.tsx)): `cloudOrigin` signal in [src/state/session.ts](src/state/session.ts) tracks the bucket+path a song was loaded from / saved to. The **Share this song…** menu item appears when `shareAvailable() && cloudVisibleFor(backendAvailable())` and disables (with tooltip) until `cloudOrigin()` is set. On App mount, `detectAndLoadShareLink()` matches `/^\/share\/([A-Za-z0-9_-]{16,32})$/` against `location.pathname`, strips the URL via `history.replaceState`, fetches the bytes, and tunnels them through `loadServerBytes` — recipients don't inherit the owner's `cloudOrigin`, so they can't accidentally re-share someone else's song without saving their own copy first. A transient banner above the header surfaces the "save a copy to your cloud" CTA. SPA fallback for `/share/<token>` works out of the box in both dev (Vite default) and prod ([server/index.ts](server/index.ts) `pickExisting` falls back to `index.html`).
- **`owner_sub` column** holds the _raw_ OIDC `sub`, not the hash. `userScope(cfg, sub)` re-hashes internally; the row needs the raw value to rebuild the owner's bucket path for the public GET. Treat the column as PII at rest (no worse than an OIDC ID-token cache).
- **Edge cases**: source file deleted by owner → 404 with `shared file no longer exists` (row left in place — a transient FS error wouldn't nuke valid shares; owners revoke explicitly). Auth-off mode rejects POST/DELETE with 401 ("sharing requires sign-in") — the feature is meaningless without per-user identity.
- **Local dev**: [compose.dev.yml](compose.dev.yml) ships a one-command Postgres bound to `127.0.0.1:5432`. `npm run db:up` starts it (named volume `retrotracker-pg-data` persists across restarts); `npm run db:down` stops without data loss; `npm run db:reset` nukes the volume. `.env` carries the matching `DATABASE_URL=postgres://retrotracker:retrotracker@127.0.0.1:5432/retrotracker` so `npm run dev:env` picks it up automatically. The combined `npm run dev:db` brings the DB up (waiting for the healthcheck) then runs the dev server in the foreground — the typical share-feature dev loop.
- **Testing**: [tests/server/shares.test.ts](tests/server/shares.test.ts) + [tests/server/shareRoutes.test.ts](tests/server/shareRoutes.test.ts) gate on `TEST_DATABASE_URL`; when unset both `describe.skip` so CI without PG stays green. Local: reuse the dev DB via `TEST_DATABASE_URL=postgres://retrotracker:retrotracker@127.0.0.1:5432/retrotracker npm test`. Per-test schema isolation lives in [tests/server/dbHarness.ts](tests/server/dbHarness.ts) (`CREATE SCHEMA rt_test_<rand>` + pinned `search_path` + `migrate` per test, `DROP SCHEMA … CASCADE` in `afterEach`) so the dev DB and the test runs never collide. Don't introduce an in-memory `ShareStore` abstraction — the bugs that matter (unique-constraint races, parameter escaping) only show up against real PG.
- **Known limitations**: a song opened from a share link is lost if the viewer then signs in (full-page OIDC redirect). The CTA copy nudges users to sign in _before_ opening shares. No file-rename API today; if/when one is added, it must `UPDATE shares SET name = $new WHERE owner_sub = $1 AND resource = $2 AND name = $old`. No account-deletion flow; a future `DELETE` of a user must also `DELETE FROM shares WHERE owner_sub = $1`.

#### Security hardening

The backend was audited; concrete defenses ship in the server code:

- **Per-resource body caps** ([server/app.ts](server/app.ts), `SIZE_LIMITS`): PUT bodies capped at 50 MB / 50 MB / 5 MB for projects / samples / modules respectively. Checked upfront via `Content-Length` and again post-buffer.
- **Per-user disk quota** (`RETROTRACKER_USER_QUOTA_MB`, default 100): enforced on PUT when auth is on; overwriting refunds the existing file's bytes. Anonymous mode shares one bucket so no quota.
- **Origin guard** ([server/app.ts](server/app.ts), `originGuard`): PUT/DELETE/POST require an `Origin` header matching `OIDC_REDIRECT_URI`'s origin when auth is configured (defence-in-depth on top of `SameSite=Lax`).
- **Session revocation** ([server/auth/middleware.ts](server/auth/middleware.ts)): logout writes a per-user `.session-floor` dotfile; JWTs whose `iat` is at-or-below the floor are rejected. 5-second grace window covers the same-second logout/login race. Per-user — one user's logout doesn't affect others.
- **HTTPS-only issuer** ([server/config.ts](server/config.ts), `assertSecureIssuer`): refuses to start when `OIDC_ISSUER` isn't `https://`, except for `localhost`.
- **Sanitised errors**: 500s return `{error: "internal", message: "internal error"}` with the real error logged server-side; token-exchange failures get `"sign-in failed"`. Stops `EACCES` paths and IdP response bodies from leaking to clients.
- **Cache headers**: every `/api/*` response carries `Cache-Control: private, no-store` + `Vary: Cookie` + `X-Content-Type-Options: nosniff` so a CDN/proxy can't cross-serve auth-scoped data.
- **Static-serve CSP** ([server/index.ts](server/index.ts), `applySecurityHeaders`): `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a CSP allowing `self` + `'wasm-unsafe-eval'` + `blob:` for the AudioWorklet / sample preview. **Adjust `img-src` if you add a remote avatar host** (Logto profile pictures aren't rendered today; if you wire them up, add the picture host to `img-src`).
- **List walk caps** ([server/storage.ts](server/storage.ts)): recursive listing halts at depth 8 or 10000 entries; sets `truncated: true` in the response. Symlinks are silently skipped — we never write them via the API but a co-process or operator could.
- **Atomic writes**: `writeFile` writes to `<path>.<rand>.tmp` then `rename`s — POSIX-atomic, so concurrent PUTs to the same name resolve cleanly and a crash mid-write can't leave a half-truncated target.
- **Rate limiting** ([server/rateLimit.ts](server/rateLimit.ts)): per-IP token bucket on `/api/auth/{login,callback,logout}` (20 burst / ~10/min sustained). Also on `POST /api/shares` (same envelope) and `GET /api/shares/:token` (60 burst / 1-per-sec sustained — a viral share legitimately fans out across many IPs but no single IP should hot-loop the file). In-memory state, scoped per single-node deploy.
- **Audit log** ([server/audit.ts](server/audit.ts)): structured single-line JSON under the `[audit]` prefix for login start/success/failure, logout, file.delete, and share.create/delete/read. Contains client IP and hashed user id; never the raw OIDC sub or session token. Share events carry only the token _prefix_ (first 6 chars) — anyone with audit-log read could otherwise hijack live shares. Pipe to journald / syslog as needed.
- **Share token grammar + 404-on-miss**: token must match `/^[A-Za-z0-9_-]{16,64}$/` and the regex is checked **in the route** before any DB lookup, so malformed paths never hit the pool. Both unknown and not-owned tokens return 404 (not 403/400) so callers can't probe for token existence. Per-user share cap (`RETROTRACKER_SHARE_USER_CAP`, default 500).
- **Session JWT** carries `iss: "retrotracker"` + `aud: "retrotracker-spa"` claims so the cookie secret can't be cross-used by another service.
- **Dev-server LAN exposure**: `npm run dev` binds 127.0.0.1 by default — safe. `vite dev --host` exposes the API on the LAN with no auth; only run that on a trusted network or set the `OIDC_*` env vars before binding 0.0.0.0.

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess` — array/record access returns `T | undefined`. Use `arr[i]!` only when an invariant guarantees presence (e.g., `PERIOD_TABLE[finetune]!` — finetune is 0..15).
- Path alias `~/*` → `src/*` (configured in [tsconfig.json](tsconfig.json) and [vitest.config.ts](vitest.config.ts)).
- Constants like `CHANNELS = 4`, `ROWS_PER_PATTERN = 64` live in [src/core/mod/types.ts](src/core/mod/types.ts) — import them, don't hardcode.
- When adding effects to the replayer: tick-0 setup goes in `applyTick0Effect`/`applyExtendedTick0`, per-tick continuous behavior in `tickEffect`. Cross-check pt2-clone's source before assuming behavior.
