# PLUCK TRAINER — Complete Build Specification (single-file handoff)

> This is the entire handoff. It contains (A) the product/technical specification and (B) the validated
> Python reference DSP and synthetic test generator, verbatim. An AI coding agent (Claude in Cursor)
> should read Part A fully, then create the files in Part B at `/ref/` exactly as given, then start at
> Milestone M0 (§11). The Python reference is ground truth for onset detection and per-note features;
> the browser implementation must match it per §12 before scoring work begins.
>
> Context for the agent: the user is a bass player practicing Les Claypool-style three-finger
> (ring-middle-index) plucking rolls on a single string. The app listens to a bass DI through a USB audio
> interface on an iPad/iPhone (Safari) or desktop, generates its own metronome/drum grid, and scores every
> pluck against that grid in real time.

---

# PART A — SPECIFICATION


Three-finger (ring-middle-index) bass plucking trainer. Web app, runs in a browser on desktop and in Safari on iPhone/iPad, with a class-compliant USB audio interface for a clean DI signal. Measures each pluck against a metronome/drum grid that the app itself generates, scores timing, attack evenness, tone consistency, finger balance, and cleanliness, and shows it live.

This document is the full spec for a first implementation. A validated Python reference analyzer (`rmi_analyzer.py`) exists and should be treated as ground truth for the DSP; the browser implementation must produce the same onset timestamps and per-note features on the same WAV within tolerance (see §12).

---

## 0. Reading order for the implementer

1. §1 Goals and non-goals
2. §3 Pattern grammar (everything hangs off this)
3. §5 Audio architecture and the single-clock rule
4. §6 Onset detector (port of the Python reference)
5. §8 Scoring
6. §9 UI
7. §11 Milestones

---

## 1. Goals and non-goals

### Goals
- Practice right-hand plucking patterns, primarily r-m-i rolls on a single string, against a self-generated metronome or drum beat.
- Real-time visual feedback with onset-to-pixel latency under ~50 ms on iOS Safari.
- Sub-millisecond *measurement* accuracy, independent of display latency, by timestamping both the metronome and the detected plucks on the same audio clock.
- Per-finger diagnostics: which finger is late, quiet, dark, or ghosting on rests.
- Pattern library defined as data (JSON), user-extensible from a text field.
- Session history persisted locally (IndexedDB / localStorage) for trend over time.
- Single-file deployable HTML (or a small Vite project that builds to one) hosted on Vercel. Note: `getUserMedia` requires a secure context (HTTPS or localhost), so a copy opened from disk or served over plain HTTP on the LAN works only as a metronome; iPad testing goes through Vercel deploys or a local HTTPS dev server.

### Non-goals (v1)
- Pitch tracking / string-crossing scoring (v2; hook left in feature vector).
- Flamenco-style strumming (rasgueado) detection. Different detector, later.
- Apple Watch haptics (requires native Swift; v2).
- Camera / hand tracking.
- Accounts, cloud sync.

---

## 2. Target platforms and constraints

| Platform | Input | Notes |
|---|---|---|
| iPad / iPhone, Safari 17+ | USB-C class-compliant interface (e.g. iRig HD X) | Primary portable target. Audio context must be created/resumed inside a user gesture. Screen lock suspends audio; use Screen Wake Lock API. |
| iPad / iPhone, built-in mic | none | "Timing-only" mode. Tone metrics disabled. Headphones required (Bluetooth headphones add ~100–200 ms output latency; see §7.4 calibration). |
| Desktop Chrome / Safari | Quad Cortex USB or any interface | Development and reference. |

### iOS-specific requirements
- `getUserMedia` constraints MUST request `echoCancellation: false, autoGainControl: false, noiseSuppression: false`. Voice processing destroys attack-level measurement. iOS has a history of not fully honoring these; M0 must verify via `track.getSettings()` and by watching the input meter for AGC pumping. If iOS refuses to disable processing on the interface input, the fallback is a Capacitor wrapper with a native audio-input plugin feeding the same worklet/scoring code (full Swift remains the v2 path for Watch haptics).
- Input may be stereo (instrument typically on channel 1 of the interface); the worklet reads channel 0 only.
- Use `AudioWorklet` (supported iOS 14.5+). Do not use `ScriptProcessorNode`.
- Sample rate: do not assume 48 kHz; read `audioContext.sampleRate` and derive all sample-domain constants from it.
- Render quantum is 128 frames; the worklet processes in 128-frame blocks.
- Call `audioContext.resume()` on every Start tap. Handle `statechange` → if `suspended` while a session is running, pause the session and show a "tap to resume" overlay.
- Add to Home Screen manifest (`display: standalone`) so it runs without browser chrome.
- `navigator.wakeLock.request('screen')` on session start; re-request on `visibilitychange`.

---

