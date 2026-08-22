import { FINGER_COLORS, FINGER_NAMES, PRESETS } from "../pattern.js";
import { parsePattern } from "../pattern.js";

export function renderFingerBars(el, ema, fingers, micMode) {
  el.innerHTML = fingers.map((fg) => {
    const s = ema[fg] || { timing: 0, attackDb: 0, bright: 0 };
    const tPct = 50 + Math.max(-50, Math.min(50, s.timing * 2));
    const aPct = Math.max(0, Math.min(100, 50 + s.attackDb * 8));
    const bPct = Math.max(0, Math.min(100, 50 + s.bright * 50));
    return `<div class="fbar">
      <span class="fbar-name" style="color:${FINGER_COLORS[fg]}">${FINGER_NAMES[fg]}</span>
      <div class="fbar-col"><i>timing</i><div class="track center"><b style="left:${tPct}%"></b></div></div>
      <div class="fbar-col"><i>attack</i><div class="track"><b style="width:${aPct}%"></b></div></div>
      ${micMode ? "" : `<div class="fbar-col"><i>tone</i><div class="track"><b style="width:${bPct}%"></b></div></div>`}
    </div>`;
  }).join("");
}

export function renderScores(el, scores, diagnosis, micMode, extra = {}) {
  const heard = extra.scoresHeard || null;
  const ratio = extra.ratio || 1;
  const keys = ["timing", "attackEven", "toneEven", "fingerBalance", "clean", "accent"].filter((k) => {
    if (k === "toneEven" && micMode) return false;
    if (k === "accent" && scores[k] == null) return false;
    return scores[k] != null;
  });
  el.innerHTML = keys.map((k) => {
    const v = scores[k];
    const dual = ratio > 1 && heard && (k === "attackEven" || k === "fingerBalance");
    const hv = dual ? heard[k] : null;
    return `<div class="score">
      <span>${k}</span>
      <div class="track">
        <b style="width:${v}%"></b>
        ${hv != null ? `<i class="heard-mark" style="left:${hv}%"></i>` : ""}
      </div>
      <em>${hv != null ? `${v.toFixed(0)} → ${hv.toFixed(0)}` : v.toFixed(0)}</em>
    </div>`;
  }).join("") + `<p class="diag">${(diagnosis || []).join(" · ")}</p>`
    + (extra.tallies ? renderTallyChips(extra.tallies) : "");
}

export function renderTallyChips(t) {
  if (!t) return "";
  return `<p class="tally-chips">● ${t.perfect || 0} perfect · ${t.good || 0} good · ${t.off || 0} off · ${t.missed || 0} miss${t.ghosts ? ` · ${t.ghosts} ghost` : ""}${t.doubles ? ` · ${t.doubles} double` : ""}</p>`;
}

export function renderPickerList(el, presets, custom, currentId, onPick) {
  const rows = [
    ...presets.map((p) => ({ ...p, custom: false })),
    ...custom.map((p) => ({ ...p, custom: true })),
  ];
  el.innerHTML = rows.map((p) => `
    <button class="picker-row ${p.id === currentId ? "on" : ""}" data-id="${p.id}">
      <div>
        <strong>${esc(p.name)}</strong>
        <small>${p.custom ? "custom" : p.groove}</small>
      </div>
      <div class="pat-dots">${renderDots(p.pattern)}</div>
    </button>
  `).join("");
  el.querySelectorAll(".picker-row").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const p = rows.find((r) => r.id === id);
      onPick(p);
    };
  });
}

export function renderSequenceList(el, presets, custom, currentId, onPick) {
  const rows = [
    ...presets.map((s) => ({ ...s, custom: false })),
    ...custom.map((s) => ({ ...s, custom: true })),
  ];
  el.innerHTML = rows.map((s) => `
    <button class="picker-row ${s.id === currentId ? "on" : ""}" data-id="${s.id}">
      <div>
        <strong>${esc(s.name)}</strong>
        <small>${s.custom ? "custom" : s.shuffle ? "shuffle" : `${s.segments.length} segments`}</small>
      </div>
      <div class="pat-dots">${s.segments.map((seg) => `<span class="beat">${esc(seg.id || seg.pattern || "")}</span>`).join(" → ")}</div>
    </button>
  `).join("");
  el.querySelectorAll(".picker-row").forEach((btn) => {
    btn.onclick = () => {
      const s = rows.find((r) => r.id === btn.dataset.id);
      onPick(s);
    };
  });
}

