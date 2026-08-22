import {
  createAudioContext, resumeContext, requestInputStream, listInputDevices,
  trackSettings, describeSettings, loadWorklet,
} from "./audio/context.js";
import { attackFeatures, dbfs } from "./audio/dsp.js";
import { createScheduler } from "./audio/scheduler.js";
import { playBuf } from "./audio/synth.js";
import { createTakeRing, framesForRange } from "./audio/ring.js";
import { deriveSlots, parsePattern, PRESETS, SEQUENCE_PRESETS, FINGER_COLORS, hydrateSequence, validateSequence, findPattern } from "./pattern.js";
import { pickNextSegmentIndex, segmentBoundary } from "./sequence.js";
import { createScorer, hitsToCsv, aggregatePerSlot, perSlotByPattern, summarizeSegments } from "./scoring.js";
import {
  saveSession, listSessions, loadCustomPatterns, saveCustomPattern,
  loadCalibration, saveCalibration, loadSettings, saveSettings,
  loadCustomSequences, saveCustomSequence,
} from "./store.js";
import { createClock } from "./ui/clock.js";
import { createStrip } from "./ui/strip.js";
import { createHighway } from "./ui/highway.js";
import { createReview } from "./ui/review.js";
import { createHeatmap, heatmapModel } from "./ui/heatmap.js";
import {
  renderFingerBars, renderScores, renderPickerList, bindCustomEditor,
  renderSummary, renderHistory, renderHistoryChart, renderDots,
  renderSequenceList, addSequenceRow, readSequenceForm,
} from "./ui/panels.js";

const $ = (id) => document.getElementById(id);

const settings = Object.assign({
  countInBars: 1,
  dropoutBars: 0,
  dropoutEvery: 8,
  rampEnabled: false,
  bpmStep: 4,
  everyBars: 8,
  requireClean: true,
  ticksOn: true,
  accentRatio: 1.3,
  windowBars: 8,
  inputMode: "di",
  sensitivity: 0.15,
  deviceId: "",
  latencyCompMs: 0,
  compressionRatio: 1,
}, loadSettings());

const state = {
  phase: "idle", // idle | armed | countIn | running | paused | ended
  ctx: null,
  worklet: null,
  stream: null,
  source: null,
  scheduler: null,
  scorer: createScorer(),
  grid: null,
  config: null,
  sessionStart: 0,
  startedAt: null,
  patternId: settings.patternId || "trip",
  pattern: settings.pattern || PRESETS[0].pattern,
  groove: settings.groove || PRESETS[0].groove,
  cycle: PRESETS[0].cycle || null,
  bpm: settings.bpm || 80,
  peakRoll: 1e-4,
  ema: {},
  lastScores: null,
  barsDone: 0,
  wakeLock: null,
  tapTimes: [],
  raf: 0,
  lastMeterPeak: 0,
  devices: [],
  sessionLoopOffset: 0,
  barsAtSegmentStart: 0,
  segmentCountIn: 1,
  nextLoop: 0,
  review: null,
  heatmap: null,
  mode: settings.sequenceId ? "sequence" : "pattern",
  sequenceId: settings.sequenceId || null,
  sequence: null,
  segmentIndex: 0,
  segmentStart: 0,
  pendingSwitch: null,
  gateNote: "",
  takeRing: null,
  streakPulse: 0,
  replayTimer: 0,
  replayRange: null,
};

if (new URLSearchParams(location.search).get("dev") === "analyze") {
  const { mountAnalyze } = await import("../dev/analyze-file.js");
  mountAnalyze(document.getElementById("app"));
} else {
  boot();
}

function boot() {
  const clock = createClock($("clock"));
  const strip = createStrip($("strip"));
  const highway = createHighway($("highway"));
  state.clock = clock;
  state.strip = strip;
  state.highway = highway;
  state.review = createReview($("review-wrap"));
  state.heatmap = createHeatmap($("heatmap"));
  if (state.sequenceId) {
    const seq = [...SEQUENCE_PRESETS, ...loadCustomSequences()].find((s) => s.id === state.sequenceId);
    if (seq) state.sequence = hydrateSequence(seq, loadCustomPatterns());
  }

  bindTransport();
  bindModals();
  fillPatternLabel();
  applySettingsToForm();
  state.scorer.setRatio(settings.compressionRatio || 1);
  updateMeter(0, 0);
  clock.resize();
  strip.resize();
  highway.resize();
  window.addEventListener("resize", () => {
    clock.resize();
    strip.resize();
    highway.resize();
    state.heatmap?.resize();
  });

  document.addEventListener("visibilitychange", onVisibility);
  $("resume").onclick = async () => {
    $("resume").hidden = true;
    if (state.phase === "paused") await resumeSession();
    else if (state.ctx) await resumeContext(state.ctx);
  };

  logM0("ready — tap Start (needs a user gesture for audio)");
}

function bindTransport() {
  $("start").onclick = onStartStop;
  $("bpm-up").onclick = () => setBpm(state.bpm + 2);
  $("bpm-down").onclick = () => setBpm(state.bpm - 2);
  $("bpm-val").onclick = () => {
    const v = prompt("BPM", String(state.bpm));
    if (v) setBpm(Number(v));
  };
  $("tap").onclick = onTapTempo;
  $("pattern-btn").onclick = () => openModal("picker");
  $("groove").value = state.groove;
  $("groove").onchange = () => {
    state.groove = $("groove").value;
    persistUi();
  };
  $("settings-btn").onclick = () => openModal("settings");
  $("history-btn").onclick = openHistory;
  $("end").onclick = () => endSession(true);
  $("pause").onclick = () => {
    if (state.phase === "paused") resumeSession();
    else pauseSession();
  };
}

