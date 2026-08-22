/** Synthesized clicks and drums. No sample files. */

function writeBuffer(ctx, samples) {
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.getChannelData(0).set(samples);
  return buf;
}

function expClick(sr, freq, dur, gain) {
  const n = Math.max(1, Math.round(dur * sr));
  const out = new Float32Array(n);
  const tau = dur / 3;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / tau) * gain;
  }
  return out;
}

function biquadTick(state, x, b0, b1, b2, a1, a2) {
  const y = b0 * x + state.s1;
  state.s1 = b1 * x - a1 * y + state.s2;
  state.s2 = b2 * x - a2 * y;
  return y;
}

function designHp(sr, fc, Q) {
  const w0 = 2 * Math.PI * fc / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2;
  let a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function designBp(sr, fc, Q) {
  const w0 = 2 * Math.PI * fc / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0 = alpha, b1 = 0, b2 = -alpha;
  let a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(x, coef) {
  const s = { s1: 0, s2: 0 };
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = biquadTick(s, x[i], coef.b0, coef.b1, coef.b2, coef.a1, coef.a2);
  return y;
}

function noiseBurst(sr, dur, hpFc, gain) {
  const n = Math.round(dur * sr);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    raw[i] = (Math.random() * 2 - 1) * Math.exp(-t / (dur * 0.35)) * gain;
  }
  return applyBiquad(raw, designHp(sr, hpFc, 0.707));
}

export function buildKit(ctx) {
  const sr = ctx.sampleRate;
  const click1 = writeBuffer(ctx, expClick(sr, 1500, 0.006, 2.0));
  const click = writeBuffer(ctx, expClick(sr, 1000, 0.005, 1.0));
  const tick = writeBuffer(ctx, expClick(sr, 2000, 0.003, 0.25));

  const kickN = Math.round(0.22 * sr);
  const kick = new Float32Array(kickN);
  let phase = 0;
  for (let i = 0; i < kickN; i++) {
    const t = i / sr;
    const freq = 150 + (50 - 150) * Math.min(t / 0.08, 1);
    phase += 2 * Math.PI * freq / sr;
    kick[i] = Math.sin(phase) * Math.exp(-t / 0.2) * 0.9;
  }

  const snareN = Math.round(0.15 * sr);
  const noise = new Float32Array(snareN);
  for (let i = 0; i < snareN; i++) {
    const t = i / sr;
    noise[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.05);
  }
  const snareBp = applyBiquad(noise, designBp(sr, 1500, 1.2));
  const snare = new Float32Array(snareN);
  for (let i = 0; i < snareN; i++) {
    const t = i / sr;
    const tone = t < 0.06 ? Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t / 0.03) * 0.4 : 0;
    snare[i] = snareBp[i] * 0.7 + tone;
  }

  return {
    click1,
    click,
    tick,
    kick: writeBuffer(ctx, kick),
    snare: writeBuffer(ctx, snare),
    hatClosed: writeBuffer(ctx, noiseBurst(sr, 0.03, 7000, 0.45)),
    hatOpen: writeBuffer(ctx, noiseBurst(sr, 0.12, 6000, 0.35)),
  };
}

export function playBuf(ctx, buffer, time, gain = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.start(time);
  src.stop(time + buffer.duration + 0.01);
}

/**
 * Groove sounds for one grid event. Grooves never move slot times (A4).
 * beatAbs is the session beat index (0-based).
 */
export function grooveSounds(groove, slot, slotsPerBeat, beatAbs, ticksOn) {
  const sounds = [];
  const beatInBar = ((beatAbs % 4) + 4) % 4; // 0..3
  const isDown = slot.sub === 0;
  let g = groove;
  if (slotsPerBeat >= 5 && g !== "click" && g !== "clickSub") g = "click";

  if (g === "click") {
    if (isDown) sounds.push(beatInBar === 0 ? "click1" : "click");
    return sounds;
  }
  if (g === "clickSub") {
    if (isDown) sounds.push(beatInBar === 0 ? "click1" : "click");
    else if (ticksOn) sounds.push("tick");
    return sounds;
  }

  if (isDown) sounds.push(beatInBar === 0 ? "click1" : "click");
  if (ticksOn && !isDown) sounds.push("tick");

  if (g === "straight8") {
    if (isDown && (beatInBar === 0 || beatInBar === 2)) sounds.push("kick");
    if (isDown && (beatInBar === 1 || beatInBar === 3)) sounds.push("snare");
    if (slotsPerBeat >= 2 && slot.sub % Math.max(1, Math.round(slotsPerBeat / 2)) === 0) sounds.push("hatClosed");
  } else if (g === "straight16") {
    if (isDown && (beatInBar === 0 || beatInBar === 2)) sounds.push("kick");
    if (slotsPerBeat >= 4 && beatInBar === 2 && slot.sub === Math.round(slotsPerBeat / 2)) sounds.push("kick");
    if (isDown && (beatInBar === 1 || beatInBar === 3)) sounds.push("snare");
    if (slotsPerBeat >= 4) {
      sounds.push(slot.sub % Math.round(slotsPerBeat / 2) === 0 ? "hatClosed" : "hatClosed");
    } else if (isDown) sounds.push("hatClosed");
  } else if (g === "shuffle") {
    if (isDown && (beatInBar === 0 || beatInBar === 2)) sounds.push("kick");
    if (isDown && (beatInBar === 1 || beatInBar === 3)) sounds.push("snare");
    if (slotsPerBeat === 3) {
      sounds.push(slot.sub === 1 ? "hatOpen" : "hatClosed");
    } else if (slot.sub !== 1) {
      sounds.push(slot.sub === 0 ? "hatClosed" : "hatOpen");
    }
  } else if (g === "halftime") {
    if (isDown && beatInBar === 0) sounds.push("kick");
    if (isDown && beatInBar === 2) sounds.push("snare");
    if (slotsPerBeat >= 2 && slot.sub % Math.max(1, Math.round(slotsPerBeat / 2)) === 0) sounds.push("hatClosed");
  }
  return sounds;
}
