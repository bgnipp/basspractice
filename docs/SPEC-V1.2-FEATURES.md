# Tech spec — v1.2: Sequence mode, Streaks, Take replay, Slot heatmap

Status: approved plan. Extends `docs/PLUCK-TRAINER.md` and `docs/SPEC-COMPRESSION-REVIEW.md`; changes
nothing pinned there. The single-clock rule, detector, and matching logic are untouched everywhere
except where explicitly stated.

**Build order: §2 → §1 → §3 → §4** (streaks are one sitting and make sequence mode land better;
replay and heatmap are independent of each other).

Shared foundation (do first, used by §1 and §2): move hit grading out of `highway.js` into
`scoring.js`:

```js
// grade(devMs, gridStep) -> 'perfect' | 'good' | 'off'
// perfect: |dev| <= 4% of step;  good: <= 12%;  off: beyond (same bands the highway colors use)
```

---

## 1. Sequence mode ("etude mode")

### 1.1 What it is

A sequence chains **segments**; each segment is an existing pattern played for a number of loops.
The player reads rhythm changes coming down the highway instead of looping one figure.

```ts
interface SequenceSegment { pattern: string; bars: number; groove?: string }  // bars = pattern loops
interface Sequence {
  id: string; name: string;
  loop: boolean;              // repeat the whole sequence
  shuffle: boolean;           // random segment order (reading drill)
  gate: { enabled: boolean; cleanMin: number };   // repeat segment until clean >= cleanMin
  segments: SequenceSegment[];
}
```

Ship presets:

| id | name | segments |
|---|---|---|
| `ladder` | Claypool ladder | trip ×4 → pickup ×4 → gallop ×4 → revgallop ×4 → six16 ×2 |
| `gallopdrill` | Gallop drill | trip ×2 → gallop ×4 → disp1 ×4 → disp2 ×4 |
| `reading` | Reading drill | ladder segments with `shuffle: true`, 2 bars each |

Custom sequences: editor is a list of rows (pattern picker + bars stepper), add/remove/reorder, saved
to localStorage next to custom patterns. No free-text JSON in v1.

### 1.2 Segment switching (pinned rules)

- A segment boundary is an **exact scheduled time**:
  `boundary = segmentStart + bars × patternLength(segment) × beatDur`. No drift, same guarantee as
  the tempo ramp.
- New scheduler method `setGridAt(grid, boundaryTime, { loopBase, segmentIndex })`: pops already
  scheduled events at/after the boundary (mechanically identical to `setBpmAt`), swaps the grid,
  re-anchors, continues. The main-thread rAF loop applies the switch when the boundary is within
  0.5 s (comfortably more than the 0.12 s scheduler lookahead).
- `expectedEvents` stays one time-sorted array across segments; every event gains `segmentIndex`.
  Matching is unchanged — nearest event by time, finger from the matched slot.
- Worklet `minGap` is posted when the switch is applied (≤ 0.5 s early). Pinned as acceptable:
  minGap only suppresses retriggers and neighboring segments' steps are within ~2× of each other.
- `slotsPerBeat` MAY change across a boundary (triplets → 16ths is the point). Beat clock, highway,
  and strip get `setGrid` at the boundary. The highway shows the *upcoming* segment's gems as soon as
  they enter the lookahead window, so the reshape is previewed, not a surprise.
- Count-in: once at session start only. Segment switches are seamless.
- **Ramp is disabled in sequence mode (v1).** The gate is the progression mechanic; two competing
  re-anchor mechanisms is a bug farm.
- Gate: when the switch is applied, compute the ending segment's window stats; if
  `clean < gate.cleanMin`, the next segment is the same segment again. Decision uses stats as of the
  decision moment (≤ 0.5 s before the boundary) — pinned as acceptable.
- Shuffle: uniform random among segments, no immediate repeat (unless the sequence has one segment or
  the gate forces a repeat).

### 1.3 Data & scoring