function bindModals() {
  document.querySelectorAll("[data-close]").forEach((b) => {
    b.onclick = () => closeModal(b.dataset.close);
  });
  const custom = loadCustomPatterns();
  renderPickerList($("picker-list"), PRESETS, custom, state.patternId, pickPattern);
  bindCustomEditor($("custom-pat"), $("custom-preview"), $("custom-status"), (v) => {
    $("save-custom").disabled = !v;
    $("save-custom")._valid = v;
  });
  $("save-custom").onclick = () => {
    const v = $("save-custom")._valid;
    const name = $("custom-name").value.trim() || "Custom";
    if (!v) return;
    const p = { id: "c-" + Date.now(), name, pattern: v.pattern, groove: state.groove };
    saveCustomPattern(p);
    renderPickerList($("picker-list"), PRESETS, loadCustomPatterns(), p.id, pickPattern);
    pickPattern(p);
  };
  $("set-save").onclick = () => {
    readSettingsForm();
    closeModal("settings");
  };
  $("cal-apply").onclick = applyManualCal;
  $("cal-auto").onclick = startAutoCal;
  $("export-csv").onclick = exportCsv;
  $("save-session").onclick = () => endSession(true);
  $("open-review").onclick = () => {
    closeModal("summary");
    showReview();
  };
  bindSequenceUi();
  $("replay-last8").onclick = () => replayLastBars(8);
  $("replay-row").onclick = () => {
    const sel = state.review.getSelected();
    if (sel) replayLoop(sel);
  };
  state.review.setOnSelect((sel) => {
    $("replay-row").disabled = !canReplaySelection(sel);
  });
  document.querySelectorAll("#heatmap-metrics [data-metric]").forEach((b) => {
    b.onclick = () => {
      state.heatmap.setMetric(b.dataset.metric);
      $("heatmap-readout").textContent = state.heatmap.getReadout();
    };
  });
}

function bindSequenceUi() {
  const catalog = [...PRESETS, ...loadCustomPatterns()];
  renderSequenceList($("seq-list"), SEQUENCE_PRESETS, loadCustomSequences(), state.sequenceId, pickSequence);
  addSequenceRow($("seq-rows"), catalog, "trip", 4);
  $("seq-add-row").onclick = () => addSequenceRow($("seq-rows"), [...PRESETS, ...loadCustomPatterns()], "trip", 4);
  $("save-seq").onclick = () => {
    const raw = readSequenceForm($("seq-name"), $("seq-rows"));
    const draft = {
      id: "s-" + Date.now(),
      name: raw.name,
      loop: $("seq-loop").checked,
      shuffle: $("seq-shuffle").checked,
      gate: { enabled: $("seq-gate").checked, cleanMin: +$("seq-gate-min").value || 80 },
      segments: raw.segments,
    };
    const v = validateSequence(draft);
    if (!v.ok) {
      $("warn").hidden = false;
      $("warn").textContent = v.error;
      return;
    }
    saveCustomSequence(draft);
    renderSequenceList($("seq-list"), SEQUENCE_PRESETS, loadCustomSequences(), draft.id, pickSequence);
    pickSequence(draft);
  };
}

function pickPattern(p) {
  state.mode = "pattern";
  state.sequence = null;
  state.sequenceId = null;
  state.patternId = p.id;
  state.pattern = p.pattern;
  state.groove = p.groove || state.groove;
  state.cycle = p.cycle || inferCycle(p.pattern);
  $("groove").value = state.groove;
  fillPatternLabel();
  persistUi();
  closeModal("picker");
}

function pickSequence(seq) {
  state.mode = "sequence";
  state.sequence = hydrateSequence(seq, loadCustomPatterns());
  state.sequenceId = seq.id;
  const first = state.sequence.segments[0];
  state.patternId = first.id;
  state.pattern = first.pattern;
  state.groove = first.groove;
  state.cycle = inferCycle(first.pattern);
  $("groove").value = state.groove;
  fillPatternLabel();
  persistUi();
  closeModal("picker");
}

function inferCycle(pattern) {
  const letters = [...pattern.replace(/\s+/g, "")].filter((c) => c !== "x").map((c) => c.toLowerCase());
  const uniq = [...new Set(letters)];
  return uniq.join("") || null;
}

function fillPatternLabel() {
  if (state.sequence) {
    $("pattern-btn").innerHTML = `<strong>${state.sequence.name}</strong><span class="pat-dots">${state.sequence.segments.map((s) => s.name).join(" → ")}</span>`;
    return;
  }
  const p = [...PRESETS, ...loadCustomPatterns()].find((x) => x.id === state.patternId);
  $("pattern-btn").innerHTML = `<strong>${p ? p.name : "Pattern"}</strong><span class="pat-dots">${renderDots(state.pattern)}</span>`;
}

function setBpm(v) {
  state.bpm = Math.min(300, Math.max(30, Math.round(v)));
  $("bpm-val").textContent = String(state.bpm);
  persistUi();
  if (state.worklet && state.grid) {
    const step = 60 / state.bpm / state.grid.slotsPerBeat;
    state.worklet.port.postMessage({ type: "config", minGapS: 0.5 * step, relThr: relThr() });
  }
  if (state.scheduler && (state.phase === "running" || state.phase === "countIn")) {
    state.scheduler.setBpmAt(state.bpm, state.ctx.currentTime + 0.05);
    state.grid = deriveSlots(state.pattern, state.bpm);
    state.clock.setGrid(state.grid);
    state.strip.setGrid(state.grid);
    state.highway.setGrid(state.grid);
  }
}

function onTapTempo() {
  const t = performance.now();
  state.tapTimes.push(t);
  state.tapTimes = state.tapTimes.filter((x) => t - x < 3000);
  if (state.tapTimes.length >= 2) {
    const dts = [];
    for (let i = 1; i < state.tapTimes.length; i++) dts.push(state.tapTimes[i] - state.tapTimes[i - 1]);
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
    setBpm(60000 / avg);
  }
}