## 3. Pattern grammar

A pattern is the unit of practice. Patterns are data, not code.

### 3.1 Syntax
```
pattern  := beat (" " beat)*
beat     := slot+
slot     := finger | accentFinger | rest
finger   := "r" | "m" | "i" | "t" | "p"      // ring middle index thumb pinky
accent   := "R" | "M" | "I" | "T" | "P"      // same finger, accent expected
rest     := "x"
```
- Spaces separate **beats** (one metronome click each).
- Every beat in a pattern MUST have the same number of slots. (Mixed-subdivision patterns are a v2 feature; reject with a validation error for now.)
- `slotsPerBeat = beats[0].length`. Grid step = `60 / bpm / slotsPerBeat` seconds.
- Pattern loops indefinitely. `patternLength = beats.length` (in beats).

### 3.2 Preset library (ship these)
```json
[
  {"id":"trip",       "name":"Even triplets",             "pattern":"rmi rmi rmi rmi",        "groove":"shuffle"},
  {"id":"gallop",     "name":"Gallop (roll + rest)",      "pattern":"rmix rmix rmix rmix",    "groove":"straight16"},
  {"id":"revgallop",  "name":"Reverse gallop",            "pattern":"xrmi xrmi xrmi xrmi",    "groove":"straight16"},
  {"id":"disp1",      "name":"Displaced rest A",          "pattern":"rxmi rxmi rxmi rxmi",    "groove":"straight16"},
  {"id":"disp2",      "name":"Displaced rest B",          "pattern":"rmxi rmxi rmxi rmxi",    "groove":"straight16"},
  {"id":"six16",      "name":"Straight 16ths (3 vs 4)",   "pattern":"rmir mirm irmi rmir mirm irmi", "groove":"straight16", "cycle":"rmi"},
  {"id":"six16acc",   "name":"16ths w/ rotating accent",  "pattern":"Rmir Mirm Irmi Rmir Mirm Irmi", "groove":"straight16", "cycle":"rmi"},
  {"id":"sext",       "name":"Sextuplets",                "pattern":"rmirmi rmirmi rmirmi rmirmi", "groove":"click"},
  {"id":"quint",      "name":"Quintuplets (3 vs 5)",      "pattern":"rmirm irmir mirmi rmirm irmir mirmi", "groove":"click", "cycle":"rmi"},
  {"id":"pickup",     "name":"Triplet with pickup",       "pattern":"xmi rmi rmi rmi",        "groove":"shuffle"},
  {"id":"ringiso",    "name":"Ring isolation",            "pattern":"rmrm rmrm rmrm rmrm",    "groove":"straight16"},
  {"id":"twofinger",  "name":"Two-finger reference",      "pattern":"im im im im",            "groove":"straight8"}
]
```
Note: `six16` has 6 beats because the r-m-i cycle over 4 slots repeats every 3 beats; 6 beats gives 2 full cycles so the accent rotation is visible. Implementer may generate rotating patterns programmatically from `(cycle, slotsPerBeat, beats)` rather than storing them literally.

### 3.3 Custom patterns
A text field accepts the grammar. Validate: allowed characters only; equal slot count per beat; at least one non-rest slot. Save custom patterns to local storage with a user-supplied name.

### 3.4 Derived structures
From a pattern the app computes, once per session:
```ts
interface GridSlot {
  index: number;          // 0..N-1 over one pattern loop
  beat: number;           // which beat within the pattern
  sub: number;            // slot index within the beat
  finger: 'r'|'m'|'i'|'t'|'p'|null;   // null = rest
  accent: boolean;
  timeOffset: number;     // seconds from pattern start
}
```
Grid times for loop `k`, slot `s`: `t = sessionStart + k * patternLength * beatDur + slot.timeOffset`.

---

## 4. Session model

```ts
interface SessionConfig {
  patternId: string;
  pattern: string;
  bpm: number;               // 30..300
  groove: 'click'|'clickSub'|'straight8'|'straight16'|'shuffle'|'halftime';
  countInBars: number;       // default 1 (pattern loops), min 0
  dropoutBars: number;       // 0 = off; else metronome silent for this many bars every `dropoutEvery`
  dropoutEvery: number;      // default 8
  ramp: {enabled: boolean; bpmStep: number; everyBars: number; requireClean: boolean};
  inputMode: 'di'|'mic';
  latencyCompMs: number;     // from calibration (§7.4); applied to onset timestamps
  durationBars: number | null; // null = until stop
}
```

Session lifecycle: `idle → armed (audio started, no grid) → countIn → running → (paused) → ended`. Plucks during `countIn` are detected but not scored; they are used to show "we hear you" level meter.

---

## 5. Audio architecture — the single-clock rule

Everything that matters for timing happens on `AudioContext` time. **No `setTimeout`/`setInterval` is ever used for anything that is measured.**

