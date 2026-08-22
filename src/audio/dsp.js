/** Shared DSP: biquad design, FFT, features, offline detector (A7). */

export const HOP = 32;
export const WIN = 256;

export function makeHpBiquad(sr, fc, Q) {
  const w0 = 2 * Math.PI * fc / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0 = (1 + cw) / 2;
  let b1 = -(1 + cw);
  let b2 = (1 + cw) / 2;
  let a0 = 1 + alpha;
  let a1 = -2 * cw;
  let a2 = 1 - alpha;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let s1 = 0;
  let s2 = 0;
  return {
    tick(x) {
      const y = b0 * x + s1;
      s1 = b1 * x - a1 * y + s2;
      s2 = b2 * x - a2 * y;
      return y;
    },
    reset() {
      s1 = 0;
      s2 = 0;
    },
  };
}

export function highpass1000(y, sr) {
  const bq = [
    makeHpBiquad(sr, 1000, 0.54119610),
    makeHpBiquad(sr, 1000, 1.30656296),
  ];
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) {
    let v = y[i];
    v = bq[0].tick(v);
    v = bq[1].tick(v);
    out[i] = v;
  }
  return out;
}

export function fftRadix2(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = real[i + k];
        const ui = imag[i + k];
        const vr = real[i + k + len / 2] * wr - imag[i + k + len / 2] * wi;
        const vi = real[i + k + len / 2] * wr + imag[i + k + len / 2] * wi;
        real[i + k] = ur + vr;
        imag[i + k] = ui + vi;
        real[i + k + len / 2] = ur - vr;
        imag[i + k + len / 2] = ui - vi;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
}

export function attackFeatures(att, sr) {
  const n = att.length;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(att[i]);
    if (a > peak) peak = a;
    sum += att[i] * att[i];
  }
  const rms = Math.sqrt(sum / n);

  const nfft = 2048;
  const real = new Float64Array(nfft);
  const imag = new Float64Array(nfft);
  const winN = n;
  for (let i = 0; i < winN && i < nfft; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winN - 1 || 1)));
    real[i] = att[i] * w;
  }
  fftRadix2(real, imag);
  const half = nfft / 2 + 1;
  let specSum = 0;
  let freqSum = 0;
  let eTot = 0;
  let eHf = 0;
  for (let i = 0; i < half; i++) {
    const mag = Math.hypot(real[i], imag[i]);
    const freq = i * sr / nfft;
    specSum += mag;
    freqSum += freq * mag;
    const e = mag * mag;
    eTot += e;
    if (freq >= 2000) eHf += e;
  }
  return {
    peak,
    rms,
    centroid: specSum > 0 ? freqSum / specSum : 0,
    hfRatio: eTot > 0 ? eHf / eTot : 0,
  };
}

/** Centered RMS like librosa.feature.rms(..., center=True). */
export function rmsCentered(y, frame = WIN, hop = HOP) {
  const pad = Math.floor(frame / 2);
  const padded = new Float32Array(y.length + 2 * pad);
  padded.set(y, pad);
  const nFrames = 1 + Math.floor(y.length / hop);
  const env = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    let s = 0;
    for (let k = 0; k < frame; k++) {
      const v = padded[start + k] || 0;
      s += v * v;
    }
    env[i] = Math.sqrt(s / frame);
  }
  return env;
}

/**
 * Offline detector: global-max envelope + Python scan (A7).
 * Filter is causal (same coeffs as the worklet); §12 absorbs the constant offset.
 */
export function detectOnsetsOffline(y, sr, minGapS = 0.05, relThr = 0.15) {
  const hf = highpass1000(y, sr);
  const rms = rmsCentered(hf, WIN, HOP);
  let max = 0;
  for (let i = 0; i < rms.length; i++) if (rms[i] > max) max = rms[i];
  const env = new Float32Array(rms.length);
  const denom = max + 1e-12;
  for (let i = 0; i < rms.length; i++) env[i] = rms[i] / denom;
  const thr = Math.max(relThr, 0.02);
  const minGap = Math.max(1, Math.round(minGapS * sr / HOP));
  const look = Math.floor(0.008 * sr / HOP) + 1;
  const onsets = [];
  let i = 0;
  while (i < env.length) {
    if (env[i] > thr) {
      let j = i;
      let best = -1;
      const end = Math.min(env.length, i + look);
      for (let h = i; h < end; h++) {
        if (env[h] > best) {
          best = env[h];
          j = h;
        }
      }
      let k = j;
      while (k > 0 && env[k - 1] > 0.1 * env[j]) k--;
      onsets.push(k * HOP);
      i = j + minGap;
    } else {
      i++;
    }
  }
  return onsets;
}

export function noteFeaturesOffline(y, sr, onsets) {
  const feats = [];
  const attN = Math.round(0.040 * sr);
  for (let n = 0; n < onsets.length; n++) {
    const o = onsets[n];
    const nxt = n + 1 < onsets.length ? onsets[n + 1] : y.length;
    const segLen = nxt - o;
    if (segLen < 256) continue;
    const att = y.subarray(o, Math.min(y.length, o + attN));
    const f = attackFeatures(att, sr);
    feats.push({
      onset_s: o / sr,
      peak: f.peak,
      rms: f.rms,
      centroid: f.centroid,
      hfRatio: f.hfRatio,
    });
  }
  return feats;
}

export function peakNormalize(y) {
  let m = 0;
  for (let i = 0; i < y.length; i++) {
    const a = Math.abs(y[i]);
    if (a > m) m = a;
  }
  if (m < 1e-12) return y;
  const out = new Float32Array(y.length);
  const g = 1 / m;
  for (let i = 0; i < y.length; i++) out[i] = y[i] * g;
  return out;
}

export function dbfs(x) {
  return 20 * Math.log10(Math.max(x, 1e-12));
}
