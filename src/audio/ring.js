const RING_SEC = 30;

export function createTakeRing(sampleRate, seconds = RING_SEC) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const buf = new Float32Array(n);
  let writeAbs = 0;
  let primed = false;

  return {
    write(startFrame, samples) {
      if (!samples || !samples.length) return;
      if (!primed) {
        writeAbs = startFrame;
        primed = true;
      }
      for (let i = 0; i < samples.length; i++) {
        buf[(startFrame + i) % n] = samples[i];
      }
      writeAbs = startFrame + samples.length;
    },
    sliceFrames(f0, f1) {
      const oldest = writeAbs - n;
      if (f1 <= f0) return null;
      const out = new Float32Array(f1 - f0);
      const start = Math.max(f0, oldest);
      if (start >= f1) return null;
      for (let f = start; f < f1; f++) out[f - f0] = buf[((f % n) + n) % n];
      return { samples: out, clipped: f0 < oldest, oldest };
    },
    oldestFrame() {
      return Math.max(0, writeAbs - n);
    },
    newestFrame() {
      return writeAbs;
    },
    reset() {
      buf.fill(0);
      writeAbs = 0;
      primed = false;
    },
    sampleRate,
    capacity: n,
  };
}

export function framesForRange(tStart, tEnd, sampleRate, latencySec = 0) {
  const f0 = Math.round((tStart + latencySec) * sampleRate);
  const f1 = Math.round((tEnd + latencySec) * sampleRate);
  return { f0, f1 };
}
