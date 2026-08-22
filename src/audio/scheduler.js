import { buildKit, playBuf, grooveSounds } from "./synth.js";

const LOOKAHEAD = 0.12;
const WAKE_MS = 25;
/** Hold miss-sweep until worklet has posted the 40 ms feature window. */
export const FEATURE_HOLD = 0.05;

export function createScheduler(ctx) {
  const kit = buildKit(ctx);
  let timer = null;
  let nextSlotCursor = 0; // absolute slot index from session start
  let grid = null;
  let config = null;
  let sessionStart = 0;
  let currentBpm = 80;
  let rampBoundary = 0;
  let ticksOn = true;
  const expectedEvents = [];
  let audible = true;
  let loopBase = 0;
  let segmentIndex = 0;

  function beatDur() {
    return 60 / currentBpm;
  }

  function gridStep() {
    return beatDur() / grid.slotsPerBeat;
  }

  function eventTime(absSlot) {
    return sessionStart + absSlot * gridStep();
  }

  function isDropout(loop) {
    if (!config || !config.dropoutBars) return false;
    const every = config.dropoutEvery || 8;
    return loop % every >= every - config.dropoutBars;
  }

  function scheduleAhead() {
    if (!grid) return;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const slotsPerLoop = grid.slots.length;
    let guard = 0;
    while (guard++ < 64) {
      const t = eventTime(nextSlotCursor);
      if (t > horizon) break;
      const localLoop = Math.floor(nextSlotCursor / slotsPerLoop);
      const loop = localLoop + loopBase;
      const slot = grid.slots[nextSlotCursor % slotsPerLoop];
      const beatAbs = loop * grid.patternLength + slot.beat;
      const inCountIn = localLoop < (config.countInBars || 0);
      const drop = isDropout(loop);
      const evAudible = audible && !drop;
      const ev = {
        time: t,
        slot,
        loop,
        beatAbs,
        audible: evAudible,
        hit: false,
        ghosts: 0,
        doubles: 0,
        scored: !inCountIn,
        absSlot: nextSlotCursor,
        segmentIndex,
        pattern: grid.pattern,
      };
      expectedEvents.push(ev);
      if (evAudible) {
        const names = grooveSounds(config.groove, slot, grid.slotsPerBeat, beatAbs, ticksOn);
        const seen = new Set();
        for (const name of names) {
          if (seen.has(name)) continue;
          seen.add(name);
          const buf = kit[name];
          if (!buf) continue;
          let g = 1;
          if (name === "hatClosed" && config.groove === "straight16" && slot.sub % 2 === 1) g = 0.55;
          playBuf(ctx, buf, t, g);
        }
      }
      nextSlotCursor++;
    }
    if (expectedEvents.length > 800) expectedEvents.splice(0, expectedEvents.length - 600);
  }

  return {
    expectedEvents,
    start(nextGrid, nextConfig, startTime, bpm, opts = {}) {
      grid = nextGrid;
      config = nextConfig;
      sessionStart = startTime;
      rampBoundary = startTime;
      currentBpm = bpm;
      nextSlotCursor = 0;
      loopBase = opts.loopBase || 0;
      segmentIndex = opts.segmentIndex || 0;
      expectedEvents.length = 0;
      audible = true;
      this.stopWake();
      scheduleAhead();
      timer = setInterval(scheduleAhead, WAKE_MS);
      const clicks = [];
      for (let i = 0; i < 40; i++) clicks.push(eventTime(i * grid.slotsPerBeat));
      const dts = [];
      for (let i = 1; i < clicks.length; i++) dts.push(Number((clicks[i] - clicks[i - 1]).toFixed(10)));
      console.log("[pluck] M1 beat spacing (should equal 60/bpm)", dts[0], "bpm", currentBpm, "unique", [...new Set(dts)]);
    },
    pause() {
      this.stopWake();
      const now = ctx.currentTime;
      while (expectedEvents.length) {
        const last = expectedEvents[expectedEvents.length - 1];
        if (last.time > now) {
          expectedEvents.pop();
          nextSlotCursor = last.absSlot;
        } else {
          break;
        }
      }
    },
    stopWake() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    stop() {
      this.stopWake();
      grid = null;
    },
    setTicks(on) {
      ticksOn = on;
    },
    setAudible(on) {
      audible = on;
    },
    setBpmAt(bpm, boundaryTime) {
      if (!grid) return;
      currentBpm = bpm;
      const step = (60 / bpm) / grid.slotsPerBeat;
      while (expectedEvents.length) {
        const last = expectedEvents[expectedEvents.length - 1];
        if (last.time >= boundaryTime) {
          expectedEvents.pop();
          nextSlotCursor = last.absSlot;
        } else {
          break;
        }
      }
      sessionStart = boundaryTime - nextSlotCursor * step;
      rampBoundary = boundaryTime;
    },
    getBpm() {
      return currentBpm;
    },
    setGridAt(nextGrid, boundaryTime, opts = {}) {
      if (!grid) {
        grid = nextGrid;
        sessionStart = boundaryTime;
        nextSlotCursor = 0;
        if (opts.loopBase != null) loopBase = opts.loopBase;
        if (opts.segmentIndex != null) segmentIndex = opts.segmentIndex;
        if (opts.groove && config) config.groove = opts.groove;
        if (config) config.countInBars = 0;
        return;
      }
      while (expectedEvents.length) {
        const last = expectedEvents[expectedEvents.length - 1];
        if (last.time >= boundaryTime) {
          expectedEvents.pop();
          nextSlotCursor = last.absSlot;
        } else {
          break;
        }
      }
      grid = nextGrid;
      nextSlotCursor = 0;
      sessionStart = boundaryTime;
      if (opts.loopBase != null) loopBase = opts.loopBase;
      if (opts.segmentIndex != null) segmentIndex = opts.segmentIndex;
      if (opts.groove && config) config.groove = opts.groove;
      if (config) config.countInBars = 0;
    },
    getKit() {
      return kit;
    },
    getGrid() {
      return grid;
    },
    getSegmentIndex() {
      return segmentIndex;
    },
    sessionStart() {
      return sessionStart;
    },
    scheduleAhead,
  };
}