export function renderDots(pattern) {
  return pattern.split(/\s+/).map((beat) => {
    const cells = [...beat].map((ch) => {
      if (ch === "x") return `<i class="dot rest"></i>`;
      const fg = ch.toLowerCase();
      const acc = ch === ch.toUpperCase();
      return `<i class="dot ${acc ? "acc" : ""}" style="background:${FINGER_COLORS[fg]}"></i>`;
    }).join("");
    return `<span class="beat">${cells}</span>`;
  }).join("");
}

export function addSequenceRow(container, catalog, presetId, bars) {
  const row = document.createElement("div");
  row.className = "seq-row";
  const sel = document.createElement("select");
  catalog.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  sel.value = presetId || catalog[0]?.id || "";
  const barsIn = document.createElement("input");
  barsIn.type = "number";
  barsIn.min = "1";
  barsIn.max = "32";
  barsIn.value = String(bars || 4);
  const up = document.createElement("button");
  up.type = "button";
  up.textContent = "↑";
  up.onclick = () => {
    if (row.previousElementSibling) container.insertBefore(row, row.previousElementSibling);
  };
  const down = document.createElement("button");
  down.type = "button";
  down.textContent = "↓";
  down.onclick = () => {
    if (row.nextElementSibling) container.insertBefore(row.nextElementSibling, row);
  };
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "✕";
  del.onclick = () => row.remove();
  row.append(sel, barsIn, up, down, del);
  container.appendChild(row);
}

export function readSequenceForm(nameEl, rowsEl, extras) {
  const segments = [...rowsEl.querySelectorAll(".seq-row")].map((row) => {
    const id = row.querySelector("select").value;
    const bars = +row.querySelector("input").value || 1;
    return { id, bars };
  });
  return {
    name: (nameEl.value || "").trim() || "Custom sequence",
    segments,
    extras,
  };
}

export function bindCustomEditor(input, preview, status, onValid) {
  const run = () => {
    const v = parsePattern(input.value);
    if (!v.ok) {
      status.textContent = v.error;
      status.className = "status bad";
      preview.innerHTML = "";
      onValid(null);
      return;
    }
    status.textContent = `${v.slotsPerBeat} slots/beat · ${v.patternLength} beats`;
    status.className = "status ok";
    preview.innerHTML = renderDots(v.pattern);
    onValid(v);
  };
  input.addEventListener("input", run);
  run();
}

export function renderSummary(el, summary, config) {
  const { out, balance, scores, diagnosis, cleanliness } = summary;
  const rows = Object.entries(out).map(([k, v]) => `
    <tr>
      <td>${FINGER_NAMES[k] || k}</td>
      <td>${v.n}</td>
      <td>${v.meanDev >= 0 ? "+" : ""}${v.meanDev.toFixed(1)}</td>
      <td>${v.jitter.toFixed(1)}</td>
      <td>${v.peakMean.toFixed(3)}</td>
      <td>${(v.peakCV * 100).toFixed(0)}%</td>
      <td>${v.centroidMean.toFixed(0)}</td>
    </tr>`).join("");
  el.innerHTML = `
    <p class="meta">${config.bpm} BPM · ${esc(config.pattern)}</p>
    <table>
      <thead><tr><th>finger</th><th>n</th><th>mean ms</th><th>jitter</th><th>peak</th><th>peak cv</th><th>centroid</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p>loudest vs quietest: ${balance.peakSpreadDb.toFixed(1)} dB ·
       timing spread: ${balance.timingSpreadMs.toFixed(1)} ms ·
       ghosts ${cleanliness.ghosts} / missed ${cleanliness.missed} / doubles ${cleanliness.doubles}</p>
    <p>scores:
      ${Object.entries(scores).map(([k, v]) => {
        const hv = summary.scoresHeard && (k === "attackEven" || k === "fingerBalance") ? summary.scoresHeard[k] : null;
        return hv != null ? `${k} ${v.toFixed(0)}→${hv.toFixed(0)}` : `${k} ${v.toFixed(0)}`;
      }).join(" · ")}
    </p>
    ${compLine(summary)}
    ${summary.bestStreak != null ? `<p>best streak ×${summary.bestStreak}${summary.tallies ? " · " + `${summary.tallies.perfect} perfect / ${summary.tallies.good} good` : ""}</p>` : ""}
    ${segmentTable(summary)}
    <p class="diag">${diagnosis.join(" · ")}</p>
    <div class="hists"></div>
  `;
}