function persistUi() {
  saveSettings({
    ...settings,
    patternId: state.patternId,
    pattern: state.pattern,
    groove: state.groove,
    bpm: state.bpm,
    sequenceId: state.sequenceId,
  });
}

function readSettingsForm() {
  settings.countInBars = +$("set-countin").value;
  settings.dropoutBars = +$("set-dropbars").value;
  settings.dropoutEvery = +$("set-dropevery").value;
  settings.rampEnabled = $("set-ramp").checked;
  settings.bpmStep = +$("set-rampstep").value;
  settings.everyBars = +$("set-rampbars").value;
  settings.requireClean = $("set-rampclean").checked;
  settings.ticksOn = $("set-ticks").checked;
  settings.accentRatio = +$("set-accent").value;
  settings.windowBars = +$("set-window").value;
  settings.inputMode = $("set-mode").value;
  settings.sensitivity = +$("set-sens").value;
  settings.deviceId = $("set-device").value;
  settings.latencyCompMs = +$("set-lat").value;
  settings.compressionRatio = +$("set-comp").value || 1;
  saveSettings({ ...settings, patternId: state.patternId, pattern: state.pattern, groove: state.groove, bpm: state.bpm, sequenceId: state.sequenceId });
  if (state.worklet) {
    state.worklet.port.postMessage({ type: "config", relThr: relThr() });
  }
  if (state.scheduler) state.scheduler.setTicks(settings.ticksOn);
  state.scorer.setRatio(settings.compressionRatio);
  $("lat-badge").textContent = `${settings.latencyCompMs.toFixed(0)} ms`;
}

function applySettingsToForm() {
  $("set-countin").value = settings.countInBars;
  $("set-dropbars").value = settings.dropoutBars;
  $("set-dropevery").value = settings.dropoutEvery;
  $("set-ramp").checked = settings.rampEnabled;
  $("set-rampstep").value = settings.bpmStep;
  $("set-rampbars").value = settings.everyBars;
  $("set-rampclean").checked = settings.requireClean;
  $("set-ticks").checked = settings.ticksOn;
  $("set-accent").value = settings.accentRatio;
  $("set-window").value = settings.windowBars;
  $("set-mode").value = settings.inputMode;
  $("set-sens").value = settings.sensitivity;
  $("set-lat").value = settings.latencyCompMs;
  $("set-comp").value = String(settings.compressionRatio || 1);
  $("bpm-val").textContent = String(state.bpm);
  $("lat-badge").textContent = `${settings.latencyCompMs.toFixed(0)} ms`;
  $("groove").value = state.groove;
}

function relThr() {
  if (settings.inputMode === "mic") return settings.sensitivity || 0.25;
  return 0.15;
}

async function onStartStop() {
  if (state.phase === "idle" || state.phase === "ended") await startSession();
  else endSession(false);
}

async function ensureAudio() {
  if (!state.ctx) state.ctx = createAudioContext();
  await resumeContext(state.ctx);
  if (!state.worklet) {
    state.worklet = await loadWorklet(state.ctx);
    state.worklet.port.onmessage = onWorklet;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.source?.disconnect();
  }
  state.stream = await requestInputStream(settings.deviceId || undefined);
  state.source = state.ctx.createMediaStreamSource(state.stream);
  state.source.connect(state.worklet);
  const settingsNow = trackSettings(state.stream);
  const desc = describeSettings(settingsNow);
  logM0(`sampleRate ${state.ctx.sampleRate}`);
  logM0(`track.getSettings() ${JSON.stringify(settingsNow)}`);
  if (!desc.ok) {
    logM0(`WARNING voice processing still on: ${desc.bad.join(", ")} — do not trust attack/tone`);
    $("warn").textContent = `Voice processing ON (${desc.bad.join(", ")}). Attack/tone will be wrong.`;
    $("warn").hidden = false;
  } else {
    $("warn").hidden = true;
  }
  $("sr-badge").textContent = `${state.ctx.sampleRate} Hz`;
  await refreshDevices();
  const label = state.devices.find((d) => d.deviceId === settingsNow.deviceId)?.label || settingsNow.deviceId || "input";
  $("dev-badge").textContent = label;
  const cals = loadCalibration();
  if (cals[settingsNow.deviceId] != null) {
    settings.latencyCompMs = cals[settingsNow.deviceId];
    $("set-lat").value = settings.latencyCompMs;
    $("lat-badge").textContent = `${settings.latencyCompMs.toFixed(0)} ms`;
  }
  if (!state.scheduler) state.scheduler = createScheduler(state.ctx);
  if (!state.takeRing || state.takeRing.sampleRate !== state.ctx.sampleRate) {
    state.takeRing = createTakeRing(state.ctx.sampleRate);
  }
  state.ctx.onstatechange = () => {
    if (state.ctx.state === "suspended" && (state.phase === "running" || state.phase === "countIn")) {
      pauseSession({ audioSuspend: true });
    }
  };
}

async function refreshDevices() {
  state.devices = await listInputDevices();
  logM0("inputs: " + (state.devices.map((d) => d.label || d.deviceId).join(" | ") || "(none yet)"));
  const sel = $("set-device");
  sel.innerHTML = state.devices.map((d) =>
    `<option value="${d.deviceId}" ${d.deviceId === settings.deviceId ? "selected" : ""}>${d.label || d.deviceId}</option>`
  ).join("") || `<option value="">(grant mic to list devices)</option>`;
}

