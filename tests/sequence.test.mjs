import { deriveSlots, hydrateSequence, SEQUENCE_PRESETS, validateSequence } from "../src/pattern.js";
import { applyGridSwitch, nextShuffledIndex, pickNextSegmentIndex, switchTimes } from "../src/sequence.js";

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) fail.push(`${msg}: ${a} ≉ ${b}`);
}

for (const s of SEQUENCE_PRESETS) {
  assert(validateSequence(s).ok, `${s.id} should validate: ${validateSequence(s).error}`);
  const h = hydrateSequence(s);
  assert(h.segments.every((seg) => seg.pattern && seg.bars >= 1), `${s.id} hydrates`);
}

{
  const bpm = 80;
  const beatDur = 60 / bpm;
  const trip = deriveSlots("rmi rmi rmi rmi", bpm);
  const six = deriveSlots("rmir mirm irmi rmir mirm irmi", bpm);
  const bars = 4;
  const segmentStart = 0;
  const boundary = segmentStart + bars * trip.patternLength * beatDur;
  close(boundary, 12, 1e-12, "4 bars of 4-beat triplets at 80 BPM");

  const events = [];
  let cursor = 0;
  const tripStep = trip.gridStep;
  while (segmentStart + cursor * tripStep < boundary + 1) {
    events.push({ time: segmentStart + cursor * tripStep, absSlot: cursor });
    cursor++;
  }
  const switched = applyGridSwitch(events, cursor, boundary);
  assert(switched.sessionStart === boundary, "re-anchor sessionStart to boundary");
  assert(switched.nextSlotCursor === 0, "new grid starts at slot 0");
  const times = switched.events.map((e) => e.time).concat(switchTimes(boundary, six.gridStep, 16));
  for (let i = 1; i < times.length; i++) {
    assert(times[i] >= times[i - 1], `monotonic at ${i}: ${times[i - 1]} → ${times[i]}`);
  }
  close(times.find((t) => t >= boundary), boundary, 0, "first new downbeat exactly at boundary");
  for (let n = 0; n < 10; n++) {
    const b = n * boundary;
    const first = switchTimes(b, six.gridStep, 1)[0];
    close(first, b, 0, `switch ${n} first event`);
  }
}

{
  const seq = hydrateSequence(SEQUENCE_PRESETS[0]);
  seq.gate = { enabled: true, cleanMin: 80 };
  assert(pickNextSegmentIndex(seq, 1, 64) === 1, "gate repeats sloppy segment");
  assert(pickNextSegmentIndex(seq, 1, 81) === 2, "clean segment advances");
}

{
  const seen = new Set();
  let prev = 0;
  for (let i = 0; i < 100; i++) {
    const n = nextShuffledIndex(5, prev, () => (i * 0.17) % 1);
    assert(n !== prev, `immediate repeat at draw ${i}: ${n}`);
    seen.add(n);
    prev = n;
  }
  assert(seen.size === 5, `shuffle should draw all 5, got ${[...seen]}`);
}

{
  const noLoop = { segments: [{}, {}, {}], loop: false, shuffle: false, gate: { enabled: false } };
  assert(pickNextSegmentIndex(noLoop, 2, 100) === -1, "loop=false ends after last");
}

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("sequence tests: PASS");
