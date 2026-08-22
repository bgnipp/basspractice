import { createTakeRing, framesForRange } from "../src/audio/ring.js";

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}

const sr = 48000;
const ring = createTakeRing(sr, 1);
const block = new Float32Array(128);
for (let i = 0; i < 128; i++) block[i] = i + 1;
ring.write(0, block);
ring.write(128, block);

const { f0, f1 } = framesForRange(0, 128 / sr, sr, 0);
assert(f1 - f0 === 128, `slice length ${f1 - f0} !== 128`);
const sl = ring.sliceFrames(f0, f1);
assert(sl && sl.samples[0] === 1 && sl.samples[127] === 128, "first block contents");

const lat = 0.01;
const ranged = framesForRange(0, 0.1, sr, lat);
assert(ranged.f0 === Math.round(0.01 * sr), "latency applied to slice start");

const quantum = 128;
assert(Math.abs((f1 - f0) - 128) <= quantum, "boundary error within one render quantum");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("replay tests: PASS");
