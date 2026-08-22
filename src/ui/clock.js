import { FINGER_COLORS } from "../pattern.js";

export function createClock(canvas) {
  const dots = [];
  const misses = [];
  let slotsPerBeat = 3;
  let restSubs = new Set();
  let accentSubs = new Set();
  let dim = false;
  let lastDraw = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  function setGrid(grid) {
    slotsPerBeat = grid.slotsPerBeat;
    restSubs = new Set(grid.slots.filter((s) => !s.finger).map((s) => s.sub));
    accentSubs = new Set(grid.slots.filter((s) => s.accent).map((s) => s.sub));
  }

  function addHit(rec, gridStep, peakNorm) {
    const sub = rec.slot ? rec.slot.sub : 0;
    const frac = (sub + rec.devMs / 1000 / gridStep) / slotsPerBeat;
    dots.push({
      angle: frac * Math.PI * 2,
      r: 0.55 + 0.35 * peakNorm,
      color: rec.type === "ghost" ? null : FINGER_COLORS[rec.finger] || "#fff",
      ghost: rec.type === "ghost",
      born: performance.now(),
    });
    if (dots.length > 240) dots.splice(0, dots.length - 200);
  }

  function addMiss(slot) {
    misses.push({
      angle: (slot.sub / slotsPerBeat) * Math.PI * 2,
      born: performance.now(),
    });
    if (misses.length > 80) misses.splice(0, misses.length - 60);
  }

  function draw(posInBeat, beatDur) {
    const now = performance.now();
    if (now - lastDraw < 8) return;
    lastDraw = now;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.42;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = dim ? 0.35 : 1;

    for (let i = 0; i < slotsPerBeat; i++) {
      const a0 = (i / slotsPerBeat) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / slotsPerBeat) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a1);
      ctx.strokeStyle = restSubs.has(i) ? "#3a3f4a" : "#5b6370";
      ctx.lineWidth = 8 * dpr;
      ctx.stroke();
      if (restSubs.has(i)) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, a0, a1);
        ctx.setLineDash([4 * dpr, 5 * dpr]);
        ctx.strokeStyle = "#2a2e36";
        ctx.lineWidth = 14 * dpr;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (accentSubs.has(i)) {
        ctx.beginPath();
        ctx.arc(cx, cy, R + 10 * dpr, a0 + 0.04, a1 - 0.04);
        ctx.strokeStyle = "#e8e4d9";
        ctx.lineWidth = 4 * dpr;
        ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.arc(cx, cy, 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "#e8e4d9";
    ctx.fill();

    const fade = 4 * beatDur * 1000;
    for (const d of dots) {
      const age = now - d.born;
      if (age > fade) continue;
      const a = 1 - age / fade;
      const ang = d.angle - Math.PI / 2;
      const x = cx + Math.cos(ang) * R * d.r;
      const y = cy + Math.sin(ang) * R * d.r;
      ctx.globalAlpha = (dim ? 0.35 : 1) * a;
      ctx.beginPath();
      ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2);
      if (d.ghost) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      } else {
        ctx.fillStyle = d.color;
        ctx.fill();
      }
    }
    ctx.globalAlpha = dim ? 0.35 : 1;
    for (const m of misses) {
      const age = now - m.born;
      if (age > fade) continue;
      const ang = m.angle - Math.PI / 2;
      const x = cx + Math.cos(ang) * R;
      const y = cy + Math.sin(ang) * R;
      ctx.beginPath();
      ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(148,163,184,${1 - age / fade})`;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }

    const ang = (posInBeat * Math.PI * 2) - Math.PI / 2;
    ctx.strokeStyle = dim ? "#64748b" : "#f8fafc";
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * R * 0.92, cy + Math.sin(ang) * R * 0.92);
    ctx.stroke();
    ctx.restore();

    while (dots.length && now - dots[0].born > fade) dots.shift();
    while (misses.length && now - misses[0].born > fade) misses.shift();
  }

  return {
    resize,
    setGrid,
    addHit,
    addMiss,
    draw,
    setDim(v) {
      dim = v;
    },
    reset() {
      dots.length = 0;
      misses.length = 0;
    },
  };
}
