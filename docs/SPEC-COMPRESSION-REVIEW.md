# Tech spec — Compression profile & Review grid view

Status: approved for implementation. Extends `docs/PLUCK-TRAINER.md` (does not change anything pinned
there; §8 scoring inputs gain a parallel "heard" variant, and the UI gains one new panel). Same
tolerances and conventions as the main spec.

---

## 1. Compression profile ("heard" scores)

### 1.1 Problem

The player performs through heavy compression (Quad Cortex / pedal). Compression squashes loud notes
toward quiet ones, so raw-DI attack unevenness overstates what a listener hears. Two scores are
affected: `attackEven` (peakCV) and `fingerBalance` (peakSpreadDb). Timing, cleanliness, tone, and
accent detection are unaffected and stay raw.

Compression also *amplifies* ghosts: a quiet brush on a rest gets pulled up toward note level. A
compression-aware mode must therefore surface ghosts more aggressively, not less.

### 1.2 Model

Static gain-reduction curve applied per note, in the dB domain, to the already-extracted 40 ms peak.
No audio-path processing; this is arithmetic on existing features.

```
peakDb    = 20 * log10(peak)
overDb    = max(0, peakDb - thresholdDb)
heardDb   = peakDb - overDb * (1 - 1/ratio)
heardPeak = 10^(heardDb / 20)
```

- `ratio` ∈ {1, 2, 4, 8}. 1 = off (feature disabled, `heardPeak === peak`).
- `thresholdDb` is automatic: **median of the last 16 scored, non-accent hit peaks (in dB) minus 6 dB.**
  Keep a 16-slot ring of hit peaks in the scorer; median computed on demand (16 elements, trivial).
- Warm-up: with fewer than 4 hits in the ring, compression is inactive (`heardPeak = peak`).
- Attack-time behaviour is intentionally not modelled in v1 (our peak is a 40 ms max; a fast-attack
  compressor is the assumed reference). If a slow-attack model is ever wanted, it is a new spec.

### 1.3 Scoring changes

Compute the two affected stats twice per window and per session:

| score | raw input (unchanged) | heard input (new) |
|---|---|---|
| attackEven | `peakCV` over `peak` | `peakCVHeard` over `heardPeak` |
| fingerBalance | `peakSpreadDb` over per-finger `peakMean` | `peakSpreadDbHeard` over per-finger `heardPeak` means |

Good/bad bands are identical for raw and heard (the compressor changes the input, not the standard).

Everything else stays raw, explicitly including:
- accent detection (`accentRatio` × rolling non-accent mean) — whether *you* played the accent is a
  hands question;
- the ramp "clean block" gate (raw `attackEven`) — the trainer should not let the virtual pedal earn
  tempo increases;
- `peakRoll` dot sizing on the beat clock (raw).

**Compressor dependence** (derived, displayed only): `dependence = heardScore - rawScore` for
attackEven, clamped ≥ 0. A shrinking dependence over sessions means the hands are catching up with
the pedal.

### 1.4 Diagnosis changes (only when `ratio > 1`)

- If `ghosts ≥ 2` in the window, insert at **priority 1**:
  `"ghosts will be loud through your comp: <n> in last 8 bars"` (this outranks the existing clean<60
  gate; ghosts matter at any clean score when compressed).