async function startSession() {
  try {
    $("start").disabled = true;
    await ensureAudio();
  } catch (err) {
    $("warn").hidden = false;
    $("warn").textContent = "Mic/interface permission failed: " + err.message;
    logM0("getUserMedia error " + err.message);
    $("start").disabled = false;
    return;
  }
  $("start").disabled = false;

  if (state.mode === "sequence" && state.sequence) {
    state.sequence = hydrateSequence(state.sequence, loadCustomPatterns());
    state.segmentIndex = 0;
    const first = state.sequence.segments[0];
    state.pattern = first.pattern;
    state.groove = first.groove;
    state.cycle = inferCycle(first.pattern);
  }
  const parsed = parsePattern(state.pattern);
  if (!parsed.ok) {
    $("warn").hidden = false;
    $("warn").textContent = parsed.error;
    return;
  }
  const grid = deriveSlots(state.pattern, state.bpm);
  state.grid = grid;
  state.config = {
    patternId: state.patternId,
    pattern: state.pattern,
    bpm: state.bpm,
    groove: state.groove,
    countInBars: settings.countInBars,
    dropoutBars: settings.dropoutBars,
    dropoutEvery: settings.dropoutEvery,
    ramp: {
      enabled: state.sequence ? false : settings.rampEnabled,
      bpmStep: settings.bpmStep,
      everyBars: settings.everyBars,
      requireClean: settings.requireClean,
    },
    inputMode: settings.inputMode,
    latencyCompMs: settings.latencyCompMs,
    durationBars: null,
    compression: { ratio: settings.compressionRatio || 1 },
    sequenceId: state.sequence?.id || null,
    sequence: state.sequence ? structuredClone(state.sequence) : null,
  };
  state.scorer.reset();
  state.scorer.setRatio(settings.compressionRatio || 1);
  state.clock.reset();
  state.strip.reset();
  state.highway.reset();
  state.clock.setGrid(grid);
  state.strip.setGrid(grid);
  state.highway.setGrid(grid);
  state.ema = {};
  state.peakRoll = 1e-4;
  state.lastScores = null;
  state.barsDone = 0;
  state.sessionLoopOffset = 0;
  state.barsAtSegmentStart = 0;
  state.segmentCountIn = settings.countInBars;
  state.nextLoop = 0;
  state.pendingSwitch = null;
  state.gateNote = "";
  state.streakPulse = 0;
  state.takeRing?.reset();
  state.startedAt = new Date().toISOString();
  hideReview();

  const step = grid.gridStep;
  state.worklet.port.postMessage({ type: "config", minGapS: 0.5 * step, relThr: relThr() });
  state.scheduler.setTicks(settings.ticksOn);

  setPhase("armed");
  await requestWake();
  const t0 = state.ctx.currentTime + 0.12;
  state.sessionStart = t0;
  state.segmentStart = t0;
  state.scheduler.start(grid, state.config, t0, state.bpm, { segmentIndex: state.segmentIndex || 0 });
  setPhase(settings.countInBars > 0 ? "countIn" : "running");
  $("start").textContent = "Stop";
  $("start").classList.add("stop");
  $("pause").hidden = false;
  $("pause").textContent = "Pause";
  loop();
}

function endSession(save) {
  cancelAnimationFrame(state.raf);
  state.scheduler?.stop();
  stopReplay();
  releaseWake();
  const summary = currentSummary(true);
  setPhase("ended");
  $("start").textContent = "Start";
  $("start").classList.remove("stop");
  $("pause").hidden = true;
  hideReview();
  if (summary && summary.out.all) {
    renderSummary($("summary-body"), summary, { ...state.config, bpm: state.scheduler?.getBpm() || state.bpm });
    drawHistograms($("summary-body").querySelector(".hists"), state.scorer.hits);
    openModal("summary");
    if (save) persistSession(summary);
  }
}

function pauseSession(opts = {}) {
  if (state.phase !== "running" && state.phase !== "countIn") return;
  cancelAnimationFrame(state.raf);
  state.scheduler?.pause();
  const bpm = state.scheduler?.getBpm() || state.bpm;
  const beatDur = 60 / bpm;
  const elapsed = state.ctx ? state.ctx.currentTime - state.sessionStart : 0;
  const localLoop = Math.max(0, Math.floor(elapsed / (beatDur * state.grid.patternLength)));
  const absLoop = state.sessionLoopOffset + localLoop;
  const fromHits = state.scorer.hits.map((h) => h.loop).concat(state.scorer.missed.map((e) => e.loop));
  const maxLoop = Math.max(absLoop, ...fromHits, -1);
  state.nextLoop = maxLoop + 1;
  setPhase("paused");
  $("pause").textContent = "Resume";
  showReview();
  if (opts.audioSuspend) $("resume").hidden = false;
}

async function resumeSession() {
  if (state.phase !== "paused") return;
  if (state.ctx) await resumeContext(state.ctx);
  $("resume").hidden = true;
  hideReview();
  state.pendingSwitch = null;
  state.segmentCountIn = 1;
  state.barsAtSegmentStart = state.barsDone;
  state.sessionLoopOffset = state.nextLoop;
  const t0 = state.ctx.currentTime + 0.12;
  state.sessionStart = t0;
  state.segmentStart = t0;
  state.scheduler.start(
    state.grid,
    { ...state.config, countInBars: 1, bpm: state.scheduler.getBpm() },
    t0,
    state.scheduler.getBpm() || state.bpm,
    { loopBase: state.sessionLoopOffset, segmentIndex: state.segmentIndex || 0 },
  );
  setPhase("countIn");
  $("pause").textContent = "Pause";
  loop();
}

function showReview() {
  if (!state.grid) return;
  $("live-layout").hidden = true;
  $("review-wrap").hidden = false;
  state.review.setModel(reviewModel());
}

function hideReview() {
  stopReplay();
  $("review-wrap").hidden = true;
  $("live-layout").hidden = false;
}

async function persistSession(summary) {
  const rec = {
    id: crypto.randomUUID(),
    startedAt: state.startedAt,
    config: { ...state.config, bpm: state.scheduler?.getBpm() || state.bpm },
    bars: state.barsDone,
    summary,
    hits: state.scorer.hits.slice(-400),
  };
  await saveSession(rec);
}

