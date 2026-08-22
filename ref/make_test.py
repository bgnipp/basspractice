"""Generate a fake bass DI: 80 BPM triplets, r-m-i, with a deliberately bad ring finger."""
import numpy as np, soundfile as sf

sr = 48000
bpm, subdiv = 80, 3
step = 60 / bpm / subdiv
n_notes = 48
f0 = 55.0  # low A
rng = np.random.default_rng(1)

def pluck(dur, amp, bright, sr=sr):
    t = np.arange(int(dur * sr)) / sr
    # a few harmonics with a fast-decaying bright transient
    sig = np.zeros_like(t)
    for h in range(1, 9):
        sig += (1 / h) * np.sin(2 * np.pi * f0 * h * t) * np.exp(-t * (2 + 0.8 * h))
    click = rng.standard_normal(len(t)) * np.exp(-t * 600) * bright
    env = np.minimum(1, t / 0.002)  # 2 ms attack
    return amp * env * (sig + click)

total = int((n_notes * step + 1.5) * sr)
y = np.zeros(total)
cycle = ["r", "m", "i"]
for n in range(n_notes):
    fg = cycle[n % 3]
    amp, late, bright = 1.0, 0.0, 0.25
    if fg == "r":
        amp, late, bright = 0.7, 0.015, 0.12   # -3 dB, 15 ms late, darker
    amp *= 1 + rng.normal(0, 0.04)
    late += rng.normal(0, 0.003)
    start = int((0.5 + n * step + late) * sr)
    p = pluck(step * 1.2, amp, bright)
    y[start:start + len(p)] += p[: total - start]
y /= np.max(np.abs(y)) * 1.1
sf.write("test_bad_ring.wav", y, sr)
print("wrote test_bad_ring.wav")