```
[USB interface DI] → getUserMedia → MediaStreamSource
                                         │
                                         ▼
                               AudioWorkletNode("onset-detector")
                                         │  postMessage({onsets:[{frame, peak, rms, centroid, ...}]})
                                         ▼
                                  main thread: Scorer → UI

Metronome/Drums: scheduler (main thread lookahead) → OscillatorNode/BufferSource
                 .start(audioContext.currentTime + …) → destination (headphones)
```

- The input stream is never connected to `destination` (no monitoring through the browser; the interface provides direct monitoring with zero latency).
- Worklet reports onsets as `currentFrame + offsetWithinBlock` (absolute sample index). Main thread converts with `frame / sampleRate` and compares to scheduled grid times directly. Both are on the same clock; input latency is a constant offset handled by calibration (§7.4).

### 5.1 Scheduler (metronome + drums)
Standard lookahead scheduler (the "tale of two clocks" pattern):
- A `setInterval` at 25 ms wakes the scheduler (this is allowed: it is not the timing reference, it just decides *what* to schedule).
- Schedule every grid event whose time is within `lookahead = 0.12 s` of `audioContext.currentTime`, using `node.start(exactTime)`.
- Each scheduled event is also pushed to an `expectedEvents` ring buffer `{time, slot, loop, audible}` for the scorer and for the visual sweep.
- Grid events include rests (for scoring) even though nothing is played for them.

### 5.2 Sound design (all synthesized, no sample files)
| Sound | Synthesis |
|---|---|
| Click (beat 1) | 1.5 kHz sine, 6 ms, exp decay, +6 dB |
| Click (other beats) | 1 kHz sine, 5 ms |
| Subdivision tick | 2 kHz sine, 3 ms, −12 dB |
| Kick | sine 150→50 Hz pitch sweep over 80 ms, exp amp decay 200 ms |
| Snare | noise burst 150 ms bandpass 1.5 kHz + 180 Hz sine 60 ms |
| Hat closed | noise 30 ms, highpass 7 kHz |
| Hat open (for shuffle feel) | noise 120 ms, highpass 6 kHz |

Grooves (per beat; `.` = nothing):
| groove | kick | snare | hats |
|---|---|---|---|
| click | click only | | |
| clickSub | click + ticks on all slots | | |
| straight8 | 1, 3 | 2, 4 | 8ths |
| straight16 | 1, 3 (+ "and" of 3) | 2, 4 | 16ths, accent on 8ths |
| shuffle | 1, 3 | 2, 4 | triplet hats, skip middle triplet (swing feel); or full triplets when slotsPerBeat==3 |
| halftime | 1 | 3 | 8ths |

Default groove per pattern is given in the preset JSON. If `slotsPerBeat` is 5 or 6, force `click` or `clickSub` (no drum pattern helps).

### 5.3 Drop-out mode
When enabled, every `dropoutEvery` bars the scheduler marks `dropoutBars` bars as `audible:false`: events are still pushed to `expectedEvents` (scoring continues) but nothing is played. UI shows the sweep hand dimmed so the player knows they're unaccompanied.

### 5.4 Tempo ramp
At the end of each `everyBars` block, if `requireClean` is false OR the block's scores all exceed the ramp thresholds (§8.5), `bpm += bpmStep`. Grid timing for subsequent events is recomputed from the ramp boundary (the boundary is an exact scheduled time; there is no drift).

---

## 6. Onset detector (AudioWorklet)

Direct port of `detect_onsets()` in `rmi_analyzer.py`. Reference behaviour on the synthetic test file: 48/48 onsets, 0 double triggers, planted ring-finger deficits recovered within 2 ms / 0.2 dB.

### 6.1 Algorithm
1. **High-pass** the input at 1000 Hz, 4th order Butterworth (two cascaded biquads, coefficients computed from `sampleRate`). Rationale: pluck transients have energy above 1 kHz; the ringing fundamental (41–250 Hz and low harmonics) does not, so the sustain cannot retrigger.
2. **Envelope**: RMS over a 256-sample window, hop 32 samples (use a running sum of squares for O(1) per hop). Normalize by a slowly-tracking running max (`envMax = max(envMax*0.9995, env)` per hop) so the threshold is relative to recent loudness, not session-global. Hard floor `envMax >= 1e-4` to avoid dividing by silence.
3. **Trigger**: when `env/envMax > relThr` (default 0.15) and at least `minGap` since last onset:
   - find the local peak of `env` within the next 8 ms;
   - walk backwards from the peak while `env[k-1] > 0.1 * env[peak]` to find the burst start `k`;
   - emit onset at sample `k`;
   - set `lastOnset = peak`, skip ahead `minGap` samples.