function currentSummary(sessionWide) {
  if (!state.grid) return null;
  const bpm = state.scheduler?.getBpm() || state.bpm;
  const beatDur = 60 / bpm;
  const now = state.ctx ? state.ctx.currentTime : 0;
  const subset = sessionWide
    ? state.scorer.hits.filter((h) => h.scored)
    : state.scorer.windowHits(settings.windowBars, state.grid.patternLength, now, beatDur);
  const slotsInWindow = settings.windowBars * state.grid.slots.length;
  const sum = state.scorer.summarize(
    subset,
    state.grid.fingers,
    60 / bpm / state.grid.slotsPerBeat,
    state.cycle,
    sessionWide ? Math.max(1, state.barsDone * state.grid.slots.length) : slotsInWindow,
    settings.accentRatio,
  );
  const streak = state.scorer.getStreak();
  sum.bestStreak = streak.bestStreak;
  sum.streak = streak.streak;
  if (sessionWide) {
    const allHits = state.scorer.hits;
    const missed = state.scorer.missed;
    sum.perSlot = aggregatePerSlot(allHits, missed, state.grid.slots);
    if (state.sequence) {
      const slotsByPat = {};
      for (const seg of state.sequence.segments) {
        if (!slotsByPat[seg.pattern]) slotsByPat[seg.pattern] = deriveSlots(seg.pattern, bpm).slots;
      }
      sum.perSlotByPattern = perSlotByPattern(allHits, missed, slotsByPat);
      const extra = summarizeSegments(allHits, missed, state.sequence, (seg) => deriveSlots(seg.pattern, bpm).gridStep);
      sum.perSegment = extra.perSegment;
      sum.transition = extra.transition;
    }
  }
  return sum;
}

function onWorklet(ev) {
  const msg = ev.data;
  if (!msg) return;
  if (msg.raw && msg.startFrame != null && state.takeRing) {
    state.takeRing.write(msg.startFrame, msg.raw);
  }
  if (msg.meter) {
    updateMeter(msg.meter.rms, msg.meter.peak);
    if (msg.meter.peak > state.lastMeterPeak * 3 && state.lastMeterPeak > 0.02) {
      // sudden jump can be AGC; just note once in log
    }
    state.lastMeterPeak = msg.meter.peak;
  }
  if (!msg.onsets?.length || !state.ctx) return;
  const grid = state.scheduler?.getGrid() || state.grid;
  if (!grid) return;
  const bpm = state.scheduler?.getBpm() || state.bpm;
  const step = 60 / bpm / grid.slotsPerBeat;
  for (const o of msg.onsets) {
    const feat = o.raw40 ? attackFeatures(o.raw40, state.ctx.sampleRate) : o;
    const onset = {
      frame: o.frame,
      peak: feat.peak ?? o.peak,
      rms: feat.rms ?? o.rms,
      centroid: feat.centroid ?? 0,
      hfRatio: feat.hfRatio ?? 0,
    };
    if (state.phase === "armed" || state.phase === "paused") continue;
    const rec = state.scorer.matchOnset(
      onset,
      state.scheduler.expectedEvents,
      step,
      settings.latencyCompMs,
      state.ctx.sampleRate,
      state.ctx.currentTime,
    );
    if (rec.type === "hit" || rec.type === "ghost" || rec.type === "double") {
      state.peakRoll = Math.max(state.peakRoll * 0.995, rec.peak);
      state.clock.addHit(rec, step, rec.peak / state.peakRoll);
      state.strip.add(rec);
      if (rec.type === "hit" && rec.finger && rec.scored) updateEma(rec);
      if (rec.type === "hit" && rec.scored && rec.grade === "perfect") {
        state.streakPulse = performance.now();
      }
    }
  }
  refreshLiveStats();
}

function updateEma(rec) {
  const prev = state.ema[rec.finger] || { timing: 0, attackDb: 0, bright: 0 };
  const a = 0.2;
  const loudest = Math.max(...Object.values(state.ema).map((e) => e._peak || 0), rec.peak, 1e-6);
  const attackDb = 20 * Math.log10((rec.peak + 1e-12) / loudest);
  const meanC = average(Object.values(state.ema).map((e) => e._c).filter(Boolean)) || rec.centroid;
  state.ema[rec.finger] = {
    timing: prev.timing * (1 - a) + rec.devMs * a,
    attackDb: prev.attackDb * (1 - a) + attackDb * a,
    bright: prev.bright * (1 - a) + ((rec.centroid - meanC) / (meanC || 1)) * a,
    _peak: rec.peak,
    _c: rec.centroid,
  };
}

function refreshLiveStats() {
  if (!state.grid) return;
  const sum = currentSummary(false);
  state.lastScores = sum;
  const mic = settings.inputMode === "mic";
  renderFingerBars($("fingers"), state.ema, state.grid.fingers, mic);
  renderScores($("scores"), sum.scores, sum.diagnosis, mic, {
    scoresHeard: sum.scoresHeard,
    ratio: state.scorer.getRatio(),
    tallies: sum.tallies,
  });
}

