import { deriveSlots } from "./pattern.js";

/** Uniform pick among 0..n-1, no immediate repeat unless n === 1. */
export function nextShuffledIndex(n, prev, rand = Math.random) {
  if (n <= 1) return 0;
  let i = Math.floor(rand() * (n - 1));
  if (i >= prev) i += 1;
  return i;
}

/**
 * Next segment index. Returns -1 when the sequence is finished (loop=false, past last).
 * Gate repeats the current segment when clean < cleanMin.
 */
export function pickNextSegmentIndex(seq, currentIndex, clean, rand = Math.random) {
  const n = seq.segments.length;
  if (!n) return -1;
  if (seq.gate?.enabled && clean < seq.gate.cleanMin) return currentIndex;
  if (seq.shuffle) return nextShuffledIndex(n, currentIndex, rand);
  const next = currentIndex + 1;
  if (next < n) return next;
  return seq.loop ? 0 : -1;
}

export function segmentBoundary(segmentStart, seg, bpm) {
  const grid = deriveSlots(seg.pattern, bpm);
  return segmentStart + seg.bars * grid.patternLength * (60 / bpm);
}

export function applyGridSwitch(events, nextSlotCursor, boundaryTime) {
  const next = events.slice();
  let cursor = nextSlotCursor;
  while (next.length) {
    const last = next[next.length - 1];
    if (last.time >= boundaryTime) {
      next.pop();
      cursor = last.absSlot;
    } else {
      break;
    }
  }
  return { events: next, nextSlotCursor: 0, sessionStart: boundaryTime, poppedFrom: cursor };
}

/** First downbeat of the new grid is exactly at boundaryTime. */
export function switchTimes(boundaryTime, nextGridStep, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(boundaryTime + i * nextGridStep);
  return out;
}
