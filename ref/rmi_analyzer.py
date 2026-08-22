#!/usr/bin/env python3
"""
rmi_analyzer.py — analyze a bass DI recording of three-finger (ring-middle-index)
plucking against a metronome grid.

Usage:
    python rmi_analyzer.py take.wav --bpm 80 --subdiv 3            # triplets, r-m-i
    python rmi_analyzer.py take.wav --bpm 80 --subdiv 4            # 16ths, r-m-i rotating
    python rmi_analyzer.py take.wav --bpm 80 --subdiv 3 --fingers r,m,i,m   # custom cycle
    python rmi_analyzer.py take.wav --bpm 80 --subdiv 3 --offset 0.512      # first note at 0.512 s

Reports, per finger and overall:
    timing   - mean offset from grid (ms, + = late) and jitter (std dev)
    attack   - peak level per pluck, and how much it varies (coefficient of variation)
    tone     - spectral centroid of the first 40 ms of each pluck (brightness)
    decay    - time for the note to drop 20 dB (muting / ring-out)
    score    - 0-100 per category, no single "Claypool number" because that would be lying

Record a clean DI (Quad Cortex USB out, no amp sim) at any sample rate. Mono or stereo.
"""
import argparse
import sys
import numpy as np
import librosa
import soundfile as sf

FINGER_NAMES = {"r": "ring", "m": "middle", "i": "index", "t": "thumb", "p": "pinky"}


# ---------------------------------------------------------------- onset detection
def detect_onsets(y, sr, min_gap_s=0.05, rel_thr=0.15):
    """
    Detect plucks on a high-passed copy of the signal: the attack transient has
    energy above ~1 kHz, the ringing fundamental doesn't, so the sustain can't
    retrigger. min_gap_s should be ~half the grid step. Returns sample indices.
    """
    from scipy.signal import butter, sosfiltfilt
    sos = butter(4, 1000, btype="high", fs=sr, output="sos")
    hf = sosfiltfilt(sos, y)
    hop, frame = 32, 256
    rms = librosa.feature.rms(y=hf, frame_length=frame, hop_length=hop, center=True)[0]
    env = rms / (rms.max() + 1e-12)
    thr = max(rel_thr, 0.02)
    min_gap = int(min_gap_s * sr / hop)
    onsets, i = [], 0
    while i < len(env):
        if env[i] > thr:
            # local peak within 8 ms, then walk back to where the burst starts
            j = i + int(np.argmax(env[i:i + int(0.008 * sr / hop) + 1]))
            k = j
            while k > 0 and env[k - 1] > 0.1 * env[j]:
                k -= 1
            onsets.append(k * hop)
            i = j + min_gap
        else:
            i += 1
    return np.array(onsets, dtype=int)


# ---------------------------------------------------------------- per-note features
def note_features(y, sr, onsets):
    feats = []
    for n, o in enumerate(onsets):
        nxt = onsets[n + 1] if n + 1 < len(onsets) else len(y)
        seg = y[o:nxt]
        if len(seg) < 256:
            continue
        att = seg[: int(0.040 * sr)]  # first 40 ms
        peak = float(np.max(np.abs(att)))
        rms = float(np.sqrt(np.mean(att ** 2)))
        # spectral centroid of attack window (brightness)
        spec = np.abs(np.fft.rfft(att * np.hanning(len(att))))
        freqs = np.fft.rfftfreq(len(att), 1 / sr)
        centroid = float(np.sum(freqs * spec) / (np.sum(spec) + 1e-12))
        # decay: time to fall 20 dB below the attack peak (env in 5 ms blocks)
        blk = int(0.005 * sr)
        nb = len(seg) // blk
        if nb >= 2:
            env = np.array([np.sqrt(np.mean(seg[i * blk:(i + 1) * blk] ** 2)) for i in range(nb)])
            env_db = 20 * np.log10(env / (env.max() + 1e-12) + 1e-12)
            below = np.where(env_db < -20)[0]
            decay_ms = float(below[0] * 5) if len(below) else float(nb * 5)
        else:
            decay_ms = 0.0
        feats.append(dict(onset_s=o / sr, peak=peak, rms=rms, centroid=centroid, decay_ms=decay_ms))
    return feats