- `HitRecord += { segmentIndex }`; `SessionConfig += { sequenceId?, sequence? }` (snapshot, so history
  survives preset edits).
- Summary gains `perSegment[]`: for each *distinct pattern* in the sequence — n, timing, clean,
  attackEven — plus transition stats: timing jitter of the **first bar after each switch** vs steady
  state (the number that says "your gallop is fine, entering the gallop is not").
- Live scores keep using the rolling window across segments (mixed-pattern windows are fine; grid step
  for score bands is the current segment's).

### 1.4 UI

- Transport: pattern button becomes pattern/sequence button; picker gets a Sequences section.
- Highway: label at the top edge — "→ gallop in 2 bars", counting down; final pre-switch bar pulses.
- Footer: `segment 3/5 · bar 2/4` plus gate status ("gate: repeat — clean 64 < 80").
- Review grid: rows grouped by segment with a header row per segment; each block renders with its own
  column count (the wrap view already derives columns from the grid, so blocks are independent).
- Summary modal: per-segment table + transition-jitter line.

### 1.5 Acceptance

1. Triplets→16ths switch: event times monotonic, first new downbeat exactly at the computed boundary
   (log check, 10 switches, error 0 within float printing).
2. Highway shows the next segment's gems before the boundary at 80 BPM (lookahead spans it).
3. Gate with planted sloppy segment repeats that segment; clean segment advances.
4. Shuffle over 100 draws: no immediate repeats, all segments drawn.
5. Review grid renders a session containing 3- and 4-slot segments without misalignment.

Touch: `src/pattern.js` (sequence presets/validation), `src/audio/scheduler.js` (`setGridAt`,
`segmentIndex`), `src/main.js` (sequence driver in rAF loop, gate, picker/editor wiring),
`src/ui/highway.js` (label), `src/ui/review.js` (segment blocks), `src/ui/panels.js` (picker section,
editor, summary), `src/scoring.js` (segment summaries), `src/store.js` (custom sequences),
`index.html`, `tests/sequence.test.mjs` (boundary math, gate, shuffle as pure functions).

---

## 2. Streaks & hit tallies

### 2.1 Rules (pinned)

- Grades from the shared `grade()` above. Tallied per window and per session:
  `perfect / good / off / missed / ghosts / doubles`.
- **Streak** = consecutive *scored* hits graded perfect or good. Reset to 0 by: `off`, `missed`,
  `ghost`, `double`. Count-in hits don't count and don't reset. `extra` doesn't reset (it's almost
  always pipeline noise, not playing).
- Track `bestStreak` per session. No score multipliers, no points — tallies and streak only. The six
  scores remain the measurement; this layer is motivation.

### 2.2 UI

- Streak counter on the highway (top-right), format `×23`; brief scale-pulse on each perfect;
  turns grey momentarily on reset showing what broke it ("×0 — ghost").
- Tally chips under the scores row: `● 41 perfect · 12 good · 3 off · 1 miss`.
- Summary + `SessionRecord.summary` gain `{ tallies, bestStreak }`; history rows show best streak.

### 2.3 Acceptance

Unit test: scripted dev/miss/ghost stream produces exact expected tallies, streak resets, and
bestStreak. Highway pulse verified by eye.

Touch: `src/scoring.js` (grade + streak reducer), `src/ui/highway.js` (counter),
`src/ui/panels.js` (chips, summary, history), `src/main.js` (wiring), `tests/streak.test.mjs`.

---

## 3. Take replay (hear the last bars)

### 3.1 Design (pinned)

- The worklet already has every raw channel-0 sample; it additionally posts each 128-frame block's
  raw samples (transferable `Float32Array`) tagged with its absolute start frame. Cost ≈ 190 KB/s —
  negligible on a MessagePort.
- Main thread keeps a **30 s ring buffer** (`Float32Array`, ~5.8 MB at 48 kHz) with absolute frame
  indexing. Cleared on session start/end; never persisted (v1).