function loop() {
  if (state.phase === "paused" || state.phase === "ended" || state.phase === "idle") return;
  state.raf = requestAnimationFrame(loop);
  if (!state.ctx || !state.grid) return;
  const now = state.ctx.currentTime;
  const bpm = state.scheduler?.getBpm() || state.bpm;
  const beatDur = 60 / bpm;
  const step = beatDur / state.grid.slotsPerBeat;
  const elapsed = now - state.sessionStart;
  const pos = ((elapsed % beatDur) + beatDur) % beatDur / beatDur;
  const localLoop = Math.max(0, Math.floor(elapsed / (beatDur * state.grid.patternLength)));
  const absLoop = state.sessionLoopOffset + localLoop;
  const drop = settings.dropoutBars > 0 && absLoop % settings.dropoutEvery >= settings.dropoutEvery - settings.dropoutBars;
  state.clock.setDim(drop);
  state.clock.draw(pos, beatDur);
  state.strip.draw(step);
  const upcoming = upcomingSegmentInfo(now, bpm, beatDur);
  const streak = state.scorer.getStreak();
  state.highway.draw({
    now,
    sessionStart: state.sessionStart,
    step,
    hits: state.scorer.hits,
    missed: state.scorer.missed,
    loopOffset: state.sessionLoopOffset,
    countIn: state.segmentCountIn,
    dropoutBars: settings.dropoutBars,
    dropoutEvery: settings.dropoutEvery,
    next: upcoming.next,
    upcomingLabel: upcoming.label,
    pulseSwitch: upcoming.pulse,
    streak: streak.streak,
    lastBreak: streak.lastBreak,
    pulseAt: state.streakPulse,
  });
  maybeSwitchSegment(now, bpm, beatDur);

  state.scorer.sweep(state.scheduler.expectedEvents, step, now, (e) => {
    state.clock.addMiss(e.slot);
  });

  if (state.phase === "countIn" && localLoop >= state.segmentCountIn) setPhase("running");

  state.barsDone = state.barsAtSegmentStart + Math.max(0, localLoop - state.segmentCountIn);
  $("bars").textContent = `${state.barsDone} bars`;
  $("phase").textContent = state.phase;
  $("bpm-val").textContent = String(Math.round(bpm));
  if (state.sequence) {
    const seg = state.sequence.segments[state.segmentIndex];
    const barIn = Math.max(0, localLoop - state.segmentCountIn) + 1;
    $("seq-stat").textContent = `segment ${state.segmentIndex + 1}/${state.sequence.segments.length} · bar ${Math.min(barIn, seg.bars)}/${seg.bars}${state.gateNote ? " · " + state.gateNote : ""}`;
  } else {
    $("seq-stat").textContent = "";
  }

  maybeRamp(absLoop, now, beatDur);
}

function upcomingSegmentInfo(now, bpm, beatDur) {
  if (!state.sequence) return { next: null, label: "", pulse: false };
  const seg = state.sequence.segments[state.segmentIndex];
  const boundary = segmentBoundary(state.segmentStart, seg, bpm);
  const barsLeft = Math.max(0, (boundary - now) / (seg.bars ? (boundary - state.segmentStart) / seg.bars : beatDur));
  let nextIdx = state.pendingSwitch?.next;
  if (nextIdx == null) {
    const clean = state.lastScores?.scores?.clean ?? 100;
    nextIdx = pickNextSegmentIndex(state.sequence, state.segmentIndex, clean);
  }
  if (nextIdx < 0) nextIdx = state.segmentIndex;
  const nextSeg = state.sequence.segments[nextIdx];
  const nextGrid = deriveSlots(nextSeg.pattern, bpm);
  const elapsed = boundary - state.sessionStart;
  const localLoop = Math.max(0, Math.floor(elapsed / (beatDur * state.grid.patternLength)));
  const label = nextIdx === state.segmentIndex && state.gateNote
    ? state.gateNote
    : `→ ${nextSeg.name} in ${Math.max(0, Math.ceil(barsLeft))} bars`;
  const pulse = now >= boundary - (state.grid.patternLength * beatDur);
  return {
    next: {
      grid: nextGrid,
      step: nextGrid.gridStep,
      boundaryTime: boundary,
      loopOffset: state.sessionLoopOffset + localLoop,
    },
    label,
    pulse,
  };
}

function maybeSwitchSegment(now, bpm, beatDur) {
  if (!state.sequence || state.phase !== "running") return;
  const seg = state.sequence.segments[state.segmentIndex];
  const boundary = segmentBoundary(state.segmentStart, seg, bpm);
  if (!state.pendingSwitch && now >= boundary - 0.5) {
    const clean = currentSummary(false)?.scores?.clean ?? 0;
    let next = pickNextSegmentIndex(state.sequence, state.segmentIndex, clean);
    if (next < 0) {
      state.pendingSwitch = { boundary, next: state.segmentIndex, hold: true };
      return;
    }
    if (next === state.segmentIndex && state.sequence.gate?.enabled && clean < state.sequence.gate.cleanMin) {
      state.gateNote = `gate: repeat — clean ${clean.toFixed(0)} < ${state.sequence.gate.cleanMin}`;
    } else {
      state.gateNote = "";
    }
    const nextSeg = state.sequence.segments[next];
    const nextGrid = deriveSlots(nextSeg.pattern, bpm);
    const elapsed = boundary - state.sessionStart;
    const localLoop = Math.max(0, Math.floor(elapsed / (beatDur * state.grid.patternLength)));
    const loopBase = state.sessionLoopOffset + localLoop;
    state.scheduler.setGridAt(nextGrid, boundary, {
      loopBase,
      segmentIndex: next,
      groove: nextSeg.groove,
    });
    state.worklet?.port.postMessage({ type: "config", minGapS: 0.5 * nextGrid.gridStep, relThr: relThr() });
    state.pendingSwitch = { boundary, next, nextGrid, nextSeg, loopBase };
  }
  if (state.pendingSwitch && !state.pendingSwitch.applied && now >= state.pendingSwitch.boundary) {
    applyPendingSwitch();
  }
}

function applyPendingSwitch() {
  const p = state.pendingSwitch;
  if (!p || p.hold) {
    state.pendingSwitch = p ? { ...p, applied: true } : null;
    return;
  }
  const bpm = state.scheduler.getBpm() || state.bpm;
  state.barsAtSegmentStart = state.barsDone;
  state.segmentCountIn = 0;
  state.sessionLoopOffset = p.loopBase;
  state.sessionStart = p.boundary;
  state.segmentStart = p.boundary;
  state.segmentIndex = p.next;
  state.grid = p.nextGrid;
  state.pattern = p.nextSeg.pattern;
  state.groove = p.nextSeg.groove;
  state.cycle = inferCycle(p.nextSeg.pattern);
  state.clock.setGrid(state.grid);
  state.strip.setGrid(state.grid);
  state.highway.setGrid(state.grid);
  $("groove").value = state.groove;
  state.pendingSwitch = { ...p, applied: true };
  void bpm;
}

