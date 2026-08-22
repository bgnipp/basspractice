# Pluck Trainer

Local context for agents working on this product.

## What this is

A browser app for practicing Les Claypool-style three-finger (ring–middle–index) bass plucking rolls on a single string. It listens to a bass DI through a USB interface (iPad/iPhone Safari or desktop), generates its own metronome/drum grid, and scores every pluck against that grid in real time.

## Canonical docs

| File | Role |
|---|---|
| [`docs/PLUCK-TRAINER.md`](docs/PLUCK-TRAINER.md) | Full product + technical specification (Part A) plus a pinned implementation Appendix (A1–A7). Read Part A first, then the Appendix; **the Appendix wins on any conflict**. |
| [`ref/rmi_analyzer.py`](ref/rmi_analyzer.py) | Ground-truth DSP. Do not modify without re-validating §12. |
| [`ref/make_test.py`](ref/make_test.py) | Synthetic test WAV generator. |
| [`.cursor/rules/pluck-trainer.mdc`](.cursor/rules/pluck-trainer.mdc) | Always-on agent constraints. |

## Reading order (spec §0)

1. Goals and non-goals (§1)
2. Pattern grammar (§3)
3. Audio architecture / single-clock rule (§5)
4. Onset detector (§6)
5. Scoring (§8)
6. UI (§9)
7. Milestones (§11)

## Implementation status

- [x] Spec persisted; `ref/` created verbatim
- [x] Spec reviewed and amended (2026-08-22): §12 validation now median-offset-corrected; dev analyze-file preprocessing specified; channel-0 input; HTTPS requirement; M0 exit criteria; `cycle` metadata for leakage
- [x] **M0–M5 implemented** (2026-08-22) — vanilla static app in `index.html` + `src/`. iPad/M0 hardware exit (`track.getSettings()`, AGC, iRig select) still needs a real device. M2 WAV harness is at `?dev=analyze`.
- [ ] **M0 device check** — confirm voice processing off on iPad + iRig
- [ ] **M2 WAV check** — `test_bad_ring.wav` vs `rmi_analyzer.py --csv` in `?dev=analyze`

Start at **M0**. Do not begin scoring (M3) until M2 matches the Python reference on the same WAV (§12).

## Decisions already made (§15 + review)

1. Vanilla JS + Canvas for M0–M3 (React optional later).
2. Spectral centroid on the main thread from a posted 40 ms buffer.
3. Beat clock shows one beat first; concentric pattern-ring is M4+ if 3-vs-4 drills need it.
4. Web app for v1, not native iOS. Native's only decisive advantage (guaranteed no voice processing via `AVAudioSession .measurement`) is testable in M0; input latency doesn't matter because calibration (§7.4) removes constant offsets. Fallback if M0 fails: Capacitor + native audio-input plugin feeding the same JS DSP. Full Swift wrapper stays on the v2 roadmap for Apple Watch haptics.
5. No bundler for M0–M3: plain static ES modules deployed to Vercel; worklet via same-origin `addModule`, not a Blob URL (Appendix A1). Single-file Vite build is an M5 task.
6. Filter coefficients, detector pseudocode, matching bookkeeping, and per-milestone acceptance checks are pinned in Appendix A2–A6 — implement them as written, do not redesign.

## Reference DSP

```
pip install librosa soundfile scipy
python ref/make_test.py
python ref/rmi_analyzer.py test_bad_ring.wav --bpm 80 --subdiv 3 --offset 0.5 --csv ref_notes.csv
```

Expect 48/48 onsets, 0 missed, 0 double-triggers; ring ≈ +13 ms and ≈ 3.2 dB under index; diagnosis “ring is the weak finger”.