4. `minGap = 0.5 * gridStep` (main thread sends this to the worklet via `port.postMessage` whenever bpm or pattern changes). Clamp to [20 ms, 150 ms].
5. The walk-back means onsets are reported ~1–3 ms *after* they happen in wall time (we need to see the peak). This latency is constant and does not affect measurement; it only delays display.

Worklet must keep a small ring buffer of `env` (≥ 16 ms) to support the 8 ms look-ahead and walk-back.

### 6.2 Per-onset features (computed in worklet, on the *un-filtered* signal)
Keep a 40 ms raw-sample ring buffer in the worklet. On onset, after 40 ms have accumulated (i.e. ~2 blocks later), compute and post:
```ts
interface Onset {
  frame: number;        // absolute sample index of burst start
  peak: number;         // max |x| in first 40 ms
  rms: number;          // RMS of first 40 ms
  centroid: number;     // spectral centroid (Hz) of first 40 ms, Hann window, FFT 2048 (zero-pad)
  hfRatio: number;      // energy above 2 kHz / total, first 40 ms (cheap nail/flesh proxy, used in v1 UI as "brightness")
  decayMs: number|null; // time for 5-ms-block RMS to fall 20 dB below its max; null if next onset arrives first. v1: compute on main thread from a 300 ms tail, or omit.
}
```
Post onsets in batches per 128-frame block to minimize message traffic (usually 0 or 1).

FFT: write a small radix-2 in the worklet or do the centroid on the main thread from a posted 40 ms Float32Array (1920 samples at 48 k). Main-thread is fine for v1; it does not affect timing.

### 6.3 Mic mode
Same detector; set `relThr` 0.25 and expose a sensitivity slider (0.1–0.5). Disable `centroid`/`hfRatio` in scoring and UI.

### 6.4 Level meter
Worklet also posts a 50 ms RMS every 4 blocks for the input meter. Warn if input peaks < −30 dBFS (gain too low) or clips (> −0.5 dBFS).

---

## 7. Grid matching

### 7.1 Matching onsets to slots
For each onset time `t` (after latency compensation):
1. Find the nearest grid event `e` (any slot, rest or not) by absolute time. Binary search over `expectedEvents`.
2. `dev = t - e.time` (seconds, + = late).
3. If `|dev| > 0.5 * gridStep` → unmatched (should be rare; counts as `extra`).
4. If `e.finger === null` (rest) → this is a **ghost pluck**: record `{type:'ghost', dev, slot:e}`; do not use for timing/attack stats.
5. Else → record `{type:'hit', dev, slot:e, onset}` and mark `e.hit = true`. If `e` already has a hit, the later one is `double`.
6. After `e.time + 0.5*gridStep` passes with no hit on a non-rest slot → **missed**.

Finger label comes from the matched slot, never from a running counter. A dropped pluck therefore does not shift subsequent labels.

### 7.2 Accent handling
For slots with `accent:true`, expected peak ≥ `accentRatio` (default 1.3) × the rolling mean peak of non-accent hits. Scored in §8.4.

### 7.3 Count-in
During count-in, run matching but flag results `scored:false`.

### 7.4 Latency calibration
Constant input latency (interface ADC + USB + OS buffer) shifts every onset late by the same amount. Calibrate once per device/interface:
- **Auto (DI)**: play the click through the headphone out into the DI input with a cable (or simply ask the user to pluck *with* a loud click for 8 beats); the median `dev` over those beats is `latencyCompMs`. Store per `deviceId` from `enumerateDevices()`.
- **Manual**: slider −100..+300 ms with live median-dev readout; user adjusts until "good feeling" plucks center at 0.
- Mic + Bluetooth headphones: output latency also applies (the user hears the click late). Calibration absorbs both since it measures net offset.

---

## 8. Scoring

All stats are computed over a **window** (default: last 8 bars, rolling) and over the **session**. Windowed values drive the live UI; session values go to history.