# ---------------------------------------------------------------- grid alignment
def align_to_grid(feats, bpm, subdiv, offset=None):
    """
    Snap each onset to the nearest grid slot. If offset is None, the first onset
    defines the grid (the player starts on a downbeat). Returns per-note grid
    deviation in ms and the slot index (used for finger assignment).
    """
    step = 60.0 / bpm / subdiv
    t = np.array([f["onset_s"] for f in feats])
    if offset is None:
        offset = t[0]
    rel = t - offset
    slot = np.round(rel / step).astype(int)
    dev_ms = (rel - slot * step) * 1000.0
    for f, s, d in zip(feats, slot, dev_ms):
        f["slot"] = int(s)
        f["dev_ms"] = float(d)
    # flag gaps / extras
    expected = set(range(0, slot.max() + 1))
    played = set(slot.tolist())
    missed = sorted(expected - played)
    dupes = [s for s in played if list(slot).count(s) > 1]
    return step, missed, dupes


def assign_fingers(feats, cycle):
    for f in feats:
        f["finger"] = cycle[f["slot"] % len(cycle)]


# ---------------------------------------------------------------- scoring
def clamp_score(value, good, bad):
    """Linear 100 at `good`, 0 at `bad`."""
    if bad == good:
        return 100.0
    s = (bad - value) / (bad - good) * 100.0
    return float(np.clip(s, 0, 100))


def summarize(feats, cycle, step):
    out = {}
    groups = {"all": feats}
    for fg in dict.fromkeys(cycle):
        groups[fg] = [f for f in feats if f["finger"] == fg]

    for name, g in groups.items():
        if not g:
            continue
        dev = np.array([f["dev_ms"] for f in g])
        peak = np.array([f["peak"] for f in g])
        cen = np.array([f["centroid"] for f in g])
        dec = np.array([f["decay_ms"] for f in g])
        out[name] = dict(
            n=len(g),
            mean_dev=dev.mean(),
            jitter=dev.std(),
            peak_mean=peak.mean(),
            peak_cv=peak.std() / (peak.mean() + 1e-12),
            centroid_mean=cen.mean(),
            centroid_cv=cen.std() / (cen.mean() + 1e-12),
            decay_mean=dec.mean(),
        )

    a = out["all"]
    # Cross-finger balance: how far each finger's mean peak / centroid / timing sits from the others
    fingers = [k for k in out if k != "all"]
    peak_means = np.array([out[k]["peak_mean"] for k in fingers])
    cen_means = np.array([out[k]["centroid_mean"] for k in fingers])
    dev_means = np.array([out[k]["mean_dev"] for k in fingers])
    balance = dict(
        peak_spread_db=float(20 * np.log10(peak_means.max() / (peak_means.min() + 1e-12))),
        centroid_spread_pct=float((cen_means.max() - cen_means.min()) / (cen_means.mean() + 1e-12) * 100),
        timing_spread_ms=float(dev_means.max() - dev_means.min()),
    )
    grid_ms = step * 1000
    scores = dict(
        timing=clamp_score(a["jitter"], good=0.04 * grid_ms, bad=0.25 * grid_ms),
        attack_even=clamp_score(a["peak_cv"] * 100, good=6, bad=30),
        tone_even=clamp_score(a["centroid_cv"] * 100, good=5, bad=25),
        finger_balance=clamp_score(balance["peak_spread_db"], good=1.0, bad=6.0),
    )
    return out, balance, scores


