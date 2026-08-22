import { FINGER_COLORS, FINGER_NAMES } from "../pattern.js";
import { mergePerSlot, problemSlot } from "../scoring.js";

const LABEL = 88;
const HEAD = 36;
const ROW = 26;

export function createHeatmap(canvas) {
  let model = null;
  let metric = "meanDev";
  let readout = "";

  function dpr() {
    return window.devicePixelRatio || 1;
  }

  function size() {
    const cssW = canvas.clientWidth || 320;
    const rows = model ? model.rows.length + 1 : 1;
    const cssH = HEAD + rows * ROW + 8;
    const r = dpr();
    canvas.width = Math.round(cssW * r);
    canvas.height = Math.round(cssH * r);
    canvas.style.height = cssH + "px";
    return { ctx: canvas.getContext("2d"), cssW, cssH, r };
  }

  function cellValue(cell) {
    if (!cell) return null;
    if (metric === "meanDev") return Math.abs(cell.meanDev);
    if (metric === "jitter") return cell.jitter;
    if (metric === "missRate") return cell.missRate;
    if (metric === "ghostRate") return cell.ghostRate;
    return null;
  }

  function colorFor(v, max) {
    if (v == null || max <= 0) return "#1c2128";
    const t = Math.max(0, Math.min(1, v / max));
    const r = Math.round(74 + t * (239 - 74));
    const g = Math.round(222 - t * (222 - 68));
    const b = Math.round(128 - t * (128 - 68));
    return `rgb(${r},${g},${b})`;
  }

  function draw() {
    const { ctx, cssW, cssH, r } = size();
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, cssW, cssH);
    if (!model?.slots?.length) return;

    const slots = model.slots;
    const n = slots.length;
    const colW = (cssW - LABEL) / n;
    const rows = model.rows;
    const values = [];
    for (const row of rows) {
      for (let i = 0; i < n; i++) {
        const rest = !slots[i].finger;
        const v = rest && metric !== "ghostRate" && metric !== "missRate"
          ? null
          : cellValue(row.perSlot?.[i]);
        if (v != null) values.push(v);
      }
    }
    const max = Math.max(...values, 1e-9);

    ctx.font = "10px -apple-system, system-ui, sans-serif";
    for (let i = 0; i < n; i++) {
      const x = LABEL + i * colW;
      const slot = slots[i];
      if (!slot.finger) {
        ctx.fillStyle = "rgba(239,68,68,0.08)";
        ctx.fillRect(x, 0, colW, HEAD);
        ctx.strokeStyle = "#64748b";
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(x + 2, 6, colW - 4, HEAD - 12);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = FINGER_COLORS[slot.finger];
        ctx.beginPath();
        ctx.arc(x + colW / 2, 16, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    rows.forEach((row, ri) => {
      const y = HEAD + ri * ROW;
      ctx.fillStyle = ri === 0 ? "#e8e4d9" : "#8b909a";
      ctx.font = ri === 0 ? "bold 10px -apple-system, system-ui, sans-serif" : "10px -apple-system, system-ui, sans-serif";
      ctx.fillText(row.label, 4, y + 17);
      for (let i = 0; i < n; i++) {
        const x = LABEL + i * colW;
        const slot = slots[i];
        const cell = row.perSlot?.[i];
        const blank = !row.perSlot;
        const rest = !slot.finger;
        const v = blank ? null : cellValue(cell);
        ctx.fillStyle = blank ? "#0c0d10" : colorFor(v, max);
        ctx.fillRect(x + 1, y + 2, colW - 2, ROW - 4);
        if (rest) {
          ctx.strokeStyle = "#3a3f4a";
          ctx.setLineDash([2, 2]);
          ctx.strokeRect(x + 1, y + 2, colW - 2, ROW - 4);
          ctx.setLineDash([]);
        }
      }
    });
    void cssH;
  }

  function onTap(ev) {
    if (!model) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const n = model.slots.length;
    const colW = (rect.width - LABEL) / n;
    const i = Math.floor((x - LABEL) / colW);
    const ri = Math.floor((y - HEAD) / ROW);
    if (i < 0 || i >= n || ri < 0 || ri >= model.rows.length) {
      readout = "";
      return;
    }
    const cell = model.rows[ri].perSlot?.[i];
    if (!cell) {
      readout = `${model.rows[ri].label} · slot ${i} — no data`;
      return;
    }
    const slot = model.slots[i];
    const name = slot.finger ? FINGER_NAMES[slot.finger] : "rest";
    readout = `${model.rows[ri].label} · slot ${i} (${name}) · |dev| ${Math.abs(cell.meanDev).toFixed(1)} ms · jitter ${cell.jitter.toFixed(1)} · miss ${(cell.missRate * 100).toFixed(0)}% · ghost ${(cell.ghostRate * 100).toFixed(0)}%`;
  }

  canvas.addEventListener("click", (ev) => {
    onTap(ev);
    if (model?.onReadout) model.onReadout(readout);
  });

  return {
    setModel(next) {
      model = next;
      draw();
    },
    setMetric(m) {
      metric = m;
      draw();
    },
    getMetric() {
      return metric;
    },
    getReadout() {
      return readout;
    },
    resize: draw,
  };
}

export function heatmapModel(pattern, slots, sessions, onReadout) {
  const matching = sessions.filter((s) => {
    if (!s.summary) return true;
    if (s.config?.pattern === pattern) return true;
    if (s.summary.perSlotByPattern && s.summary.perSlotByPattern[pattern]) return true;
    return s.config?.pattern === pattern;
  });
  const rows = [];
  const aggs = [];
  for (const s of matching) {
    const perSlot = s.config?.pattern === pattern
      ? s.summary?.perSlot
      : s.summary?.perSlotByPattern?.[pattern];
    if (perSlot) aggs.push(perSlot);
    const d = s.startedAt ? new Date(s.startedAt) : null;
    rows.push({
      id: s.id,
      label: d ? d.toLocaleDateString() : "session",
      perSlot: perSlot || null,
    });
  }
  const allTime = aggs.length ? mergePerSlot(aggs) : null;
  rows.unshift({ id: "all", label: "all-time", perSlot: allTime });
  const callout = (() => {
    if (!allTime) return "";
    const p = problemSlot(allTime, slots);
    if (!p) return "";
    const name = FINGER_NAMES[p.slot.finger] || p.slot.finger;
    return `problem slot: ${p.index} (${name}) — ${(p.cell.missRate * 100).toFixed(0)}% missed across ${aggs.length} sessions`;
  })();
  return { slots, rows, callout, onReadout };
}
