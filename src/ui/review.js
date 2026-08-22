import { FINGER_COLORS, FINGER_NAMES } from "../pattern.js";

const ROW = 28;
const LABEL = 56;
const HEAD = 40;

export function createReview(root) {
  const head = root.querySelector(".review-head");
  const scroll = root.querySelector(".review-scroll");
  const body = root.querySelector(".review-body");
  const spacer = root.querySelector(".review-spacer");
  const readout = root.querySelector(".review-readout");
  let model = null;
  let markers = [];

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

  function cols() {
    return model?.grid?.slots.length || 1;
  }

  function colW(cssW) {
    return (cssW - LABEL) / cols();
  }

  function loopList() {
    if (!model) return [];
    const loops = [];
    for (const h of model.hits) if (h.loop >= 0) loops.push(h.loop);
    for (const e of model.missed || []) if (e.loop >= 0) loops.push(e.loop);
    if (!loops.length) return [];
    const min = Math.min(...loops);
    const max = Math.max(...loops);
    const out = [];
    for (let L = min; L <= max; L++) out.push(L);
    return out;
  }

  function isDropout(loop) {
    const bars = model.dropoutBars || 0;
    const every = model.dropoutEvery || 8;
    if (!bars) return false;
    return loop % every >= every - bars;
  }

  function slotX(cssW, slotIndex, devMs) {
    const w = colW(cssW);
    const step = model.gridStep;
    const center = LABEL + slotIndex * w + w / 2;
    const offset = step ? (devMs / 1000 / step) * w : 0;
    const lo = LABEL + slotIndex * w;
    const hi = lo + w;
    return Math.max(lo + 2, Math.min(hi - 2, center + offset));
  }

  function gatherMarkers() {
    markers = [];
    if (!model) return;
    const loops = loopList();
    const byLoop = new Map(loops.map((L, i) => [L, i]));
    const hitsBySlot = new Map();
    for (const h of model.hits) {
      if (h.slotIndex < 0 || h.loop < 0) continue;
      const key = `${h.loop}:${h.slotIndex}`;
      const n = (hitsBySlot.get(key) || 0) + 1;
      hitsBySlot.set(key, n);
      markers.push({
        kind: h.type,
        loop: h.loop,
        row: byLoop.get(h.loop),
        slotIndex: h.slotIndex,
        rec: h,
        extra: n > 1,
      });
    }
    for (const e of model.missed || []) {
      markers.push({
        kind: "missed",
        loop: e.loop,
        row: byLoop.get(e.loop),
        slotIndex: e.slot.index,
        rec: e,
      });
    }
  }

  function columnMeans() {
    const n = cols();
    const acc = Array.from({ length: n }, () => []);
    for (const h of model.hits) {
      if (h.type === "hit" && h.scored && h.slotIndex >= 0) acc[h.slotIndex]?.push(h.devMs);
    }
    return acc.map((a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null));
  }

  function drawHead() {
    const cssW = head.clientWidth || root.clientWidth;
    const ctx = sizeCanvas(head, cssW, HEAD);
    const r = dpr();
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, cssW, HEAD);
    if (!model) return;
    const n = cols();
    const w = colW(cssW);
    const means = columnMeans();
    const step = model.gridStep;
    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, cssW, HEAD);
    for (let i = 0; i < n; i++) {
      const x = LABEL + i * w;
      const slot = model.grid.slots[i];
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
      if (means[i] != null && step) {
        const mx = slotX(cssW, i, means[i]);
        ctx.fillStyle = FINGER_COLORS[slot.finger] || "#94a3b8";
        ctx.fillRect(mx - 1.5, 4, 3, 10);
      }
    }
    ctx.fillStyle = "#8b909a";
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.fillText("mean", 6, 16);
  }

  function drawBody() {
    const cssW = scroll.clientWidth || root.clientWidth;
    const cssH = scroll.clientHeight || 240;
    const ctx = sizeCanvas(body, cssW, cssH);
    const r = dpr();
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!model) return;
    const loops = loopList();
    spacer.style.height = Math.max(loops.length * ROW, cssH) + "px";
    const n = cols();
    const w = colW(cssW);
    const top = scroll.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW) - 1);
    const last = Math.min(loops.length - 1, Math.ceil((top + cssH) / ROW) + 1);
    const maxPeak = model.hits.reduce((m, h) => Math.max(m, h.peak || 0), 1e-6);

    for (let row = first; row <= last; row++) {
      const loop = loops[row];
      const y = row * ROW - top;
      if (isDropout(loop)) {
        ctx.fillStyle = "rgba(100,116,139,0.12)";
        ctx.fillRect(0, y, cssW, ROW);
      }
      const countInRow = model.hits.some((h) => h.loop === loop && !h.scored)
        || (model.countInLoops && loop < model.countInLoops);
      if (countInRow) {
        ctx.fillStyle = "rgba(245,158,59,0.06)";
        ctx.fillRect(0, y, cssW, ROW);
      }
      ctx.fillStyle = "#8b909a";
      ctx.font = "10px -apple-system, system-ui, sans-serif";
      ctx.fillText(countInRow ? "c-in" : String(loop + 1), 6, y + 18);

      for (let i = 0; i < n; i++) {
        const x = LABEL + i * w;
        const slot = model.grid.slots[i];
        if (!slot.finger) {
          ctx.fillStyle = "rgba(239,68,68,0.05)";
          ctx.fillRect(x, y, w, ROW);
        }
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + ROW);
        ctx.strokeStyle = slot.sub === 0 ? (i === 0 ? "#64748b" : "#3a3f4a") : "#22262c";
        ctx.lineWidth = slot.sub === 0 ? 1.5 : 1;
        ctx.stroke();
      }
      ctx.strokeStyle = "#1c2128";
      ctx.beginPath();
      ctx.moveTo(LABEL, y + ROW);
      ctx.lineTo(cssW, y + ROW);
      ctx.stroke();
    }

    for (const m of markers) {
      if (m.row == null || m.row < first || m.row > last) continue;
      const y = m.row * ROW - top + ROW / 2 + (m.extra || m.kind === "double" ? 5 : 0);
      const rec = m.rec;
      const x = slotX(cssW, m.slotIndex, rec.devMs || 0);
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

  function onTap(ev) {
    if (!model) return;
    const rect = body.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top + scroll.scrollTop;
    const cssW = scroll.clientWidth || root.clientWidth;
    let best = null;
    let bestD = 18;
    for (const m of markers) {
      if (m.row == null || m.kind === "missed") continue;
      const mx = slotX(cssW, m.slotIndex, m.rec.devMs || 0);
      const my = m.row * ROW + ROW / 2;
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (!best) {
      readout.textContent = "";
      return;
    }
    const h = best.rec;
    const name = FINGER_NAMES[h.finger] || h.type;
    const parts = [
      name,
      `${h.devMs >= 0 ? "+" : ""}${(h.devMs || 0).toFixed(1)} ms`,
      `peak ${h.peak?.toFixed(3) ?? "—"}`,
    ];
    if (model.ratio > 1 && h.heardPeak != null) parts.push(`heard ${h.heardPeak.toFixed(3)}`);
    if (h.centroid) parts.push(`${h.centroid.toFixed(0)} Hz`);
    readout.textContent = parts.join(" · ");
  }

  scroll.addEventListener("scroll", drawBody, { passive: true });
  body.addEventListener("click", onTap);
  window.addEventListener("resize", () => {
    if (!root.hidden) draw();
  });

  return {
    setModel(next) {
      model = next;
      gatherMarkers();
      readout.textContent = "";
      draw();
      requestAnimationFrame(() => {
        scroll.scrollTop = spacer.offsetHeight;
      });
    },
    resize: draw,
    scrollToEnd() {
      scroll.scrollTop = spacer.offsetHeight;
    },
  };
}
