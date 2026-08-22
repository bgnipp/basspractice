export const FINGER_NAMES = {
  r: "ring",
  m: "middle",
  i: "index",
  t: "thumb",
  p: "pinky",
};

export const FINGER_COLORS = {
  r: "#f59e3b",
  m: "#22d3ee",
  i: "#4ade80",
  t: "#a78bfa",
  p: "#f472b6",
};

export const PRESETS = [
  { id: "trip", name: "Even triplets", pattern: "rmi rmi rmi rmi", groove: "shuffle" },
  { id: "gallop", name: "Gallop (roll + rest)", pattern: "rmix rmix rmix rmix", groove: "straight16" },
  { id: "revgallop", name: "Reverse gallop", pattern: "xrmi xrmi xrmi xrmi", groove: "straight16" },
  { id: "disp1", name: "Displaced rest A", pattern: "rxmi rxmi rxmi rxmi", groove: "straight16" },
  { id: "disp2", name: "Displaced rest B", pattern: "rmxi rmxi rmxi rmxi", groove: "straight16" },
  { id: "six16", name: "Straight 16ths (3 vs 4)", pattern: "rmir mirm irmi rmir mirm irmi", groove: "straight16", cycle: "rmi" },
  { id: "six16acc", name: "16ths w/ rotating accent", pattern: "Rmir Mirm Irmi Rmir Mirm Irmi", groove: "straight16", cycle: "rmi" },
  { id: "sext", name: "Sextuplets", pattern: "rmirmi rmirmi rmirmi rmirmi", groove: "click" },
  { id: "quint", name: "Quintuplets (3 vs 5)", pattern: "rmirm irmir mirmi rmirm irmir mirmi", groove: "click", cycle: "rmi" },
  { id: "pickup", name: "Triplet with pickup", pattern: "xmi rmi rmi rmi", groove: "shuffle" },
  { id: "ringiso", name: "Ring isolation", pattern: "rmrm rmrm rmrm rmrm", groove: "straight16" },
  { id: "twofinger", name: "Two-finger reference", pattern: "im im im im", groove: "straight8" },
];

const SLOT_RE = /^[rmixtRMITP]+$/;

export function parsePattern(str) {
  const trimmed = String(str || "").trim();
  if (!trimmed) return { ok: false, error: "empty pattern" };
  if (/[^rmixtRMITP\s]/.test(trimmed)) return { ok: false, error: "allowed characters: r m i t p x (and accents)" };
  const beats = trimmed.split(/\s+/);
  if (beats.some((b) => !SLOT_RE.test(b))) return { ok: false, error: "allowed characters: r m i t p x (and accents)" };
  const n = beats[0].length;
  if (beats.some((b) => b.length !== n)) return { ok: false, error: "every beat must have the same number of slots" };
  if (beats.every((b) => /^x+$/.test(b))) return { ok: false, error: "need at least one non-rest slot" };
  return { ok: true, beats, slotsPerBeat: n, patternLength: beats.length, pattern: beats.join(" ") };
}

export function deriveSlots(patternStr, bpm) {
  const parsed = parsePattern(patternStr);
  if (!parsed.ok) throw new Error(parsed.error);
  const beatDur = 60 / bpm;
  const gridStep = beatDur / parsed.slotsPerBeat;
  const slots = [];
  let index = 0;
  for (let beat = 0; beat < parsed.beats.length; beat++) {
    const row = parsed.beats[beat];
    for (let sub = 0; sub < row.length; sub++) {
      const ch = row[sub];
      const rest = ch === "x";
      const accent = !rest && ch === ch.toUpperCase();
      const finger = rest ? null : ch.toLowerCase();
      slots.push({
        index,
        beat,
        sub,
        finger,
        accent,
        timeOffset: beat * beatDur + sub * gridStep,
      });
      index++;
    }
  }
  return {
    slots,
    slotsPerBeat: parsed.slotsPerBeat,
    patternLength: parsed.patternLength,
    beatDur,
    gridStep,
    pattern: parsed.pattern,
    fingers: [...new Set(slots.map((s) => s.finger).filter(Boolean))],
  };
}

export function validatePattern(str) {
  return parsePattern(str);
}

export const SEQUENCE_PRESETS = [
  {
    id: "ladder",
    name: "Claypool ladder",
    loop: true,
    shuffle: false,
    gate: { enabled: false, cleanMin: 80 },
    segments: [
      { id: "trip", bars: 4 },
      { id: "pickup", bars: 4 },
      { id: "gallop", bars: 4 },
      { id: "revgallop", bars: 4 },
      { id: "six16", bars: 2 },
    ],
  },
  {
    id: "gallopdrill",
    name: "Gallop drill",
    loop: true,
    shuffle: false,
    gate: { enabled: false, cleanMin: 80 },
    segments: [
      { id: "trip", bars: 2 },
      { id: "gallop", bars: 4 },
      { id: "disp1", bars: 4 },
      { id: "disp2", bars: 4 },
    ],
  },
  {
    id: "reading",
    name: "Reading drill",
    loop: true,
    shuffle: true,
    gate: { enabled: false, cleanMin: 80 },
    segments: [
      { id: "trip", bars: 2 },
      { id: "pickup", bars: 2 },
      { id: "gallop", bars: 2 },
      { id: "revgallop", bars: 2 },
      { id: "six16", bars: 2 },
    ],
  },
];

export function findPattern(idOrPattern, extras = []) {
  const catalog = [...PRESETS, ...extras];
  return catalog.find((p) => p.id === idOrPattern || p.pattern === idOrPattern) || null;
}

export function validateSequence(seq) {
  if (!seq || !Array.isArray(seq.segments) || !seq.segments.length) {
    return { ok: false, error: "need at least one segment" };
  }
  for (const s of seq.segments) {
    const p = s.pattern || findPattern(s.id)?.pattern;
    const r = parsePattern(p || "");
    if (!r.ok) return { ok: false, error: r.error };
    if (!s.bars || s.bars < 1) return { ok: false, error: "bars must be >= 1" };
  }
  return { ok: true };
}

export function hydrateSequence(seq, extras = []) {
  const catalog = [...PRESETS, ...extras];
  const segments = (seq.segments || []).map((s) => {
    const p = catalog.find((x) => x.id === s.id || x.pattern === s.pattern);
    const pattern = s.pattern || p?.pattern;
    return {
      pattern,
      bars: Math.max(1, Number(s.bars) || 1),
      groove: s.groove || p?.groove || "click",
      id: s.id || p?.id || pattern,
      name: s.name || p?.name || pattern,
    };
  });
  return {
    id: seq.id,
    name: seq.name || "Sequence",
    loop: seq.loop !== false,
    shuffle: !!seq.shuffle,
    gate: {
      enabled: !!(seq.gate && seq.gate.enabled),
      cleanMin: Number(seq.gate?.cleanMin) || 80,
    },
    segments,
  };
}
