import { FINGER_NAMES } from "./pattern.js";
import { FEATURE_HOLD } from "./audio/scheduler.js";

export function clampScore(value, good, bad) {
  if (bad === good) return 100;
  return Math.min(100, Math.max(0, ((bad - value) / (bad - good)) * 100));
}

export function compressPeak(peak, thresholdDb, ratio) {
  if (ratio <= 1) return peak;
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-12));
  const overDb = Math.max(0, peakDb - thresholdDb);
  const heardDb = peakDb - overDb * (1 - 1 / ratio);
  return 10 ** (heardDb / 20);
}

export function compressionThresholdDb(peaks) {
  if (peaks.length < 4) return null;
  const dbs = peaks.map((p) => 20 * Math.log10(Math.max(p, 1e-12))).sort((a, b) => a - b);
  const mid = dbs.length >> 1;
  const med = dbs.length % 2 ? dbs[mid] : (dbs[mid - 1] + dbs[mid]) / 2;
  return med - 6;
}

export function peakSpreadDb(peaks) {
  if (!peaks.length) return 0;
  return 20 * Math.log10(Math.max(...peaks) / (Math.min(...peaks) + 1e-12));
}

/** Highway / streak bands: |dev| vs 4% and 12% of grid step. */
export function grade(devMs, gridStep) {
  const rel = Math.abs(devMs) / (gridStep * 1000);
  if (rel <= 0.04) return "perfect";
  if (rel <= 0.12) return "good";
  return "off";
}

export function emptyTallies() {
  return { perfect: 0, good: 0, off: 0, missed: 0, ghosts: 0, doubles: 0 };
}

export function createStreakState() {
  return { streak: 0, bestStreak: 0, lastBreak: "", tallies: emptyTallies() };
}

/**
 * Streak reducer. Count-in (scored=false) is ignored. extra does not reset.
 * missed/ghost/double/off reset to 0. perfect/good increment.
 */
export function applyStreakEvent(state, ev) {
  const next = {
    streak: state.streak,
    bestStreak: state.bestStreak,
    lastBreak: state.lastBreak,
    tallies: { ...state.tallies },
  };
  if (ev.type === "extra") return next;
  if (ev.scored === false) return next;
  if (ev.type === "hit") {
    const g = ev.grade || grade(ev.devMs, ev.gridStep);
    next.tallies[g] += 1;
    if (g === "perfect" || g === "good") {
      next.streak += 1;
      if (next.streak > next.bestStreak) next.bestStreak = next.streak;
      next.lastBreak = "";
    } else {
      next.streak = 0;
      next.lastBreak = "off";
    }
    return next;
  }
  if (ev.type === "ghost") {
    next.tallies.ghosts += 1;
    next.streak = 0;
    next.lastBreak = "ghost";
    return next;
  }
  if (ev.type === "double") {
    next.tallies.doubles += 1;
    next.streak = 0;
    next.lastBreak = "double";
    return next;
  }
  if (ev.type === "missed") {
    next.tallies.missed += 1;
    next.streak = 0;
    next.lastBreak = "missed";
    return next;
  }
  return next;
}

export function talliesOf(hits, missedN, gridStep) {
  const t = emptyTallies();
  for (const h of hits) {
    if (!h.scored) continue;
    if (h.type === "hit") t[grade(h.devMs, gridStep)] += 1;
    else if (h.type === "ghost") t.ghosts += 1;
    else if (h.type === "double") t.doubles += 1;
  }
  t.missed = missedN || 0;
  return t;
}

export function aggregatePerSlot(hits, missed, slots) {
  return (slots || []).map((slot, i) => {
    const slotHits = hits.filter((h) => h.type === "hit" && h.scored && h.slotIndex === i);
    const slotMiss = (missed || []).filter((e) => (e.slot?.index ?? e.slotIndex) === i);
    const ghosts = hits.filter((h) => h.type === "ghost" && h.scored && h.slotIndex === i);
    const n = slotHits.length;
    const devs = slotHits.map((h) => h.devMs);
    const peaks = slotHits.map((h) => h.peak);
    const denom = n + slotMiss.length;
    const ghostDenom = n + ghosts.length + slotMiss.length;
    return {
      n,
      meanDev: n ? mean(devs) : 0,
      jitter: n >= 2 ? std(devs) : 0,
      missRate: denom ? slotMiss.length / denom : 0,
      ghostRate: ghostDenom ? ghosts.length / ghostDenom : 0,
      peakMean: n ? mean(peaks) : 0,
    };
  });
}

