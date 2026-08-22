import { FINGER_COLORS, FINGER_NAMES } from "../pattern.js";

const ROW = 28;
const HEAD_ROW = 36;
const LABEL = 56;
const HEAD = 40;

export function createReview(root) {
  const head = root.querySelector(".review-head");
  const scroll = root.querySelector(".review-scroll");
  const body = root.querySelector(".review-body");
  const spacer = root.querySelector(".review-spacer");
  const readout = root.querySelector(".review-readout-text") || root.querySelector(".review-readout");
  const playBtn = root.querySelector("#replay-row");
  let model = null;
  let markers = [];
  let plan = [];
  let selected = null;
  let replay = null;
  let onSelect = null;

  function dpr() {
    return window.devicePixelRatio || 1;
  }

  function sizeCanvas(c, cssW, cssH) {
    const r = dpr();
    c.width = Math.round(cssW * r);
    c.height = Math.round(cssH * r);
    c.style.width = cssW + "px";
    c.style.height = cssH + "px";
    return c.getContext("2d");
  }

  function blocks() {
    if (model?.blocks?.length) return model.blocks;
    if (model?.grid) {
      return [{ segmentIndex: 0, label: "", grid: model.grid, gridStep: model.gridStep }];
    }
    return [];
  }

  function colW(cssW, n) {
    return (cssW - LABEL) / Math.max(1, n);
  }

  function isDropout(loop) {
    const bars = model.dropoutBars || 0;
    const every = model.dropoutEvery || 8;
    if (!bars) return false;
    return loop % every >= every - bars;
  }

  function buildPlan() {
    plan = [];
    const bl = blocks();
    for (const block of bl) {
      const loops = [];
      for (const h of model.hits || []) {
        if (h.loop < 0) continue;
        if (bl.length > 1 && (h.segmentIndex ?? 0) !== block.segmentIndex) continue;
        loops.push(h.loop);
      }
      for (const e of model.missed || []) {
        if (e.loop < 0) continue;
        if (bl.length > 1 && (e.segmentIndex ?? 0) !== block.segmentIndex) continue;
        loops.push(e.loop);
      }
      if (!loops.length) continue;
      const min = Math.min(...loops);
      const max = Math.max(...loops);
      plan.push({ type: "header", block, h: HEAD_ROW });
      for (let L = min; L <= max; L++) plan.push({ type: "loop", block, loop: L, h: ROW });
    }
  }

  function rowOffset(index) {
    let y = 0;
    for (let i = 0; i < index; i++) y += plan[i].h;
    return y;
  }

  function totalH() {
    return plan.reduce((s, r) => s + r.h, 0);
  }

  function slotX(cssW, block, slotIndex, devMs) {
    const n = block.grid.slots.length;
    const w = colW(cssW, n);
    const step = block.gridStep;
    const center = LABEL + slotIndex * w + w / 2;
    const offset = step ? (devMs / 1000 / step) * w : 0;
    const lo = LABEL + slotIndex * w;
    const hi = lo + w;
    return Math.max(lo + 2, Math.min(hi - 2, center + offset));
  }

  function gatherMarkers() {
    markers = [];
    if (!model) return;
    const byKey = new Map();
    plan.forEach((row, i) => {
      if (row.type === "loop") byKey.set(`${row.block.segmentIndex}:${row.loop}`, i);
    });
    const hitsBySlot = new Map();
    for (const h of model.hits || []) {
      if (h.slotIndex < 0 || h.loop < 0) continue;
      const pi = byKey.get(`${h.segmentIndex ?? 0}:${h.loop}`);
      if (pi == null) continue;
      const key = `${h.loop}:${h.slotIndex}:${h.segmentIndex ?? 0}`;
      const n = (hitsBySlot.get(key) || 0) + 1;
      hitsBySlot.set(key, n);
      markers.push({
        kind: h.type,
        loop: h.loop,
        row: pi,
        slotIndex: h.slotIndex,
        rec: h,
        extra: n > 1,
        block: plan[pi].block,
      });
    }
    for (const e of model.missed || []) {
      const pi = byKey.get(`${e.segmentIndex ?? 0}:${e.loop}`);
      if (pi == null) continue;
      markers.push({
        kind: "missed",
        loop: e.loop,
        row: pi,
        slotIndex: e.slot.index,
        rec: e,
        block: plan[pi].block,
      });
    }
  }

  function columnMeans(block) {
    const n = block.grid.slots.length;
    const acc = Array.from({ length: n }, () => []);
    for (const h of model.hits || []) {
      if (h.type !== "hit" || !h.scored || h.slotIndex < 0) continue;
      if ((h.segmentIndex ?? 0) !== block.segmentIndex && model.blocks) continue;
      acc[h.slotIndex]?.push(h.devMs);
    }
    return acc.map((a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null));
  }

  function drawHead() {
    const cssW = head.clientWidth || root.clientWidth;
    const ctx = sizeCanvas(head, cssW, HEAD);
    const r = dpr();
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, cssW, HEAD);
    if (!model || !plan.length) return;
    const top = scroll.scrollTop;
    let visible = plan[0];
    let acc = 0;
    for (const row of plan) {
      if (acc + row.h > top) {
        visible = row;
        break;
      }
      acc += row.h;
    }
    const block = visible.block;
    const n = block.grid.slots.length;
    const w = colW(cssW, n);
    const means = columnMeans(block);
    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, cssW, HEAD);
    for (let i = 0; i < n; i++) {
      const x = LABEL + i * w;
      const slot = block.grid.slots[i];
      if (!slot.finger) {
        ctx.fillStyle = "rgba(239,68,68,0.08)";
        ctx.fillRect(x, 0, w, HEAD);
      }
      ctx.beginPath();
      ctx.moveTo(x + w / 2, 8);
      ctx.lineTo(x + w / 2, HEAD);
      ctx.strokeStyle = slot.sub === 0 ? (i === 0 ? "#e8e4d9" : "#8b909a") : "#2a3038";
      ctx.lineWidth = slot.sub === 0 ? (i === 0 ? 2 : 1.5) : 1;
      ctx.stroke();
      if (means[i] != null && block.gridStep) {
        const mx = slotX(cssW, block, i, means[i]);
        ctx.fillStyle = FINGER_COLORS[slot.finger] || "#94a3b8";
        ctx.fillRect(mx - 1.5, 4, 3, 10);
      }
    }
    ctx.fillStyle = "#8b909a";
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.fillText(block.label || "mean", 6, 16);
  }

  function drawBody() {
    const cssW = scroll.clientWidth || root.clientWidth;
    const cssH = scroll.clientHeight || 240;
    const ctx = sizeCanvas(body, cssW, cssH);
    const r = dpr();
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!model) return;
    spacer.style.height = Math.max(totalH(), cssH) + "px";
    const top = scroll.scrollTop;
    const maxPeak = (model.hits || []).reduce((m, h) => Math.max(m, h.peak || 0), 1e-6);

    let yAcc = 0;
    for (let i = 0; i < plan.length; i++) {
      const row = plan[i];
      const y = yAcc - top;
      yAcc += row.h;
      if (y + row.h < -4 || y > cssH + 4) continue;

      if (row.type === "header") {
        ctx.fillStyle = "#1c2128";
        ctx.fillRect(0, y, cssW, row.h);
        ctx.fillStyle = "#e8e4d9";
        ctx.font = "12px -apple-system, system-ui, sans-serif";
        ctx.fillText(row.block.label || "pattern", 8, y + 22);
        continue;
      }

      const loop = row.loop;
      const block = row.block;
      const n = block.grid.slots.length;
      const w = colW(cssW, n);
      if (selected && selected.loop === loop && selected.segmentIndex === block.segmentIndex) {
        ctx.fillStyle = "rgba(34,211,238,0.08)";
        ctx.fillRect(0, y, cssW, ROW);
      }
      if (isDropout(loop)) {
        ctx.fillStyle = "rgba(100,116,139,0.12)";
        ctx.fillRect(0, y, cssW, ROW);
      }
      const countInRow = (model.hits || []).some((h) => h.loop === loop && !h.scored)
        || (model.countInLoops && loop < model.countInLoops);
      if (countInRow) {
        ctx.fillStyle = "rgba(245,158,59,0.06)";
        ctx.fillRect(0, y, cssW, ROW);
      }
      ctx.fillStyle = "#8b909a";
      ctx.font = "10px -apple-system, system-ui, sans-serif";
      ctx.fillText(countInRow ? "c-in" : String(loop + 1), 6, y + 18);

      for (let c = 0; c < n; c++) {
        const x = LABEL + c * w;
        const slot = block.grid.slots[c];
        if (!slot.finger) {
          ctx.fillStyle = "rgba(239,68,68,0.05)";
          ctx.fillRect(x, y, w, ROW);
        }
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + ROW);
        ctx.strokeStyle = slot.sub === 0 ? (c === 0 ? "#64748b" : "#3a3f4a") : "#22262c";
        ctx.lineWidth = slot.sub === 0 ? 1.5 : 1;
        ctx.stroke();
      }
      ctx.strokeStyle = "#1c2128";
      ctx.beginPath();
      ctx.moveTo(LABEL, y + ROW);
      ctx.lineTo(cssW, y + ROW);
      ctx.stroke();

      if (replay && replay.loop === loop && replay.segmentIndex === block.segmentIndex) {
        const p = Math.max(0, Math.min(1, replay.progress || 0));
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(LABEL + p * (cssW - LABEL), y + 2);
        ctx.lineTo(LABEL + p * (cssW - LABEL), y + ROW - 2);
        ctx.stroke();
      }
    }

    for (const m of markers) {
      const row = plan[m.row];
      if (!row) continue;
      const y0 = rowOffset(m.row) - top;
      if (y0 + ROW < -4 || y0 > cssH + 4) continue;
      const y = y0 + ROW / 2 + (m.extra || m.kind === "double" ? 5 : 0);
      const rec = m.rec;
      const x = slotX(cssW, m.block, m.slotIndex, rec.devMs || 0);
      if (m.kind === "missed") {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        continue;
      }
      const rad = m.kind === "double" || m.extra
        ? 3
        : 3.5 + 3.5 * ((rec.peak || 0) / maxPeak);
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      if (m.kind === "ghost") {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = FINGER_COLORS[rec.finger] || "#e8e4d9";
        ctx.fill();
        if (rec.accent) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  }

  function draw() {
    drawHead();
    drawBody();
  }

  function rowAt(yAbs) {
    let acc = 0;
    for (const row of plan) {
      if (yAbs >= acc && yAbs < acc + row.h) return row;
      acc += row.h;
    }
    return null;
  }

  function onTap(ev) {
    if (!model) return;
    const rect = body.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top + scroll.scrollTop;
    const row = rowAt(y);
    if (row && row.type === "loop") {
      selected = { loop: row.loop, segmentIndex: row.block.segmentIndex, block: row.block };
      if (playBtn) playBtn.disabled = !model.canReplay?.(selected);
      onSelect?.(selected);
    }
    const cssW = scroll.clientWidth || root.clientWidth;
    let best = null;
    let bestD = 18;
    for (const m of markers) {
      if (m.kind === "missed") continue;
      const mx = slotX(cssW, m.block, m.slotIndex, m.rec.devMs || 0);
      const my = rowOffset(m.row) + ROW / 2;
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best) {
      const h = best.rec;
      const name = FINGER_NAMES[h.finger] || h.type;
      const parts = [
        name,
        `${h.devMs >= 0 ? "+" : ""}${(h.devMs || 0).toFixed(1)} ms`,
        `peak ${h.peak?.toFixed(3) ?? "—"}`,
      ];
      if (model.ratio > 1 && h.heardPeak != null) parts.push(`heard ${h.heardPeak.toFixed(3)}`);
      if (h.centroid) parts.push(`${h.centroid.toFixed(0)} Hz`);
      if (readout) readout.textContent = parts.join(" · ");
    } else if (row && row.type === "loop" && readout) {
      readout.textContent = `loop ${row.loop + 1}${row.block.label ? " · " + row.block.label : ""}`;
    }
    drawBody();
  }

  scroll.addEventListener("scroll", () => {
    drawHead();
    drawBody();
  }, { passive: true });
  body.addEventListener("click", onTap);
  window.addEventListener("resize", () => {
    if (!root.hidden) draw();
  });

  return {
    setModel(next) {
      model = next;
      selected = null;
      replay = null;
      buildPlan();
      gatherMarkers();
      if (readout) readout.textContent = "";
      if (playBtn) playBtn.disabled = true;
      draw();
      requestAnimationFrame(() => {
        scroll.scrollTop = spacer.offsetHeight;
      });
    },
    setOnSelect(fn) {
      onSelect = fn;
    },
    getSelected() {
      return selected;
    },
    setReplay(next) {
      replay = next;
      drawBody();
    },
    resize: draw,
    scrollToEnd() {
      scroll.scrollTop = spacer.offsetHeight;
    },
  };
}
