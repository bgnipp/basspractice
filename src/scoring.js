import { FINGER_NAMES } from "./pattern.js";
import { FEATURE_HOLD } from "./audio/scheduler.js";

export function clampScore(value, good, bad) {
  if (bad === good) return 100;
  return Math.min(100, Math.max(0, ((bad - value) / (bad - good)) * 100));
}

function nearestEvent(events, t, fromIndex) {
  let lo = fromIndex;
  let hi = events.length - 1;
  if (hi < lo) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  let bestD = Math.abs(events[lo].time - t);
  if (lo > fromIndex) {
    const d = Math.abs(events[lo - 1].time - t);
    if (d < bestD) {
      best = lo - 1;
      bestD = d;
    }
  }
  if (lo + 1 < events.length) {
    const d = Math.abs(events[lo + 1].time - t);
    if (d < bestD) best = lo + 1;
  }
  return best;
}

export function createScorer() {
  const hits = [];
  let sweepIndex = 0;
  let missed = [];

  function matchOnset(onset, events, gridStep, latencyCompMs, sampleRate, now) {
    const t = onset.frame / sampleRate - latencyCompMs / 1000;
    const idx = nearestEvent(events, t, sweepIndex);
    if (idx < 0) {
      const rec = record(onset, t, null, "extra", 0, true);
      hits.push(rec);
      return rec;
    }
    const e = events[idx];
    if (idx < sweepIndex) {
      const rec = record(onset, t, e, "extra", (t - e.time) * 1000, e.scored);
      hits.push(rec);
      return rec;
    }
    const dev = t - e.time;
    if (Math.abs(dev) > 0.5 * gridStep) {
      const rec = record(onset, t, e, "extra", dev * 1000, e.scored);
      hits.push(rec);
      return rec;
    }
    if (e.slot.finger == null) {
      e.ghosts += 1;
      const rec = record(onset, t, e, "ghost", dev * 1000, e.scored);
      hits.push(rec);
      return rec;
    }
    if (e.hit) {
      e.doubles += 1;
      const rec = record(onset, t, e, "double", dev * 1000, e.scored);
      hits.push(rec);
      return rec;
    }
    e.hit = true;
    const rec = record(onset, t, e, "hit", dev * 1000, e.scored);
    hits.push(rec);
    return rec;
  }

  function record(onset, t, e, type, devMs, scored) {
    return {
      t,
      slotIndex: e ? e.slot.index : -1,
      loop: e ? e.loop : -1,
      finger: e ? e.slot.finger : null,
      accent: e ? e.slot.accent : false,
      devMs,
      peak: onset.peak,
      rms: onset.rms,
      centroid: onset.centroid ?? 0,
      hfRatio: onset.hfRatio ?? 0,
      type,
      scored: !!scored,
      slot: e ? e.slot : null,
      event: e,
    };
  }

  function sweep(events, gridStep, now, onMiss) {
    while (
      sweepIndex < events.length &&
      events[sweepIndex].time + 0.5 * gridStep + FEATURE_HOLD < now
    ) {
      const e = events[sweepIndex];
      if (e.slot.finger && !e.hit && e.scored) {
        missed.push(e);
        onMiss?.(e);
      }
      sweepIndex++;
    }
  }

  function windowHits(bars, patternLength, now, beatDur) {
    const windowSec = bars * patternLength * beatDur;
    const t0 = now - windowSec;
    return hits.filter((h) => h.scored && h.t >= t0);
  }

  function summarize(subset, fingers, gridStep, cycle, slotsInWindow, accentRatio) {
    const played = subset.filter((h) => h.type === "hit");
    const groups = { all: played };
    for (const fg of fingers) groups[fg] = played.filter((h) => h.finger === fg);

    const out = {};
    for (const [name, g] of Object.entries(groups)) {
      if (!g.length) continue;
      const dev = g.map((h) => h.devMs);
      const peak = g.map((h) => h.peak);
      const cen = g.map((h) => h.centroid);
      out[name] = {
        n: g.length,
        meanDev: mean(dev),
        jitter: std(dev),
        peakMean: mean(peak),
        peakCV: mean(peak) ? std(peak) / mean(peak) : 0,
        centroidMean: mean(cen),
        centroidCV: mean(cen) ? std(cen) / mean(cen) : 0,
      };
    }

    const present = fingers.filter((k) => out[k]);
    let balance = { peakSpreadDb: 0, centroidSpreadPct: 0, timingSpreadMs: 0 };
    if (present.length >= 2) {
      const peaks = present.map((k) => out[k].peakMean);
      const cens = present.map((k) => out[k].centroidMean);
      const devs = present.map((k) => out[k].meanDev);
      balance = {
        peakSpreadDb: 20 * Math.log10(Math.max(...peaks) / (Math.min(...peaks) + 1e-12)),
        centroidSpreadPct: ((Math.max(...cens) - Math.min(...cens)) / (mean(cens) + 1e-12)) * 100,
        timingSpreadMs: Math.max(...devs) - Math.min(...devs),
      };
    }

    const ghosts = subset.filter((h) => h.type === "ghost").length;
    const doubles = subset.filter((h) => h.type === "double").length;
    const extras = subset.filter((h) => h.type === "extra").length;
    const missedN = missed.filter((e) => subset.length === 0 || e.time >= (subset[0]?.t ?? 0) - 1).length;
    // Prefer counting missed whose event time falls in the same window as subset hits
    const tMin = subset.reduce((m, h) => Math.min(m, h.t), Infinity);
    const tMax = subset.reduce((m, h) => Math.max(m, h.t), -Infinity);
    const missedIn = Number.isFinite(tMin)
      ? missed.filter((e) => e.time >= tMin - gridStep && e.time <= tMax + gridStep).length
      : missed.length;

    const slots = slotsInWindow || Math.max(1, played.length + missedIn);
    const dirtyPct = ((ghosts + missedIn + doubles) / slots) * 100;

    const accents = subset.filter((h) => h.type === "hit" && h.accent);
    const nonAcc = played.filter((h) => !h.accent);
    const nonMean = nonAcc.length ? mean(nonAcc.map((h) => h.peak)) : 0;
    const accentHits = accents.filter((h) => h.peak >= (accentRatio || 1.3) * (nonMean || 1e-12)).length;
    const accentHitRate = accents.length ? accentHits / accents.length : null;

    let leakage = null;
    if (cycle && cycle.length && gridStep && out.all) {
      const start = cycle[0];
      if (out[start] && out.all.peakMean) leakage = out[start].peakMean / out.all.peakMean;
    }

    const a = out.all || {
      jitter: 0, peakCV: 0, centroidCV: 0, meanDev: 0, n: 0,
    };
    const scores = {
      timing: clampScore(a.jitter, 0.04 * gridStep * 1000, 0.25 * gridStep * 1000),
      attackEven: clampScore(a.peakCV * 100, 6, 30),
      toneEven: clampScore(a.centroidCV * 100, 5, 25),
      fingerBalance: clampScore(balance.peakSpreadDb, 1.0, 6.0),
      clean: clampScore(dirtyPct, 0, 15),
    };
    if (accentHitRate != null) scores.accent = clampScore(accentHitRate * 100, 90, 40);

    const diagnosis = diagnose({
      scores, balance, out, fingers: present, ghosts, missedN: missedIn, doubles,
      leakage, cycle, gridStep, slotsPerBeatHint: null,
    });

    return {
      out,
      balance,
      scores,
      diagnosis,
      cleanliness: { ghosts, missed: missedIn, doubles, extras },
      accentHitRate,
      leakage,
    };
  }

  return {
    hits,
    missed,
    matchOnset,
    sweep,
    windowHits,
    summarize,
    reset() {
      hits.length = 0;
      missed.length = 0;
      sweepIndex = 0;
    },
    getSweepIndex() {
      return sweepIndex;
    },
  };
}

