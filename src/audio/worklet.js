/**
 * Onset-detector AudioWorkletProcessor.
 * Standalone file — no imports. Coefficients and scan from spec Appendix A2/A3.
 */
class OnsetDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.HOP = 32;
    this.WIN = 256;
    this.lookAheadHops = Math.ceil(0.008 * this.sr / this.HOP);
    this.maxWalkbackHops = Math.ceil(0.016 * this.sr / this.HOP);
    this.RING = 128;
    this.envRing = new Float32Array(this.RING);
    this.hopIdx = -1;
    this.scanFrom = 0;
    this.envMax = 1e-4;
    this.minGapHops = Math.max(1, Math.round(0.05 * this.sr / this.HOP));
    this.relThr = 0.15;

    this.bq = [
      makeHpBiquad(this.sr, 1000, 0.54119610),
      makeHpBiquad(this.sr, 1000, 1.30656296),
    ];

    this.winSq = new Float32Array(this.WIN);
    this.winPos = 0;
    this.sumSq = 0;
    this.hopFill = 0;

    this.rawLen = 8192;
    this.raw = new Float32Array(this.rawLen);
    this.rawPos = 0;
    this.rawFilled = 0;
    this.samplesSeen = 0;
    this.streamStartFrame = null;

    this.pending = [];
    this.blockCount = 0;
    this.attSamples = Math.round(0.040 * this.sr);

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "config") {
        if (m.minGapS != null) {
          const clamped = Math.min(0.15, Math.max(0.02, m.minGapS));
          this.minGapHops = Math.max(1, Math.round(clamped * this.sr / this.HOP));
        }
        if (m.relThr != null) this.relThr = m.relThr;
      }
    };
  }

  envAt(h) {
    return this.envRing[((h % this.RING) + this.RING) % this.RING];
  }

  rawAt(localIndex) {
    const age = this.samplesSeen - 1 - localIndex;
    return this.raw[((this.rawPos - 1 - age) % this.rawLen + this.rawLen) % this.rawLen];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const ch0 = input[0];
    if (this.streamStartFrame == null) this.streamStartFrame = currentFrame;

    const onsets = [];
    const transfers = [];

    for (let i = 0; i < ch0.length; i++) {
      const x = ch0[i];
      this.raw[this.rawPos] = x;
      this.rawPos = (this.rawPos + 1) % this.rawLen;
      if (this.rawFilled < this.rawLen) this.rawFilled++;
      this.samplesSeen++;

      let y = x;
      for (let b = 0; b < this.bq.length; b++) y = this.bq[b].tick(y);

      const sq = y * y;
      this.sumSq += sq - this.winSq[this.winPos];
      this.winSq[this.winPos] = sq;
      this.winPos = (this.winPos + 1) % this.WIN;
      if (this.sumSq < 0) this.sumSq = 0;

      this.hopFill++;
      if (this.hopFill >= this.HOP) {
        this.hopFill = 0;
        this.hopIdx++;
        const env = Math.sqrt(this.sumSq / this.WIN);
        this.envMax = Math.max(this.envMax * 0.9995, env, 1e-4);
        this.envRing[this.hopIdx % this.RING] = env;

        const d = this.hopIdx - this.lookAheadHops;
        if (d >= 0 && d >= this.scanFrom && envAtSafe(this, d) / this.envMax > this.relThr) {
          let j = d;
          let best = -1;
          const end = d + this.lookAheadHops;
          for (let h = d; h <= end; h++) {
            const v = this.envAt(h);
            if (v > best) {
              best = v;
              j = h;
            }
          }
          let k = j;
          const floor = 0.1 * this.envAt(j);
          while (k > 0 && k > j - this.maxWalkbackHops && this.envAt(k - 1) > floor) k--;
          const onsetFrame = this.streamStartFrame + k * this.HOP;
          this.pending.push({
            frame: onsetFrame,
            readyAt: onsetFrame - this.streamStartFrame + this.attSamples,
          });
          this.scanFrom = j + this.minGapHops;
        }
      }
    }

    const ready = [];
    const still = [];
    for (const p of this.pending) {
      if (this.samplesSeen >= p.readyAt) ready.push(p);
      else still.push(p);
    }
    this.pending = still;

    for (const p of ready) {
      const local = p.frame - this.streamStartFrame;
      const n = this.attSamples;
      const raw40 = new Float32Array(n);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = this.rawAt(local + i);
        raw40[i] = v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v;
      }
      onsets.push({
        frame: p.frame,
        peak,
        rms: Math.sqrt(sum / n),
        raw40,
      });
      transfers.push(raw40.buffer);
    }

    this.blockCount++;
    let meter = null;
    if (this.blockCount % 4 === 0) {
      const n = Math.min(this.rawFilled, Math.round(0.05 * this.sr));
      let s = 0;
      let pk = 0;
      for (let i = 0; i < n; i++) {
        const v = this.raw[((this.rawPos - 1 - i) % this.rawLen + this.rawLen) % this.rawLen];
        s += v * v;
        const a = Math.abs(v);
        if (a > pk) pk = a;
      }
      meter = { rms: n ? Math.sqrt(s / n) : 0, peak: pk };
    }

    const rawBlock = new Float32Array(ch0.length);
    rawBlock.set(ch0);
    transfers.push(rawBlock.buffer);
    this.port.postMessage({
      type: "block",
      onsets,
      meter,
      sampleRate: this.sr,
      raw: rawBlock,
      startFrame: currentFrame,
    }, transfers);
    return true;
  }
}

function envAtSafe(proc, h) {
  return proc.envAt(h);
}

function makeHpBiquad(sr, fc, Q) {
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
  };
}

registerProcessor("onset-detector", OnsetDetectorProcessor);