### 8.1 Per-finger stats (for each finger present in the pattern, plus `all`)
```
n            count of hits
meanDev      mean(dev) ms           + = late
jitter       std(dev) ms
peakMean     mean(peak)
peakCV       std(peak)/mean(peak)
centroidMean mean(centroid) Hz
centroidCV   std/mean
```
### 8.2 Balance (between fingers)
```
peakSpreadDb      20*log10(max peakMean / min peakMean)
centroidSpreadPct (max-min)/mean * 100
timingSpreadMs    max meanDev - min meanDev
```
### 8.3 Cleanliness
```
ghosts   count of plucks matched to rest slots
missed   count of non-rest slots with no hit
doubles  count of slots with >1 hit
extras   unmatched onsets
```
### 8.4 Accent
```
accentHitRate   fraction of accent slots whose peak ≥ accentRatio * rolling non-accent mean
leakage         for slotsPerBeat % cycleLength != 0: peakMean of cycle-start finger / peakMean(all).
                > 1.15 → "accenting every <finger> — sounds like triplets, not 16ths"
```
Leakage needs the cycle concept, which explicit pattern strings don't carry: presets derived from a rotating cycle declare it via a `cycle` field (e.g. `"cycle":"rmi"` on `six16`, `six16acc`, `quint`). Skip the leakage metric for patterns without one.
### 8.5 Scores (0–100, linear between `good` and `bad`, clamped)
| score | input | good | bad |
|---|---|---|---|
| timing | `all.jitter` | 4 % of grid step | 25 % of grid step |
| attackEven | `all.peakCV`×100 | 6 | 30 |
| toneEven | `all.centroidCV`×100 | 5 | 25 |
| fingerBalance | `peakSpreadDb` | 1.0 | 6.0 |
| clean | `(ghosts+missed+doubles) / slotsInWindow` ×100 | 0 | 15 |
| accent (only if pattern has accents) | `accentHitRate`×100 | 90 | 40 |

No single composite score is displayed. Ramp "clean block" = timing ≥ 70 AND attackEven ≥ 60 AND clean ≥ 80 (user-adjustable).

### 8.6 Diagnosis strings (plain language, shown under scores)
Generate in priority order, max 3:
1. `clean < 60` → "ghost plucks on rests: <n> in last 8 bars" (gallop) / "missed <n> notes"
2. `peakSpreadDb > 2` → "<quietest finger> is the weak finger (−x.x dB)"
3. `timingSpreadMs > 5 % of step` → "<latest finger> lands late (+x ms)"
4. `all.meanDev > 10 % of step` → "dragging" ; `< −10 %` → "rushing"
5. leakage → "accenting every <finger>…"
6. none of the above → "clean — bump the tempo"

---

## 9. UI

Single page, dark background, high-contrast. Must be usable at arm's length on an iPad on a stand. Large tap targets (≥ 48 px). Landscape and portrait.

### 9.1 Layout (top → bottom)
1. **Transport bar**: Start/Stop (big), BPM (tap to edit, ± buttons, tap-tempo), pattern name (opens picker), groove selector, input meter, device/latency badge.
2. **Beat clock** (primary live visual, Canvas, square, ≥ 60 % of width in portrait):
   - Circle divided into `slotsPerBeat` sectors. Rest sectors drawn hollow/hatched. Accent sectors have a thicker outer ring.
   - Sweep hand rotates once per beat, driven by `audioContext.currentTime` in `requestAnimationFrame` (not by the scheduler), so it is visually locked to the audio clock.
   - Each hit drops a dot at angle `(slot.sub + dev/gridStep)/slotsPerBeat * 2π`, radius proportional to `peak` (normalized to rolling max), colour by finger (ring = orange, middle = cyan, index = green, thumb = purple, pinky = pink; colourblind-safe set). Ghost plucks = red hollow dot in the rest sector. Missed = grey ring at the slot angle.
   - Dots fade over ~4 beats. Even playing produces tight coloured clusters at each sector centre.
3. **Lollipop strip** (Canvas, full width, ~120 px tall): last 32 hits, scrolling left. Stem height = peak; horizontal nudge = `dev` (scaled so ±25 % of step = ±½ column); colour by finger; beat lines; rest columns shaded; ghosts drawn as red stems in rest columns.
4. **Finger bars**: for each finger, three mini-bars: timing (centered, ± ms), attack (dB rel. to loudest finger), brightness (centroid rel.). Smoothed with EMA α = 0.2 per new hit.
5. **Scores row**: the six scores as horizontal bars with numbers. Diagnosis text beneath.
6. **Session footer**: bars completed, current window, ramp status, "End session" → summary modal.

### 9.2 Pattern picker
List of presets (§3.2) + custom. Each row shows pattern string rendered as coloured dots (rests hollow, accents bold). "New custom" opens the text field with live validation and a rendered preview.

### 9.3 Settings
Count-in bars, drop-out config, ramp config, calibration, mic sensitivity, colour theme, "subdivision ticks" toggle, accent ratio, window size.

### 9.4 Summary modal (session end)
Table identical to the Python report (per finger: n, mean ms, jitter, peak, peak CV, centroid, + balance + scores + diagnosis), plus a small timing histogram per finger. "Save" writes to history. "Export CSV" of per-hit rows.

### 9.5 History view
List of sessions (date, pattern, bpm, scores). Tapping a pattern shows score-vs-date and bpm-vs-date lines. Local only.

### 9.6 Rendering budget
- Canvas draw in `requestAnimationFrame`; skip frames if `performance.now()` since last draw < 8 ms.
- All per-hit math is O(1) amortized; windowed stats use running sums / Welford.
- No React re-render per hit; keep hits in a ring buffer and redraw canvases. (If React is used for chrome, keep canvases outside React state.)

