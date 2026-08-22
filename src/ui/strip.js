import { FINGER_COLORS } from "../pattern.js";

export function createStrip(canvas) {
  const hits = [];
  let lastDraw = 0;
  let restSubs = new Set();
  let slotsPerBeat = 3;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }

  function setGrid(grid) {
    slotsPerBeat = grid.slotsPerBeat;
    restSubs = new Set(grid.slots.filter((s) => !s.finger).map((s) => s.sub));
  }

  function add(rec) {
    hits.push(rec);
    if (hits.length > 32) hits.shift();
  }

  function draw(gridStep) {
    const now = performance.now();
    if (now - lastDraw < 8) return;
    lastDraw = now;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const n = 32;
    const col = W / n;
    const base = H * 0.85;

    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < n; i++) {
      const x = i * col;
      const sub = i % slotsPerBeat;
      if (restSubs.has(sub)) {
        ctx.fillStyle = "rgba(239,68,68,0.06)";
        ctx.fillRect(x, 0, col, H);
      }
      if (sub === 0) {
        ctx.strokeStyle = "#2a3038";
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }

    const maxPeak = hits.reduce((m, h) => Math.max(m, h.peak), 1e-6);
    hits.forEach((h, i) => {
      const x0 = (n - hits.length + i) * col + col / 2;
      const nudge = (h.devMs / 1000 / gridStep) / 0.25 * (col / 2);
      const x = x0 + nudge;
      const ht = (h.peak / maxPeak) * H * 0.7;
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x, base - ht);
      if (h.type === "ghost") {
        ctx.strokeStyle = "#ef4444";
      } else {
        ctx.strokeStyle = FINGER_COLORS[h.finger] || "#94a3b8";
      }
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, base - ht, 4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = h.type === "ghost" ? "#ef4444" : (FINGER_COLORS[h.finger] || "#94a3b8");
      ctx.fill();
    });
  }

  return {
    resize, setGrid, add, draw,
    reset() { hits.length = 0; },
  };
}