- Replay a range: slice `[tStart, tEnd)` → frames via `t × sampleRate`, copy into an `AudioBuffer`,
  play through `destination`. Overlay clicks: schedule the existing synth click at every grid event
  time that falls inside the range, offset to the buffer's start — both the take and the clicks are
  on the audio clock, so alignment is inherent (input latency shifts the take by the constant
  calibration offset; apply `latencyCompMs` to the slice start so the click lands where scoring
  said it did).
- This is the one place recorded input reaches `destination`. It plays only while `paused`/`ended` —
  never during a live take, so the "never monitor live input" rule stands.

### 3.2 UI

- Review grid: tapping a row selects it; a ▶ button in the readout bar plays that loop (+click).
  Rows older than the 30 s buffer show ▶ disabled.
- While paused: "Replay last 8 bars" button above the review grid.
- A small progress line sweeps the played row during playback.

### 3.3 Acceptance

1. Loopback or real take: replayed bar's plucks audibly align with overlaid clicks (constant-offset
   correct via `latencyCompMs`).
2. Slice boundary error ≤ one render quantum (128 frames ≈ 2.7 ms).
3. 10-minute session: memory stays flat (ring reuse, no growth), UI stays responsive.

Touch: `src/audio/worklet.js` (post raw blocks — additive, no detector change),
`src/main.js` (ring buffer, slice/playback), `src/ui/review.js` (row select, ▶, sweep),
`src/audio/synth.js` (reuse click), `index.html`.

Note: this adds a per-block transfer to the worklet message path. The detector and its validation are
untouched; `?dev=analyze` results cannot change.

---

## 4. Per-slot heatmap over history

### 4.1 Data (pinned)

Per-hit rows are only kept for the last 20 sessions, so the heatmap reads a compact aggregate stored
in **every** summary at save time:

```ts
Summary += { perSlot: Array<{ n: number; meanDev: number; jitter: number;
                              missRate: number; ghostRate: number; peakMean: number }> }
// indexed by slot.index within the pattern loop; in sequence sessions, one perSlot per distinct pattern,
// keyed by pattern string: perSlotByPattern: Record<string, PerSlot[]>
```

Size: ~40 numbers per pattern per session — negligible.

### 4.2 View

History → tap a pattern → heatmap panel:

- Columns = slot index (rendered with the pattern's finger dots as the column header, rests hatched).
- Rows = sessions, newest first, plus a bold **all-time** aggregate row on top.
- Cell color: green→red scale on the selected metric; metric toggle: `|meanDev|` / `jitter` /
  `missRate` (+ `ghostRate` shown only on rest columns).
- Callout line above the grid, computed from the aggregate row:
  "problem slot: 4 (index) — 18% missed across 12 sessions".
- Canvas, same virtualization approach as the review grid; tap a cell for exact numbers.

### 4.3 Acceptance

1. Seed synthetic sessions with one planted bad slot → hot column in every metric it should affect,
   cool elsewhere; callout names the right slot and finger.
2. Metric toggle re-colors without re-reading IndexedDB.
3. Old sessions without `perSlot` render as blank rows (no crash, no fake zeros).

Touch: `src/scoring.js` (perSlot aggregation in summarize), `src/main.js` (store on save),
`src/ui/panels.js` or new `src/ui/heatmap.js` (view), `index.html`, `tests/heatmap.test.mjs`
(aggregation math).

---

## Out of scope for v1.2 (explicitly)

- Mixed subdivision *within one pattern* (still v2; sequences change subdivision only at boundaries).
- Persisting audio takes with sessions.
- Points/multiplier scoring beyond streak & tallies.
- Swing applied to the grid (A4 stands: grooves never move slot times).

## Dependencies / order recap

1. `grade()` extraction (shared).
2. §2 streaks — small, no scheduler changes.
3. §1 sequence mode — scheduler `setGridAt` + driver + UI; largest piece.
4. §3 take replay — worklet additive change + main-thread ring.
5. §4 heatmap — pure data + one view; do anytime after `perSlot` lands in summaries (add the
   aggregation early so data accumulates while the view is being built).
