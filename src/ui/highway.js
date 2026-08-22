import { FINGER_COLORS } from "../pattern.js";
import { grade } from "../scoring.js";

const LOOK_AHEAD = 2.4;
const LOOK_BACK = 1.6;
const NOW_FRAC = 0.68;

function gradeColor(devMs, gridStep) {
  const g = grade(devMs, gridStep);
  if (g === "perfect") return "#4ade80";
  if (g === "good") return "#fbbf24";
  return "#ef4444";
}

export function createHighway(canvas) {
  let grid = null;
  let lastDraw = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }

  function setGrid(next) {
    grid = next;
  }

  function timeToY(t, now, nowY, pxPerSec) {
    return nowY - (t - now) * pxPerSec;
  }

  function draw(opts) {
    const t0 = performance.now();
    if (t0 - lastDraw < 8) return;
    lastDraw = t0;
    if (!grid) return;

    const {
      now, sessionStart, step, hits, missed,
      loopOffset = 0, countIn = 0,
      dropoutBars = 0, dropoutEvery = 8,
      next = null,
      upcomingLabel = "",
      pulseSwitch = false,
      streak = 0,
      lastBreak = "",
      pulseAt = 0,
    } = opts;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, W, H);

    const nowY = H * NOW_FRAC;
    const pxPerSec = nowY / LOOK_AHEAD;
    const tMin = now - LOOK_BACK;
    const tMax = now + LOOK_AHEAD;
    const boundary = next?.boundaryTime;

    const hitMap = new Map();
    for (const h of hits) {
      if (h.loop < 0 || h.slotIndex < 0) continue;
      const key = `${h.loop}:${h.slotIndex}:${h.segmentIndex ?? 0}`;
      if (!hitMap.has(key)) hitMap.set(key, []);
      hitMap.get(key).push(h);
    }
    const missSet = new Set();
    for (const e of missed) missSet.add(`${e.loop}:${e.slot.index}:${e.segmentIndex ?? 0}`);

    const splitY = boundary != null ? timeToY(boundary, now, nowY, pxPerSec) : -1e9;
    if (next && next.grid && boundary != null && splitY > -20 && splitY < H + 20) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, Math.max(0, splitY));
      ctx.clip();
      drawRegion(ctx, {
        grid: next.grid, step: next.step, sessionStart: boundary, loopOffset: next.loopOffset || 0,
        countIn: 0, W, H, nowY, pxPerSec, now, tMin: Math.max(tMin, boundary), tMax,
        hits: hitMap, missSet, dropoutBars, dropoutEvery,
      });
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, Math.max(0, splitY), W, H);
      ctx.clip();
      drawRegion(ctx, {
        grid, step, sessionStart, loopOffset, countIn, W, H, nowY, pxPerSec, now,
        tMin, tMax: Math.min(tMax, boundary), hits: hitMap, missSet, dropoutBars, dropoutEvery,
      });
      ctx.restore();
      ctx.strokeStyle = pulseSwitch ? "#f59e3b" : "#64748b";
      ctx.lineWidth = pulseSwitch ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(0, splitY);
      ctx.lineTo(W, splitY);
      ctx.stroke();
    } else {
      drawRegion(ctx, {
        grid, step, sessionStart, loopOffset, countIn, W, H, nowY, pxPerSec, now,
        tMin, tMax, hits: hitMap, missSet, dropoutBars, dropoutEvery,
      });
    }

    ctx.fillStyle = "rgba(248,250,252,0.12)";
    ctx.fillRect(0, nowY - 10, W, 20);
    ctx.strokeStyle = "#f8fafc";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, nowY);
    ctx.lineTo(W, nowY);
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.fillText("now", 6, nowY - 14);

    if (upcomingLabel) {
      ctx.fillStyle = pulseSwitch ? "#f59e3b" : "#e8e4d9";
      ctx.font = "12px -apple-system, system-ui, sans-serif";
      ctx.fillText(upcomingLabel, 8, 16);
    }

    const pulse = pulseAt && (t0 - pulseAt) < 180;
    const scale = pulse ? 1 + 0.25 * (1 - (t0 - pulseAt) / 180) : 1;
    const label = streak > 0
      ? `×${streak}`
      : lastBreak ? `×0 — ${lastBreak}` : "×0";
    ctx.save();
    ctx.fillStyle = streak > 0 ? "#e8e4d9" : "#64748b";
    ctx.font = `${Math.round(18 * scale)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(label, W - 10, 20);
    ctx.restore();
  }

  return { resize, setGrid, draw, reset() {} };
}

function drawRegion(ctx, o) {
  const {
    grid, step, sessionStart, loopOffset, countIn, W, H, nowY, pxPerSec, now,
    tMin, tMax, hits, missSet, dropoutBars, dropoutEvery,
  } = o;
  const n = grid.slotsPerBeat;
  const slotsPerLoop = grid.slots.length;
  const laneW = W / n;

  for (let i = 0; i < n; i++) {
    const x = i * laneW;
    const rest = grid.slots.some((s) => s.sub === i && !s.finger);
    if (rest) {
      ctx.fillStyle = "rgba(239,68,68,0.06)";
      ctx.fillRect(x, 0, laneW, H);
    }
    ctx.beginPath();
    ctx.moveTo(x + laneW / 2, 0);
    ctx.lineTo(x + laneW / 2, H);
    ctx.strokeStyle = i === 0 ? "#3a3f4a" : "#22262c";
    ctx.lineWidth = i === 0 ? 1.5 : 1;
    ctx.stroke();
  }

  const beatDur = step * n;
  let beatT = sessionStart + Math.floor((tMin - sessionStart) / beatDur) * beatDur;
  if (beatT < sessionStart) beatT = sessionStart;
  ctx.strokeStyle = "#2a3038";
  ctx.lineWidth = 1;
  while (beatT < tMax + beatDur) {
    const y = nowY - (beatT - now) * pxPerSec;
    if (y > -4 && y < H + 4) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    beatT += beatDur;
  }

  const first = Math.floor((tMin - sessionStart) / step);
  const last = Math.ceil((tMax - sessionStart) / step);
  for (let abs = first; abs <= last; abs++) {
    if (abs < 0) continue;
    const t = sessionStart + abs * step;
    if (t < tMin - step || t > tMax + step) continue;
    const slot = grid.slots[((abs % slotsPerLoop) + slotsPerLoop) % slotsPerLoop];
    const localLoop = Math.floor(abs / slotsPerLoop);
    const loop = localLoop + loopOffset;
    const y = nowY - (t - now) * pxPerSec;
    if (y < -20 || y > H + 20) continue;
    const cx = slot.sub * laneW + laneW / 2;
    const inCount = localLoop < countIn;
    const drop = dropoutBars > 0 && loop % dropoutEvery >= dropoutEvery - dropoutBars;
    const dim = inCount || drop ? 0.4 : 1;
    const key = `${loop}:${slot.index}:${slot.segmentIndex ?? 0}`;
    const landed = hits.get(`${loop}:${slot.index}:0`) || hits.get(key);
    const gone = t < now;

    if (!gone) {
      if (!slot.finger) continue;
      drawGem(ctx, cx, y, slot, dim, laneW);
      continue;
    }

    if (landed && landed.length) {
      landed.forEach((h, i) => {
        const nudge = Math.max(-0.48, Math.min(0.48, (h.devMs / 1000) / step)) * laneW;
        const x = cx + nudge;
        const color = h.type === "ghost" ? "#ef4444" : gradeColor(h.devMs, step);
        drawLanded(ctx, x, y, h, color, i > 0 || h.type === "double", laneW);
      });
    } else if ((missSet.has(key) || missSet.has(`${loop}:${slot.index}:0`)) && slot.finger) {
      ctx.beginPath();
      ctx.arc(cx, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(148,163,184,0.7)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (slot.finger && t > now - 0.06) {
      drawGem(ctx, cx, y, slot, 0.35, laneW);
    }
  }
}

function drawGem(ctx, x, y, slot, dim, laneW) {
  const r = Math.min(12, laneW * 0.28);
  ctx.save();
  ctx.globalAlpha = dim;
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.85, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.85, 0);
  ctx.closePath();
  const col = FINGER_COLORS[slot.finger] || "#e8e4d9";
  ctx.fillStyle = col;
  ctx.globalAlpha = dim * 0.35;
  ctx.fill();
  ctx.globalAlpha = dim;
  ctx.strokeStyle = col;
  ctx.lineWidth = slot.accent ? 3 : 1.8;
  ctx.stroke();
  ctx.restore();
}

function drawLanded(ctx, x, y, rec, color, small, laneW) {
  const r = small ? 4 : Math.min(11, 6 + (rec.peak || 0.3) * 8);
  ctx.beginPath();
  ctx.arc(x, y, Math.min(r, laneW * 0.32), 0, Math.PI * 2);
  if (rec.type === "ghost") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
    if (rec.accent) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