- Replace the weak-finger line when the comp hides the problem: if raw `peakSpreadDb > 2` but heard
  `< 1`, emit `"<finger> is weak raw (−x.x dB) — your comp hides it (−y.y dB heard)"` instead of the
  standard line. If heard spread is also `> 2`, keep the standard line (the comp isn't saving you).
- Max 3 lines total, as before.

### 1.5 UI

- **Settings**: "Compression" select — `off / 2:1 / 4:1 / 8:1 (squish)`. Persisted in settings and in
  `SessionConfig.compression = { ratio }`.
- **Scores row**: when active, attackEven and fingerBalance render as `raw → heard` (e.g. `54 → 86`),
  bar length driven by the raw value, the heard value as a lighter marker on the same track. When off,
  render exactly as today.
- **Summary modal**: both values in the table; one line
  `compression 8:1 · dependence +32 · threshold −18.4 dBFS`.
- **CSV export**: add `heardPeak` column (equals `peak` when off).

### 1.6 Data model

```ts
SessionConfig += { compression: { ratio: 1|2|4|8 } }
HitRecord     += { heardPeak: number }          // computed at match time, frozen thereafter
Summary       += { scoresHeard?: { attackEven, fingerBalance }, compression?: { ratio, thresholdDb } }
```

`heardPeak` is frozen at match time with the threshold as of that moment (do not retroactively
recompute when the median moves; live UI must be stable).

### 1.7 Acceptance checks

1. Unit: peaks with exactly 3 dB spread, all above threshold, ratio 8 → heard spread = 0.375 dB
   (spread scales by 1/ratio when all notes are above threshold).
2. Unit: warm-up — first 3 hits have `heardPeak === peak`.
3. Synthetic bad-ring take (ring −3 dB): raw fingerBalance flags ring; at 8:1 heard spread < 0.5 dB
   and the "comp hides it" diagnosis line appears.
4. Ghost line appears with ≥ 2 ghosts even when `clean` score is > 60.
5. Ramp gating unchanged by ratio (verify a ramp held with bad raw attackEven at 8:1).

---

## 2. Review grid view (post-pause timeline)

### 2.1 Problem

Live dots fade after ~4 beats; there is no way to study a run afterwards. Add a review view shown when
the session is paused or ended: every onset of the session against grid lines, so the player can see
where each pluck fell relative to where it should have been.

### 2.2 Layout: wrapped bars (one pattern loop per row)

Not a linear scroll — a **wrap view**: each row is one pattern loop, columns are the loop's slots
(`patternLength × slotsPerBeat` columns), newest row at the bottom, scrollable. Because the pattern
repeats, deviations that are systematic per slot/finger line up vertically: a late ring finger reads
as a column of orange dots all sitting right of their grid line. This is the entire point of the view.

Rendering (Canvas, `src/ui/review.js`):

- Vertical grid lines per slot; heavier line at each beat; heaviest at column 0 (bar start).
  Rest columns shaded/hatched as in the lollipop strip.
- Each **hit**: dot at `x = columnCenter + (devMs/1000/gridStep) * columnWidth` (dev of ±½ step spans
  the full column; clamp at column edges), colour by finger, radius by raw peak (normalized to session
  max), accent hits outlined.
- **Ghost**: red hollow dot in the rest column at its dev offset.
- **Missed**: grey ring exactly on the grid line of the missed column.
- **Double**: second marker half-size, slightly below the first.
- Row label on the left: loop number; rows during count-in tinted and labelled "count-in".
- Dropout loops get a dim background band (played unaccompanied — expect more spread there; seeing it
  is the payoff of dropout mode).

### 2.3 Interactions

- Scroll vertically (recent at bottom, auto-scrolled there on open).
- Tap a dot → small readout: finger, devMs, peak (and heardPeak when compression on), centroid.
- A per-column summary strip at the top: mean dev per column as a small tick left/right of the line,
  averaged over all loops — the "where does slot 3 usually land" answer at a glance.
- v1 excludes zoom/pinch and export-as-image.

### 2.4 Data & lifecycle

- Source: `scorer.hits` (full session, already in memory) + missed events. Each record has
  `loop` and `slotIndex`, which map directly to row and column. No new bookkeeping.
- **Pause/resume** (new transport capability, spec §4 lifecycle already names `paused`):
  - "Pause" button next to Stop while running. Pause stops the scheduler wake timer and stops
    scheduling audio; existing `expectedEvents` past `now` are dropped; the review view replaces the
    live clock/strip area.
  - "Resume" re-anchors: one count-in bar (unscored, like session start), then scoring continues
    accumulating into the same session. Implementation: `scheduler.start()` again with the same grid
    at a fresh `sessionStart`, preserving scorer state; loop numbering continues from the next loop
    index so review rows stay ordered.
  - Ended sessions: "Review timeline" button in the summary modal opens the same view read-only.
- Auto-pause on `AudioContext` suspension (already implemented) also shows the review view behind the
  resume overlay.

### 2.5 Rendering budget

Draw only visible rows (virtualized by scroll position); row height ~28 px; a 200-loop session is
~5600 dots total but ≤ ~40 rows drawn per frame. Redraw only on scroll/open/resize — this is a static
view, no rAF loop while visible and paused.

### 2.6 Acceptance checks

1. Synthetic bad-ring session (or WAV replay): ring column dots sit visibly right of their grid lines
   in every row; per-column summary ticks show ring ≈ +13 ms.
2. Gallop with planted extra pluck: red ghost dots appear in the rest column on the correct rows.
3. Pause → review renders instantly; resume → one count-in bar, then rows continue with correct loop
   numbers and no duplicate/missing rows.
4. 100+ loop session scrolls smoothly (virtualized draw).

---

## 3. Touch list

| File | Change |
|---|---|
| `src/scoring.js` | heardPeak at match time, 16-peak median ring, dual attackEven/fingerBalance, diagnosis rules §1.4 |
| `src/main.js` | compression setting plumb-through, pause/resume transport, review view mount/unmount |
| `src/ui/panels.js` | raw→heard score rendering, settings select, summary additions |
| `src/ui/review.js` | new — wrap-view canvas, virtualization, tap readout, per-column summary |
| `src/store.js` | none (SessionConfig/Summary are opaque blobs) |
| `index.html` | Pause button, compression select, review container |
| `tests/` | §1.7 units 1–3 as node tests; §2.6 manual checklist |

Order: §1 first (small, self-contained), then §2. Neither touches the worklet, the detector, or
anything validated against the Python reference.