---

## 10. Data model and persistence

```ts
interface HitRecord { t: number; slotIndex: number; loop: number; finger: string|null; accent: boolean;
                      devMs: number; peak: number; rms: number; centroid: number; hfRatio: number;
                      type: 'hit'|'ghost'|'double'|'extra'; scored: boolean; }

interface SessionRecord { id: string; startedAt: string; config: SessionConfig;
                          bars: number; summary: Summary; hits?: HitRecord[]; }  // hits optional (size)
```
Persist `SessionRecord` (without hits by default; keep last 20 with hits) in IndexedDB via a tiny wrapper. Presets + custom patterns + calibration per deviceId in localStorage.

---

## 11. Milestones

**M0 — Skeleton (1 evening)**
AudioContext + worklet + getUserMedia with correct constraints; input meter; Start button works on iPad Safari. Ship to Vercel. Verify iRig is selectable via `enumerateDevices`. Exit criteria: `track.getSettings()` confirms echoCancellation/autoGainControl/noiseSuppression are actually off on the interface input, meter shows no AGC pumping, and `audioContext.sampleRate` is logged. If processing cannot be disabled, stop and pivot to the native-input fallback (§2) before building further.

**M1 — Metronome + grid**
Scheduler, click + ticks, `expectedEvents`, beat clock sweep hand locked to audio. Drop-out mode. No detection yet.

**M2 — Detection + matching**
Worklet detector (§6), onset → slot matching (§7), dots on the beat clock, lollipop strip. Validate against `rmi_analyzer.py` on recorded WAVs (§12).

**M3 — Scoring + diagnosis**
§8 complete, finger bars, scores row, diagnosis strings. Summary modal, CSV export.

**M4 — Patterns + grooves**
Pattern grammar, preset library, custom patterns, synthesized drum grooves, tempo ramp.

**M5 — Polish for iPad**
Wake lock, standalone manifest, suspend/resume handling, calibration flow, mic mode, history view.

**v2 candidates**: pitch (YIN) for string-crossing patterns; rasgueado mode; native Swift wrapper + Apple Watch haptic pulse; reference-track comparison (run the same analyzer on an isolated bass stem and show target numbers).

---

## 12. Validation

1. Generate test WAVs with `make_test.py` (synthetic bass, planted defects). Feed them through the browser pipeline via an `AudioBufferSourceNode` into the worklet (a hidden "analyze file" dev mode). The dev mode must replicate the reference preprocessing: use input channel 0, normalize the decoded buffer to peak 1.0, and normalize the envelope by the file-global max (two-pass), not the live running max. Compare onsets to `rmi_analyzer.py --csv`:
   - onset count identical;
   - onset times: the reference uses zero-phase filtering (`sosfiltfilt`) and centered RMS frames, which a causal real-time pipeline cannot reproduce, so browser onsets lag by a roughly constant 2–5 ms. Compute the median browser−reference offset, require its std < 1 ms across all onsets, then require per-onset agreement within ±1 ms after subtracting the median. (§7.4 calibration removes constant offsets in live use, so only the stability matters.)
   - peak within ±2 %;
   - centroid within ±5 %.
2. Real takes: record 3 DI takes (good / sloppy / deliberately heavy ring finger) at 80 BPM triplets. The ordering of `attackEven` and `fingerBalance` scores must match the player's own ranking.
3. Latency: on iPad + iRig, loop headphone out to DI in and confirm median `dev` is stable within ±1 ms across a 60 s run (jitter of the pipeline itself).
4. Gallop pattern with a deliberately added 4th ghost pluck every other beat → `ghosts` should count exactly those.

---

## 13. Reference implementation notes (from the Python version)

- High-pass at 1 kHz before the envelope was the decisive fix; envelope-slope on the raw signal retriggered on the fundamental's ripple, and a "rise must double the envelope" rule failed when notes overlapped. Keep the HPF.
- `minGap = 0.5 * gridStep` is what makes the detector robust; it must be updated whenever bpm/pattern changes.
- Walk-back to `0.1 × peak` gives onset times ~1 ms before the audible attack peak, consistently; this is fine because calibration removes constant offsets.
- The "accent leakage" check (cycle-start finger > 1.15× mean) reliably caught the triplet-feel-on-16ths failure in synthetic tests.
- Known gap: decay measurement is meaningless when notes overlap (reads ≈ grid step). Show it only in summary, labelled "ring-out", and don't score it in v1.

---

## 14. File layout (suggested)