function reviewModel() {
  const bpm = state.scheduler?.getBpm() || state.bpm;
  const base = {
    hits: state.scorer.hits,
    missed: state.scorer.missed,
    dropoutBars: settings.dropoutBars,
    dropoutEvery: settings.dropoutEvery,
    ratio: state.scorer.getRatio(),
    countInLoops: 0,
    canReplay: canReplaySelection,
  };
  if (state.sequence) {
    return {
      ...base,
      blocks: state.sequence.segments.map((seg, i) => {
        const grid = deriveSlots(seg.pattern, bpm);
        return { segmentIndex: i, label: seg.name, grid, gridStep: grid.gridStep };
      }),
    };
  }
  return {
    ...base,
    grid: state.grid,
    gridStep: 60 / bpm / state.grid.slotsPerBeat,
  };
}

function loopTimeRange(sel) {
  const block = sel.block;
  const step = block.gridStep;
  let best = null;
  const consider = (t, slotIndex) => {
    const start = t - slotIndex * step;
    if (best == null || start < best) best = start;
  };
  for (const h of state.scorer.hits) {
    if (h.loop !== sel.loop || (h.segmentIndex ?? 0) !== sel.segmentIndex) continue;
    if (h.event) consider(h.event.time, h.slotIndex);
    else consider(h.t - (h.devMs || 0) / 1000, h.slotIndex);
  }
  for (const e of state.scorer.missed) {
    if (e.loop !== sel.loop || (e.segmentIndex ?? 0) !== sel.segmentIndex) continue;
    consider(e.time, e.slot.index);
  }
  if (best == null) return null;
  return { tStart: best, tEnd: best + block.grid.slots.length * step, sel };
}

function canReplaySelection(sel) {
  if (!sel || !state.takeRing || !state.ctx) return false;
  const range = loopTimeRange(sel);
  if (!range) return false;
  const lat = settings.latencyCompMs / 1000;
  const { f0 } = framesForRange(range.tStart, range.tEnd, state.ctx.sampleRate, lat);
  return f0 >= state.takeRing.oldestFrame();
}

function replayLastBars(n) {
  const bpm = state.scheduler?.getBpm() || state.bpm;
  const beatDur = 60 / bpm;
  const barDur = state.grid.patternLength * beatDur;
  const times = state.scorer.hits.map((h) => h.t).concat(state.scorer.missed.map((e) => e.time));
  if (!times.length) return;
  const tEnd = Math.max(...times) + state.grid.gridStep;
  playTake(Math.max(0, tEnd - n * barDur), tEnd, null);
}

function replayLoop(sel) {
  const range = loopTimeRange(sel);
  if (!range) return;
  playTake(range.tStart, range.tEnd, sel);
}

function playTake(tStart, tEnd, sel) {
  if ((state.phase !== "paused" && state.phase !== "ended") || !state.ctx || !state.takeRing) return;
  const sr = state.ctx.sampleRate;
  const lat = settings.latencyCompMs / 1000;
  const { f0, f1 } = framesForRange(tStart, tEnd, sr, lat);
  const slice = state.takeRing.sliceFrames(f0, f1);
  if (!slice) {
    $("replay-status").textContent = "take not in 30s buffer";
    return;
  }
  stopReplay();
  const buf = state.ctx.createBuffer(1, slice.samples.length, sr);
  buf.getChannelData(0).set(slice.samples);
  const when = state.ctx.currentTime + 0.05;
  playBuf(state.ctx, buf, when, 1);
  const kit = state.scheduler?.getKit();
  const events = state.scheduler?.expectedEvents || [];
  for (const e of events) {
    if (e.time >= tStart && e.time < tEnd && kit?.click) {
      playBuf(state.ctx, e.slot.sub === 0 ? kit.click1 || kit.click : kit.click, when + (e.time - tStart), e.slot.sub === 0 ? 0.8 : 0.35);
    }
  }
  state.replayRange = { when, tStart, tEnd, duration: tEnd - tStart, sel };
  $("replay-status").textContent = "playing";
  const tick = () => {
    if (!state.replayRange) return;
    const p = (state.ctx.currentTime - state.replayRange.when) / state.replayRange.duration;
    if (sel) state.review.setReplay({ loop: sel.loop, segmentIndex: sel.segmentIndex, progress: p });
    if (p >= 1) {
      stopReplay();
      return;
    }
    state.replayTimer = requestAnimationFrame(tick);
  };
  state.replayTimer = requestAnimationFrame(tick);
}

function stopReplay() {
  if (state.replayTimer) cancelAnimationFrame(state.replayTimer);
  state.replayTimer = 0;
  state.replayRange = null;
  $("replay-status").textContent = "";
  state.review?.setReplay(null);
}

function maybeRamp(loopIdx, now, beatDur) {
  if (state.sequence || !settings.rampEnabled || state.phase !== "running") return;
  const every = settings.everyBars;
  if (loopIdx <= 0 || loopIdx % every !== 0) return;
  if (state._lastRampLoop === loopIdx) return;
  state._lastRampLoop = loopIdx;
  const sum = currentSummary(false);
  const ok = !settings.requireClean || (
    sum.scores.timing >= 70 && sum.scores.attackEven >= 60 && sum.scores.clean >= 80
  );
  if (!ok) {
    $("ramp-stat").textContent = "ramp held";
    return;
  }
  const next = Math.min(300, (state.scheduler.getBpm()) + settings.bpmStep);
  const boundary = state.sessionStart + loopIdx * state.grid.patternLength * beatDur;
  state.scheduler.setBpmAt(next, Math.max(boundary, now));
  state.bpm = next;
  state.grid = deriveSlots(state.pattern, next);
  state.clock.setGrid(state.grid);
  state.strip.setGrid(state.grid);
  state.highway.setGrid(state.grid);
  state.worklet.port.postMessage({ type: "config", minGapS: 0.5 * state.grid.gridStep, relThr: relThr() });
  $("ramp-stat").textContent = `ramp → ${next}`;
}