function mean(a) {
  if (!a.length) return 0;
  return a.reduce((s, v) => s + v, 0) / a.length;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

export function diagnose({ scores, balance, out, fingers, ghosts, missedN, doubles, leakage, cycle, gridStep }) {
  const lines = [];
  const fn = (k) => FINGER_NAMES[k] || k;
  if (scores.clean < 60) {
    if (ghosts > 0) lines.push(`ghost plucks on rests: ${ghosts} in last 8 bars`);
    else if (missedN > 0) lines.push(`missed ${missedN} notes`);
    else if (doubles > 0) lines.push(`${doubles} double triggers`);
  }
  if (fingers.length && balance.peakSpreadDb > 2) {
    const quiet = fingers.reduce((a, b) => (out[a].peakMean < out[b].peakMean ? a : b));
    const rel = 20 * Math.log10((out[quiet].peakMean + 1e-12) / (Math.max(...fingers.map((k) => out[k].peakMean)) + 1e-12));
    lines.push(`${fn(quiet)} is the weak finger (${rel.toFixed(1)} dB)`);
  }
  if (fingers.length && balance.timingSpreadMs > 0.05 * gridStep * 1000) {
    const late = fingers.reduce((a, b) => (out[a].meanDev > out[b].meanDev ? a : b));
    lines.push(`${fn(late)} lands late (${out[late].meanDev >= 0 ? "+" : ""}${out[late].meanDev.toFixed(1)} ms)`);
  }
  if (out.all) {
    if (out.all.meanDev > 0.1 * gridStep * 1000) lines.push("dragging");
    else if (out.all.meanDev < -0.1 * gridStep * 1000) lines.push("rushing");
  }
  if (leakage != null && leakage > 1.15 && cycle) {
    lines.push(`accenting every ${fn(cycle[0])} — sounds like triplets, not 16ths`);
  }
  if (!lines.length) lines.push("clean — bump the tempo");
  return lines.slice(0, 3);
}

export function hitsToCsv(hits) {
  const cols = ["t", "slotIndex", "loop", "finger", "accent", "devMs", "peak", "rms", "centroid", "hfRatio", "type", "scored"];
  const lines = [cols.join(",")];
  for (const h of hits) {
    lines.push(cols.map((c) => h[c] ?? "").join(","));
  }
  return lines.join("\n");
}