```
/index.html            single entry; inlines CSS; loads main.js as module
/src/main.js           app state, transport, session lifecycle
/src/audio/context.js  AudioContext creation, device enumeration, constraints
/src/audio/worklet.js  onset-detector AudioWorkletProcessor (loaded via Blob URL so it stays single-file)
/src/audio/scheduler.js metronome/drum scheduler, expectedEvents
/src/audio/synth.js    click/kick/snare/hat synthesis
/src/pattern.js        grammar parse/validate, presets, GridSlot derivation
/src/scoring.js        matching, windowed stats, scores, diagnosis
/src/ui/clock.js       beat clock canvas
/src/ui/strip.js       lollipop strip canvas
/src/ui/panels.js      finger bars, scores, picker, settings, summary
/src/store.js          IndexedDB + localStorage
/dev/analyze-file.js   hidden mode: run pipeline on a WAV for validation
/ref/rmi_analyzer.py   reference DSP (do not modify without re-validating)
/ref/make_test.py      synthetic test generator
```

Build (pinned, see Appendix A1): plain static ES modules with no bundler for M0–M3, deployed to Vercel as static files. The worklet is a same-origin static file loaded via `addModule('/src/audio/worklet.js')` — not a Blob URL. The single-file Vite build is deferred to M5.

---

## 15. Open questions for the developer (decide, then proceed)

1. Vanilla + Canvas vs. React for chrome. Recommendation: vanilla for M0–M3, React optional later; the hot path is canvas either way.
2. Whether to compute centroid in the worklet (needs FFT in the worklet) or on main thread from a posted 40 ms buffer. Recommendation: main thread for v1.
3. Whether the beat clock should show one beat or the whole pattern as concentric rings. Start with one beat; add a "pattern ring" view in M4 if the 3-vs-4 drills feel confusing.

---

# PART B — REFERENCE CODE

Create these files verbatim under `/ref/`. Do not modify `rmi_analyzer.py` without re-validating against the synthetic test.

- [`/ref/rmi_analyzer.py`](../ref/rmi_analyzer.py) — ground truth for `detect_onsets()` and `note_features()`.
- [`/ref/make_test.py`](../ref/make_test.py) — synthetic DI generator (`test_bad_ring.wav`).

Port `detect_onsets()` and `note_features()` to the AudioWorklet (§6); port `align_to_grid`/`summarize`/diagnosis logic to `scoring.js` (§7–8), replacing the slot-mod-N finger assignment with nearest-slot matching per §7.1.

### Running the reference
```
pip install librosa soundfile scipy
python ref/make_test.py
python ref/rmi_analyzer.py test_bad_ring.wav --bpm 80 --subdiv 3 --offset 0.5 --csv ref_notes.csv
```
Expected output includes: `notes detected: 48   missed slots: 0   double-triggers: 0`, ring finger ≈ +13 ms and
≈ 3.2 dB under index, and diagnosis line `ring is the weak finger`. The browser dev mode (§12.1) must reproduce
`ref_notes.csv` within the stated tolerances.

---

# APPENDIX — pinned implementation details (added at build handoff)

These sections close the places where Part A assumes implementer judgment. Where Part A and this
appendix differ, **the appendix wins**. Do not invent alternatives to anything pinned here.

## A1. Tooling (pinned)

- No bundler, no framework, no npm build step for M0–M3. Plain static ES modules in the §14 layout,
  deployed to Vercel as a static site.
- Worklet: `audioContext.audioWorklet.addModule('/src/audio/worklet.js')` — a same-origin static file.
  Do NOT use a Blob URL and do NOT use a bundler `?url`/`?worker` import.
- iPad testing is always against the Vercel deployment (`getUserMedia` needs HTTPS). Desktop dev can use
  any local static server on `localhost`.
- Single-file build (Vite + `vite-plugin-singlefile`) is an M5 task only.

## A2. High-pass filter (exact coefficients)

4th-order Butterworth highpass at `fc = 1000` Hz = two cascaded RBJ highpass biquads with
`Q1 = 0.54119610` and `Q2 = 1.30656296`. For each biquad:

```js
const w0 = 2 * Math.PI * fc / sampleRate;
const cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
let b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2;
let a0 = 1 + alpha,    a1 = -2 * cw,   a2 = 1 - alpha;
b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
// Direct Form II transposed; s1, s2 are per-biquad state:
// y = b0*x + s1;  s1 = b1*x - a1*y + s2;  s2 = b2*x - a2*y;
```

Filter state persists across 128-frame blocks for the whole session. Never reset it mid-session.
This is a causal filter; the Python reference uses zero-phase `sosfiltfilt`, hence the constant
offset that §12.1 removes with the median.

## A3. Worklet detector — operational pseudocode

Constants, derived once from `sampleRate` (`sr`): `HOP = 32`, `WIN = 256`,
`lookAheadHops = Math.ceil(0.008 * sr / HOP)`, `maxWalkbackHops = Math.ceil(0.016 * sr / HOP)`.
`minGapHops` comes from the main thread (`0.5 * gridStep`, clamped to 20–150 ms, converted to hops).