function updateMeter(rms, peak) {
  const db = dbfs(peak || rms);
  const pct = Math.max(0, Math.min(100, (db + 48) / 48 * 100));
  $("meter-fill").style.width = pct + "%";
  $("meter-db").textContent = isFinite(db) ? db.toFixed(1) + " dB" : "–";
  $("meter").classList.toggle("low", db < -30);
  $("meter").classList.toggle("clip", db > -0.5);
  if (db > -0.5) $("meter-db").textContent = "CLIP";
}

function setPhase(p) {
  state.phase = p;
  $("phase").textContent = p;
}

function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
}

async function openHistory() {
  const rows = await listSessions();
  renderHistory($("hist-list"), rows, (id) => {
    const s = rows.find((r) => r.id === id);
    if (!s) return;
    const pattern = s.config?.pattern || state.pattern;
    renderHistoryChart($("hist-chart"), rows, s.config?.patternId);
    showHeatmapFor(pattern, rows, s);
  });
  const pats = [...new Set(rows.map((s) => s.config?.pattern).filter(Boolean))];
  $("heatmap-pats").innerHTML = pats.map((p) => {
    const meta = findPattern(p, loadCustomPatterns());
    return `<button type="button" data-pat="${p}">${meta?.name || p}</button>`;
  }).join("");
  $("heatmap-pats").querySelectorAll("button").forEach((b) => {
    b.onclick = () => showHeatmapFor(b.dataset.pat, rows);
  });
  if (pats[0]) showHeatmapFor(pats[0], rows);
  openModal("history");
}

function showHeatmapFor(pattern, rows) {
  const meta = findPattern(pattern, loadCustomPatterns());
  const grid = deriveSlots(pattern, 80);
  const model = heatmapModel(pattern, grid.slots, rows, (text) => {
    $("heatmap-readout").textContent = text;
  });
  $("heatmap-callout").textContent = model.callout || (meta ? meta.name : pattern);
  state.heatmap.setModel(model);
}

function exportCsv() {
  const csv = hitsToCsv(state.scorer.hits);
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pluck-hits.csv";
  a.click();
}

function applyManualCal() {
  settings.latencyCompMs = +$("set-lat").value;
  const id = trackSettings(state.stream).deviceId || "default";
  saveCalibration(id, settings.latencyCompMs);
  $("lat-badge").textContent = `${settings.latencyCompMs.toFixed(0)} ms`;
}

function startAutoCal() {
  const recent = state.scorer.hits.filter((h) => h.type === "hit").slice(-8);
  if (recent.length < 4) {
    $("cal-readout").textContent = "Play 8 clean plucks with the click first.";
    return;
  }
  const med = median(recent.map((h) => h.devMs));
  settings.latencyCompMs = Math.max(-100, Math.min(300, settings.latencyCompMs + med));
  $("set-lat").value = settings.latencyCompMs.toFixed(1);
  $("cal-readout").textContent = `median dev ${med.toFixed(1)} ms → latency ${settings.latencyCompMs.toFixed(1)} ms`;
  applyManualCal();
}

async function requestWake() {
  try {
    if (navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request("screen");
  } catch { /* unsupported or battery */ }
}

function releaseWake() {
  state.wakeLock?.release();
  state.wakeLock = null;
}

async function onVisibility() {
  if (document.visibilityState === "visible" && (state.phase === "running" || state.phase === "countIn")) {
    await requestWake();
    if (state.ctx?.state === "suspended") {
      $("resume").hidden = false;
    }
  }
}

function drawHistograms(el, hits) {
  if (!el) return;
  const fingers = [...new Set(hits.filter((h) => h.finger).map((h) => h.finger))];
  el.innerHTML = fingers.map((fg) => `<canvas data-fg="${fg}" height="48"></canvas>`).join("");
  el.querySelectorAll("canvas").forEach((c) => {
    const fg = c.dataset.fg;
    const vals = hits.filter((h) => h.finger === fg && h.type === "hit").map((h) => h.devMs);
    const ctx = c.getContext("2d");
    const w = c.width = c.clientWidth || 160;
    const h = c.height;
    ctx.fillStyle = "#14171d";
    ctx.fillRect(0, 0, w, h);
    if (!vals.length) return;
    const bins = new Array(17).fill(0);
    for (const v of vals) {
      const i = Math.max(0, Math.min(16, Math.floor((v + 40) / 5)));
      bins[i]++;
    }
    const m = Math.max(...bins, 1);
    ctx.fillStyle = FINGER_COLORS[fg];
    bins.forEach((b, i) => {
      const bh = (b / m) * (h - 4);
      ctx.fillRect((i / 17) * w + 1, h - bh, w / 17 - 2, bh);
    });
  });
}

function logM0(msg) {
  console.log("[pluck]", msg);
  const box = $("log");
  if (box) {
    const line = document.createElement("div");
    line.textContent = msg;
    box.prepend(line);
  }
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function average(a) {
  if (!a.length) return 0;
  return a.reduce((s, v) => s + v, 0) / a.length;
}

$("lat-live") && setInterval(() => {
  const recent = state.scorer.hits.filter((h) => h.type === "hit").slice(-8);
  if (recent.length) $("lat-live").textContent = `median ${median(recent.map((h) => h.devMs)).toFixed(1)} ms`;
}, 500);
