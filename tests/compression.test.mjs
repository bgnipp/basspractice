import {
  compressPeak, peakSpreadDb, diagnose, createScorer, clampScore,
} from "../src/scoring.js";

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) fail.push(`${msg}: ${a} ≉ ${b}`);
}

// §1.7.1 — 3 dB spread above threshold at 8:1 → 0.375 dB heard
{
  const loud = 1;
  const quiet = 10 ** (-3 / 20);
  const thr = -20;
  const spread = peakSpreadDb([
    compressPeak(loud, thr, 8),
    compressPeak(quiet, thr, 8),
  ]);
  close(spread, 0.375, 1e-6, "heard spread at 8:1");
}

// §1.7.2 — first 3 hits stay uncompressed (warm-up)
{
  const scorer = createScorer();
  scorer.setRatio(8);
  for (let i = 0; i < 3; i++) {
    const ev = {
      time: i + 1,
      slot: { index: i % 3, finger: ["r", "m", "i"][i % 3], accent: false },
      loop: 0, scored: true, hit: false, ghosts: 0, doubles: 0,
    };
    const rec = scorer.matchOnset(
      { frame: (i + 1) * 48000, peak: 0.4 + i * 0.1, rms: 0.2, centroid: 800 },
      [ev], 0.25, 0, 48000,
    );
    assert(rec.heardPeak === rec.peak, `hit ${i + 1} heardPeak should equal peak`);
  }
}

// §1.7.3 — planted ring −3 dB: raw flags ring, 8:1 hides it
{
  const fingers = ["r", "m", "i"];
  const hits = [];
  for (let n = 0; n < 24; n++) {
    const fg = fingers[n % 3];
    const peakOk = fg === "r" ? 10 ** (-3 / 20) : 1;
    hits.push({
      type: "hit", scored: true, finger: fg, accent: false,
      peak: peakOk, heardPeak: compressPeak(peakOk, -6, 8),
      devMs: fg === "r" ? 13 : 0, rms: 0.3, centroid: 900,
      slotIndex: n % 3, loop: Math.floor(n / 3),
    });
  }
  const scorer = createScorer();
  scorer.setRatio(8);
  const sum = scorer.summarize(hits, fingers, 0.25, "rmi", 24, 1.3);
  assert(sum.balance.peakSpreadDb > 2, "raw spread should flag ring");
  assert(sum.balanceHeard.peakSpreadDb < 0.5, `heard spread ${sum.balanceHeard.peakSpreadDb} should be < 0.5`);
  const hide = sum.diagnosis.some((d) => /comp hides it/.test(d));
  assert(hide, "diagnosis should say the comp hides the weak finger: " + sum.diagnosis.join(" | "));
}

// §1.7.4 — ghosts ≥ 2 at any clean score when compressed
{
  const lines = diagnose({
    scores: { clean: 90, timing: 80, attackEven: 80 },
    balance: { peakSpreadDb: 0.5, timingSpreadMs: 0 },
    balanceHeard: { peakSpreadDb: 0.1 },
    out: { all: { meanDev: 0 }, r: { peakMean: 1, heardPeakMean: 1, meanDev: 0 } },
    fingers: ["r"],
    ghosts: 3, missedN: 0, doubles: 0,
    leakage: null, cycle: null, gridStep: 0.25, ratio: 8,
  });
  assert(lines[0]?.startsWith("ghosts will be loud"), "ghost line should be priority 1: " + lines.join(" | "));
}

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("compression tests: PASS");
void clampScore;