export function mergePerSlot(rows) {
  if (!rows?.length) return [];
  const n = Math.max(...rows.map((r) => r.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    let nHits = 0;
    let wDev = 0;
    let wJit = 0;
    let wPeak = 0;
    let missN = 0;
    let missD = 0;
    let ghostN = 0;
    let ghostD = 0;
    for (const row of rows) {
      const c = row[i];
      if (!c) continue;
      nHits += c.n || 0;
      wDev += (c.meanDev || 0) * (c.n || 0);
      wJit += (c.jitter || 0) * (c.n || 0);
      wPeak += (c.peakMean || 0) * (c.n || 0);
      const d = (c.n || 0) / Math.max(1e-12, 1 - (c.missRate || 0));
      const misses = (c.missRate || 0) * d;
      missN += misses;
      missD += d;
      const gd = (c.n || 0) / Math.max(1e-12, 1 - (c.ghostRate || 0));
      ghostN += (c.ghostRate || 0) * gd;
      ghostD += gd;
    }
    out.push({
      n: nHits,
      meanDev: nHits ? wDev / nHits : 0,
      jitter: nHits ? wJit / nHits : 0,
      missRate: missD ? missN / missD : 0,
      ghostRate: ghostD ? ghostN / ghostD : 0,
      peakMean: nHits ? wPeak / nHits : 0,
    });
  }
  return out;
}

export function problemSlot(perSlot, slots) {
  let best = null;
  (slots || []).forEach((slot, i) => {
    if (!slot?.finger) return;
    const cell = perSlot[i];
    if (!cell) return;
    const score = (cell.missRate || 0) * 100 + Math.abs(cell.meanDev || 0) + (cell.jitter || 0);
    if (!best || score > best.score) best = { index: i, slot, cell, score };
  });
  return best;
}

export function perSlotByPattern(hits, missed, patternSlots) {
  const out = {};
  for (const [pattern, slots] of Object.entries(patternSlots || {})) {
    const hs = hits.filter((h) => h.pattern === pattern);
    const ms = (missed || []).filter((e) => e.pattern === pattern);
    out[pattern] = aggregatePerSlot(hs, ms, slots);
  }
  return out;
}

export function segmentStats(hits, missed, gridStep) {
  const played = hits.filter((h) => h.type === "hit" && h.scored);
  const ghosts = hits.filter((h) => h.type === "ghost" && h.scored).length;
  const doubles = hits.filter((h) => h.type === "double" && h.scored).length;
  const missedN = (missed || []).length;
  const slots = Math.max(1, played.length + missedN);
  const dirtyPct = ((ghosts + missedN + doubles) / slots) * 100;
  const jitter = std(played.map((h) => h.devMs));
  const peak = played.map((h) => h.peak);
  const pm = mean(peak);
  const peakCV = pm ? std(peak) / pm : 0;
  return {
    n: played.length,
    timing: clampScore(jitter, 0.04 * gridStep * 1000, 0.25 * gridStep * 1000),
    attackEven: clampScore(peakCV * 100, 6, 30),
    clean: clampScore(dirtyPct, 0, 15),
    jitter,
  };
}

export function summarizeSegments(hits, missed, sequence, gridStepOf) {
  if (!sequence?.segments?.length) return { perSegment: [], transition: null };
  const perSegment = [];
  const seen = new Set();
  for (const seg of sequence.segments) {
    if (seen.has(seg.pattern)) continue;
    seen.add(seg.pattern);
    const hs = hits.filter((h) => h.pattern === seg.pattern);
    const ms = (missed || []).filter((e) => e.pattern === seg.pattern);
    const step = typeof gridStepOf === "function" ? gridStepOf(seg) : gridStepOf || 0.25;
    const stats = segmentStats(hs, ms, step);
    perSegment.push({
      pattern: seg.pattern,
      name: seg.name || seg.id || seg.pattern,
      ...stats,
    });
  }
  return { perSegment, transition: transitionJitter(hits) };
}

function transitionJitter(hits) {
  const played = hits.filter((h) => h.type === "hit" && h.scored && h.segmentIndex != null).slice().sort((a, b) => a.t - b.t);
  if (played.length < 4) return null;
  const first = [];
  const rest = [];
  let lastSeg = null;
  const firstLoop = new Set();
  for (const h of played) {
    if (h.segmentIndex !== lastSeg) {
      firstLoop.add(`${h.segmentIndex}:${h.loop}`);
      lastSeg = h.segmentIndex;
    }
    if (firstLoop.has(`${h.segmentIndex}:${h.loop}`)) first.push(h.devMs);
    else rest.push(h.devMs);
  }
  if (first.length < 2 || rest.length < 2) return null;
  return { firstBarJitter: std(first), steadyJitter: std(rest) };
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
  let ratio = 1;
  const peakRing = [];
  let lastThresholdDb = null;
  let streak = createStreakState();

  function heardFor(peak) {
    const thr = compressionThresholdDb(peakRing);
    lastThresholdDb = thr;
    if (thr == null || ratio <= 1) return peak;
    return compressPeak(peak, thr, ratio);
  }

  function pushRing(peak) {
    peakRing.push(peak);
    if (peakRing.length > 16) peakRing.shift();
  }

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
      streak = applyStreakEvent(streak, { type: "ghost", scored: rec.scored });
      hits.push(rec);
      return rec;
    }
    if (e.hit) {
      e.doubles += 1;
      const rec = record(onset, t, e, "double", dev * 1000, e.scored);
      streak = applyStreakEvent(streak, { type: "double", scored: rec.scored });
      hits.push(rec);
      return rec;
    }
    e.hit = true;
    const rec = record(onset, t, e, "hit", dev * 1000, e.scored);
    rec.grade = rec.scored ? grade(rec.devMs, gridStep) : null;
    streak = applyStreakEvent(streak, { type: "hit", scored: rec.scored, devMs: rec.devMs, gridStep, grade: rec.grade });
    hits.push(rec);
    return rec;
  }

  function record(onset, t, e, type, devMs, scored) {
    const heardPeak = heardFor(onset.peak);
    if (type === "hit" && scored && !(e && e.slot.accent)) pushRing(onset.peak);
    return {
      t,
      slotIndex: e ? e.slot.index : -1,
      loop: e ? e.loop : -1,
      finger: e ? e.slot.finger : null,
      accent: e ? e.slot.accent : false,
      devMs,
      peak: onset.peak,
      heardPeak,
      rms: onset.rms,
      centroid: onset.centroid ?? 0,
      hfRatio: onset.hfRatio ?? 0,
      type,
      scored: !!scored,
      slot: e ? e.slot : null,
      event: e,
      segmentIndex: e && e.segmentIndex != null ? e.segmentIndex : 0,
      pattern: e && e.pattern != null ? e.pattern : null,
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
        streak = applyStreakEvent(streak, { type: "missed", scored: true });
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
      const heard = g.map((h) => h.heardPeak ?? h.peak);
      out[name] = {
        n: g.length,
        meanDev: mean(dev),
        jitter: std(dev),
        peakMean: mean(peak),
        peakCV: mean(peak) ? std(peak) / mean(peak) : 0,
        heardPeakMean: mean(heard),
        heardPeakCV: mean(heard) ? std(heard) / mean(heard) : 0,
        centroidMean: mean(cen),
        centroidCV: mean(cen) ? std(cen) / mean(cen) : 0,
      };
    }

    const present = fingers.filter((k) => out[k]);
    let balance = { peakSpreadDb: 0, centroidSpreadPct: 0, timingSpreadMs: 0 };
    let balanceHeard = { peakSpreadDb: 0 };
    if (present.length >= 2) {
      const peaks = present.map((k) => out[k].peakMean);
      const heardPeaks = present.map((k) => out[k].heardPeakMean);
      const cens = present.map((k) => out[k].centroidMean);
      const devs = present.map((k) => out[k].meanDev);
      balance = {
        peakSpreadDb: peakSpreadDb(peaks),
        centroidSpreadPct: ((Math.max(...cens) - Math.min(...cens)) / (mean(cens) + 1e-12)) * 100,
        timingSpreadMs: Math.max(...devs) - Math.min(...devs),
      };
      balanceHeard = { peakSpreadDb: peakSpreadDb(heardPeaks) };
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

    const scoresHeard = {
      attackEven: clampScore((out.all?.heardPeakCV ?? 0) * 100, 6, 30),
      fingerBalance: clampScore(balanceHeard.peakSpreadDb, 1.0, 6.0),
    };
    const dependence = Math.max(0, scoresHeard.attackEven - scores.attackEven);

    const diagnosis = diagnose({
      scores, balance, balanceHeard, out, fingers: present, ghosts, missedN: missedIn, doubles,
      leakage, cycle, gridStep, ratio,
    });

    return {
      out,
      balance,
      balanceHeard,
      scores,
      scoresHeard,
      dependence,
      diagnosis,
      cleanliness: { ghosts, missed: missedIn, doubles, extras },
      accentHitRate,
      leakage,
      compression: { ratio, thresholdDb: lastThresholdDb },
      tallies: talliesOf(subset, missedIn, gridStep),
      bestStreak: streak.bestStreak,
      streak: streak.streak,
    };
  }

  return {
    hits,
    missed,
    matchOnset,
    sweep,
    windowHits,
    summarize,
    setRatio(r) {
      ratio = r === 2 || r === 4 || r === 8 ? r : 1;
    },
    getRatio() {
      return ratio;
    },
    getThresholdDb() {
      return lastThresholdDb;
    },
    getStreak() {
      return streak;
    },
    reset() {
      hits.length = 0;
      missed.length = 0;
      sweepIndex = 0;
      peakRing.length = 0;
      lastThresholdDb = null;
      streak = createStreakState();
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

export function diagnose({ scores, balance, balanceHeard, out, fingers, ghosts, missedN, doubles, leakage, cycle, gridStep, ratio }) {
  const lines = [];
  const fn = (k) => FINGER_NAMES[k] || k;
  const compressed = (ratio || 1) > 1;
  if (compressed && ghosts >= 2) {
    lines.push(`ghosts will be loud through your comp: ${ghosts} in last 8 bars`);
  }
  if (scores.clean < 60) {
    if (ghosts > 0 && !(compressed && ghosts >= 2)) lines.push(`ghost plucks on rests: ${ghosts} in last 8 bars`);
    else if (missedN > 0) lines.push(`missed ${missedN} notes`);
    else if (doubles > 0) lines.push(`${doubles} double triggers`);
  }
  if (fingers.length && balance.peakSpreadDb > 2) {
    const quiet = fingers.reduce((a, b) => (out[a].peakMean < out[b].peakMean ? a : b));
    const rawRel = 20 * Math.log10((out[quiet].peakMean + 1e-12) / (Math.max(...fingers.map((k) => out[k].peakMean)) + 1e-12));
    const heardSpread = balanceHeard?.peakSpreadDb ?? 0;
    if (compressed && heardSpread < 1) {
      const heardRel = 20 * Math.log10((out[quiet].heardPeakMean + 1e-12) / (Math.max(...fingers.map((k) => out[k].heardPeakMean)) + 1e-12));
      lines.push(`${fn(quiet)} is weak raw (${rawRel.toFixed(1)} dB) — your comp hides it (${heardRel.toFixed(1)} dB heard)`);
    } else {
      lines.push(`${fn(quiet)} is the weak finger (${rawRel.toFixed(1)} dB)`);
    }
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
  const cols = ["t", "slotIndex", "loop", "finger", "accent", "devMs", "peak", "heardPeak", "rms", "centroid", "hfRatio", "type", "scored", "segmentIndex", "grade"];
  const lines = [cols.join(",")];
  for (const h of hits) {
    lines.push(cols.map((c) => h[c] ?? "").join(","));
  }
  return lines.join("\n");
}