Per input sample (channel 0, after the A2 filter): update a running sum of squares over the last
`WIN` samples using a circular buffer (`sumSq += x*x - oldestSq`). Every `HOP` samples emit one
envelope value:

```
env = sqrt(sumSq / WIN); hopIdx++;
envMax = max(envMax * 0.9995, env, 1e-4);
envRing[hopIdx % RING] = env;            // RING >= lookAheadHops + maxWalkbackHops + slack
```

Decisions are made `lookAheadHops` behind real time so the 8 ms peak-search window is complete.
Let `d = hopIdx - lookAheadHops`:

```
if (d >= scanFrom && envRing[d] / envMax > relThr) {
  j = index of max(envRing[d .. d + lookAheadHops]);        // local peak
  k = j;
  while (k > j - maxWalkbackHops && k > 0 && envRing[k-1] > 0.1 * envRing[j]) k--;
  onsetFrame = k * HOP + streamStartFrame;                  // absolute sample index
  schedule feature capture at onsetFrame + 40 ms;
  scanFrom = j + minGapHops;
}
```

Feature capture: keep a raw (unfiltered, channel 0) ring buffer of ≥ 100 ms (8192 samples is fine).
Once 40 ms of raw samples past `onsetFrame` exist, compute `peak = max|x|` and `rms` over that 40 ms
and post `{frame, peak, rms, raw40: Float32Array}` in the current block's batch. The main thread
computes `centroid` (Hann window, zero-pad to FFT 2048) and `hfRatio` from `raw40`.

Envelope timestamp convention: the live envelope is trailing (`env[k]` covers samples
`[k*HOP - WIN, k*HOP]`), while the Python reference uses centered frames. This adds to the constant
offset already absorbed by §12.1 median removal and §7.4 calibration. Do not try to "correct" it.

## A4. Grooves never alter the grid

The scoring grid is always `slotsPerBeat` evenly spaced slots per beat (`60 / bpm / slotsPerBeat`).
Grooves (including shuffle) only choose which drum sounds play where; they never move grid times, and
swing is never applied to expected slot times. The shuffle groove is only paired with triplet
(`slotsPerBeat == 3`) patterns in the presets, where hats naturally land on slots.

## A5. Matching bookkeeping (makes §7.1 step 6 concrete)

- `t = onset.frame / sampleRate - latencyCompMs / 1000` before matching.
- `expectedEvents` is time-sorted. Keep a `sweepIndex`. On every scorer invocation (each onset batch
  and each animation frame), advance `sweepIndex` past all events with
  `event.time + 0.5 * gridStep < audioContext.currentTime`; any passed non-rest event without a hit is
  marked **missed** (grey ring on the clock, counted in cleanliness). Events behind `sweepIndex` are
  final and never rematched.
- Every onset matched to a rest slot is a **ghost**, even if that rest already has ghosts (each counts).
- Second and later onsets matched to an already-hit slot are each a **double**.

## A6. Per-milestone acceptance checks (do not proceed past a milestone until these pass)

- **M0**: the §11 exit criteria (`track.getSettings()`, no AGC pumping, sample rate logged).
- **M1**: at 120 BPM, consecutive click times in `expectedEvents` differ by exactly 0.5 s (log-check
  10 bars); sweep hand visually coincides with the audible click; drop-out silences audio while
  `expectedEvents` keeps flowing.
- **M2**: the A7 harness passes §12.1 on `test_bad_ring.wav`: 48 onsets, offset std < 1 ms, per-onset
  ±1 ms after median removal, peak ±2 %, centroid ±5 %.
- **M3**: summary table for `test_bad_ring.wav` reproduces the Python report within the same
  tolerances and the diagnosis includes "ring is the weak finger".
- **M4**: every §3.2 preset parses; validation rejects `"rm i"` (unequal slots), `"abc"` (bad chars),
  and `"xxx xxx"` (all rests).
- **M5**: wake lock held during a session; session pauses and resumes cleanly on tab switch / lock.

## A7. Validation harness (dev mode) spec

Hidden page at `?dev=analyze`: two file inputs (WAV + reference CSV from `rmi_analyzer.py --csv`).
Decode the WAV with `new OfflineAudioContext(1, length, fileSampleRate)` so it is NOT resampled to the
live context rate. Take channel 0, normalize to peak 1.0. Run the detector **offline as a plain
function** (mirror the Python loop: compute the full envelope array, normalize by its global max, then
scan) — do not use the live running-max normalization here. Compute features identically to the live
path. Render a per-onset table (Δms after median removal, peak %, centroid %) with a PASS/FAIL line
per §12.1 criterion, plus the median offset and its std.

---

*End of handoff.*