# ---------------------------------------------------------------- report
def report(feats, out, balance, scores, step, missed, dupes, bpm, subdiv, cycle):
    fn = lambda k: FINGER_NAMES.get(k, k)
    print(f"\n=== {bpm} BPM, {subdiv} per beat (grid {step*1000:.1f} ms), cycle {'-'.join(cycle)} ===")
    print(f"notes detected: {len(feats)}   missed slots: {len(missed)}   double-triggers: {len(dupes)}")
    print("\n{:<8} {:>4} {:>9} {:>8} {:>9} {:>8} {:>9} {:>8}".format(
        "finger", "n", "mean ms", "jitter", "peak", "peak cv", "centroid", "decay"))
    for k, v in out.items():
        print("{:<8} {:>4} {:>+9.1f} {:>8.1f} {:>9.3f} {:>7.0f}% {:>8.0f}Hz {:>6.0f}ms".format(
            fn(k), v["n"], v["mean_dev"], v["jitter"], v["peak_mean"],
            v["peak_cv"] * 100, v["centroid_mean"], v["decay_mean"]))
    print("\nbalance between fingers:")
    print(f"  loudest vs. quietest finger:  {balance['peak_spread_db']:.1f} dB")
    print(f"  brightest vs. darkest finger: {balance['centroid_spread_pct']:.0f}% centroid spread")
    print(f"  earliest vs. latest finger:   {balance['timing_spread_ms']:.1f} ms")
    print("\nscores (0-100):")
    for k, v in scores.items():
        bar = "#" * int(v / 5)
        print(f"  {k:<15} {v:5.0f}  {bar}")

    # plain-language diagnosis
    print("\ndiagnosis:")
    fingers = [k for k in out if k != "all"]
    if fingers:
        quiet = min(fingers, key=lambda k: out[k]["peak_mean"])
        late = max(fingers, key=lambda k: out[k]["mean_dev"])
        if balance["peak_spread_db"] > 2.0:
            print(f"  - {fn(quiet)} is the weak finger ({balance['peak_spread_db']:.1f} dB under the strongest)")
        if balance["timing_spread_ms"] > 0.05 * step * 1000:
            print(f"  - {fn(late)} lands late relative to the others ({out[late]['mean_dev']:+.1f} ms)")
        if out["all"]["mean_dev"] > 0.1 * step * 1000:
            print("  - dragging overall; you're behind the click")
        elif out["all"]["mean_dev"] < -0.1 * step * 1000:
            print("  - rushing overall; you're ahead of the click")
    if subdiv % len(cycle) != 0:
        # e.g. 16ths with a 3-finger cycle: check whether accents leak onto the cycle start
        r = out.get(cycle[0])
        if r and r["peak_mean"] > 1.15 * out["all"]["peak_mean"]:
            name = {2: "8ths", 3: "triplets", 4: "16ths", 6: "sextuplets"}.get(subdiv, f"{subdiv}s per beat")
            print(f"  - you're accenting every {fn(cycle[0])} — sounds like triplets, not {name}")
    if missed:
        print(f"  - missed grid slots at: {missed[:10]}{' ...' if len(missed) > 10 else ''}")
    if not any([balance["peak_spread_db"] > 2.0, balance["timing_spread_ms"] > 0.05 * step * 1000, missed]):
        print("  - clean. bump the tempo.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--subdiv", type=int, default=3, help="notes per beat (3=triplets, 4=16ths)")
    ap.add_argument("--fingers", default="r,m,i", help="plucking cycle, e.g. r,m,i or r,m,i,m")
    ap.add_argument("--offset", type=float, default=None, help="time (s) of first grid note; default = first onset")
    ap.add_argument("--csv", default=None, help="write per-note table to this CSV")
    args = ap.parse_args()

    y, sr = sf.read(args.wav, always_2d=True)
    y = y[:, 0].astype(np.float32)
    y = y / (np.max(np.abs(y)) + 1e-12)

    cycle = [c.strip() for c in args.fingers.split(",")]
    step_s = 60.0 / args.bpm / args.subdiv
    onsets = detect_onsets(y, sr, min_gap_s=0.5 * step_s)
    if len(onsets) < 4:
        sys.exit(f"only {len(onsets)} onsets found — is the file a clean DI?")
    feats = note_features(y, sr, onsets)
    step, missed, dupes = align_to_grid(feats, args.bpm, args.subdiv, args.offset)
    assign_fingers(feats, cycle)
    out, balance, scores = summarize(feats, cycle, step)
    report(feats, out, balance, scores, step, missed, dupes, args.bpm, args.subdiv, cycle)

    if args.csv:
        import csv
        with open(args.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(feats[0].keys()))
            w.writeheader()
            w.writerows(feats)
        print(f"\nper-note table -> {args.csv}")


if __name__ == "__main__":
    main()
