import { detectOnsetsOffline, noteFeaturesOffline, peakNormalize } from "../src/audio/dsp.js";

const sr = 48000;
const bpm = 80;
const subdiv = 3;
const step = 60 / bpm / subdiv;
const nNotes = 48;
const f0 = 55;
let seed = 1;
function rnd() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}
function nrm() {
  const u = rnd() || 1e-9;
  const v = rnd() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pluck(dur, amp, bright) {
  const n = Math.floor(dur * sr);
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += (1 / h) * Math.sin(2 * Math.PI * f0 * h * t) * Math.exp(-t * (2 + 0.8 * h));
    const click = nrm() * Math.exp(-t * 600) * bright;
    const env = Math.min(1, t / 0.002);
    sig[i] = amp * env * (s + click);
  }
  return sig;
}

const total = Math.floor((nNotes * step + 1.5) * sr);
const y = new Float32Array(total);
const cycle = ["r", "m", "i"];
for (let n = 0; n < nNotes; n++) {
  const fg = cycle[n % 3];
  let amp = 1, late = 0, bright = 0.25;
  if (fg === "r") { amp = 0.7; late = 0.015; bright = 0.12; }
  amp *= 1 + nrm() * 0.04;
  late += nrm() * 0.003;
  const start = Math.floor((0.5 + n * step + late) * sr);
  const p = pluck(step * 1.2, amp, bright);
  for (let i = 0; i < p.length && start + i < total; i++) y[start + i] += p[i];
}
const yn = peakNormalize(y);
const onsets = detectOnsetsOffline(yn, sr, 0.5 * step, 0.15);
const feats = noteFeaturesOffline(yn, sr, onsets);
console.log("onsets", onsets.length, "feats", feats.length);
if (onsets.length < 44 || onsets.length > 52) {
  console.error("unexpected onset count");
  process.exit(1);
}
const byFg = { r: [], m: [], i: [] };
feats.forEach((f, i) => {
  const slot = Math.round((f.onset_s - 0.5) / step);
  byFg[cycle[((slot % 3) + 3) % 3]].push(f);
});
const meanP = (a) => a.reduce((s, f) => s + f.peak, 0) / a.length;
const meanD = (a) => a.reduce((s, f) => s + (f.onset_s - 0.5 - Math.round((f.onset_s - 0.5) / step) * step) * 1000, 0) / a.length;
console.log("peaks", { r: meanP(byFg.r).toFixed(3), m: meanP(byFg.m).toFixed(3), i: meanP(byFg.i).toFixed(3) });
console.log("mean ms", { r: meanD(byFg.r).toFixed(1), m: meanD(byFg.m).toFixed(1), i: meanD(byFg.i).toFixed(1) });
if (meanP(byFg.r) >= meanP(byFg.i)) {
  console.error("ring should be quieter than index");
  process.exit(1);
}
console.log("offline detect sanity: PASS");