function segmentTable(summary) {
  const rows = summary.perSegment;
  if (!rows?.length) return "";
  const tr = rows.map((s) => `
    <tr>
      <td>${esc(s.name || s.pattern)}</td>
      <td>${s.n}</td>
      <td>${s.timing.toFixed(0)}</td>
      <td>${s.clean.toFixed(0)}</td>
      <td>${s.attackEven.toFixed(0)}</td>
    </tr>`).join("");
  const tj = summary.transition;
  const trans = tj
    ? `<p>transition jitter ${tj.firstBarJitter.toFixed(1)} ms vs steady ${tj.steadyJitter.toFixed(1)} ms</p>`
    : "";
  return `
    <h3>Per segment</h3>
    <table>
      <thead><tr><th>pattern</th><th>n</th><th>timing</th><th>clean</th><th>attack</th></tr></thead>
      <tbody>${tr}</tbody>
    </table>
    ${trans}`;
}

function compLine(summary) {
  const c = summary.compression;
  if (!c || c.ratio <= 1) return "";
  const thr = c.thresholdDb == null ? "—" : `${c.thresholdDb.toFixed(1)} dBFS`;
  const dep = summary.dependence == null ? 0 : summary.dependence;
  return `<p>compression ${c.ratio}:1 · dependence +${dep.toFixed(0)} · threshold ${thr}</p>`;
}

export function renderHistory(el, sessions, onOpen) {
  if (!sessions.length) {
    el.innerHTML = "<p class='empty'>No saved sessions yet.</p>";
    return;
  }
  el.innerHTML = sessions.map((s) => {
    const sc = s.summary?.scores || {};
    const d = new Date(s.startedAt);
    return `<button class="hist-row" data-id="${s.id}">
      <strong>${d.toLocaleString()}</strong>
      <span>${esc(s.config?.pattern || "")} @ ${s.config?.bpm}</span>
      <em>T ${fmt(sc.timing)} · A ${fmt(sc.attackEven)} · C ${fmt(sc.clean)}${s.summary?.bestStreak ? ` · ×${s.summary.bestStreak}` : ""}</em>`
    </button>`;
  }).join("");
  el.querySelectorAll(".hist-row").forEach((b) => {
    b.onclick = () => onOpen(b.dataset.id);
  });
}

export function renderHistoryChart(canvas, sessions, patternId) {
  const rows = sessions.filter((s) => s.config?.patternId === patternId).slice().reverse();
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (rows.length < 1) return;
  const pad = 20 * dpr;
  const W = canvas.width - pad * 2;
  const H = canvas.height - pad * 2;
  const series = [
    { key: (s) => s.summary?.scores?.timing, color: "#22d3ee" },
    { key: (s) => s.summary?.scores?.clean, color: "#4ade80" },
    { key: (s) => s.config?.bpm, color: "#f59e3b", norm: true },
  ];
  const bpms = rows.map((s) => s.config?.bpm || 0);
  const bMin = Math.min(...bpms);
  const bMax = Math.max(...bpms, bMin + 1);
  series.forEach((ser) => {
    ctx.beginPath();
    ctx.strokeStyle = ser.color;
    ctx.lineWidth = 2 * dpr;
    rows.forEach((s, i) => {
      let v = ser.key(s) ?? 0;
      if (ser.norm) v = ((v - bMin) / (bMax - bMin)) * 100;
      const x = pad + (i / Math.max(1, rows.length - 1)) * W;
      const y = pad + H - (v / 100) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

function fmt(v) {
  return v == null ? "–" : Number(v).toFixed(0);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export { PRESETS };
