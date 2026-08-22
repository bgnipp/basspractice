import { deriveSlots } from "../src/pattern.js";
import { aggregatePerSlot, mergePerSlot, problemSlot } from "../src/scoring.js";
import { heatmapModel } from "../src/ui/heatmap.js";

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}

const grid = deriveSlots("rmi rmi rmi rmi", 80);
const fingers = ["r", "m", "i"];

function plantedHits(badSlot) {
  const hits = [];
  const missed = [];
  for (let loop = 0; loop < 8; loop++) {
    for (let i = 0; i < 12; i++) {
      const slot = grid.slots[i];
      if (!slot.finger) continue;
      if (i === badSlot) {
        missed.push({ slot: { index: i }, time: loop + i * 0.1, pattern: grid.pattern });
        hits.push({
          type: "hit", scored: true, slotIndex: i, finger: slot.finger,
          devMs: 22, peak: 0.2, loop, pattern: grid.pattern,
        });
      } else {
        hits.push({
          type: "hit", scored: true, slotIndex: i, finger: slot.finger,
          devMs: 1, peak: 0.5, loop, pattern: grid.pattern,
        });
      }
    }
  }
  return { hits, missed };
}

const { hits, missed } = plantedHits(4);
const perSlot = aggregatePerSlot(hits, missed, grid.slots);
assert(perSlot[4].missRate > 0.4, `slot 4 missRate ${perSlot[4].missRate}`);
assert(Math.abs(perSlot[4].meanDev) > 10, `slot 4 meanDev ${perSlot[4].meanDev}`);
assert(perSlot[1].missRate === 0, `slot 1 should be cool, miss ${perSlot[1].missRate}`);
assert(Math.abs(perSlot[1].meanDev) < 2, `slot 1 meanDev ${perSlot[1].meanDev}`);

const sessions = [
  { id: "a", startedAt: "2026-01-01", config: { pattern: grid.pattern }, summary: { perSlot } },
  { id: "b", startedAt: "2026-01-02", config: { pattern: grid.pattern }, summary: { perSlot } },
  { id: "old", startedAt: "2025-01-01", config: { pattern: grid.pattern }, summary: {} },
];
const merged = mergePerSlot(sessions.filter((s) => s.summary.perSlot).map((s) => s.summary.perSlot));
const prob = problemSlot(merged, grid.slots);
assert(prob && prob.index === 4, `callout slot ${prob?.index}, expected 4`);
assert(prob.slot.finger === fingers[4 % 3], `finger ${prob.slot.finger}`);

const model = heatmapModel(grid.pattern, grid.slots, sessions);
assert(model.rows[0].label === "all-time", "all-time row first");
assert(model.rows.find((r) => r.id === "old").perSlot === null, "old session is a blank row");
assert(/problem slot: 4/.test(model.callout), `callout: ${model.callout}`);
assert(/middle/.test(model.callout), `callout should name the finger: ${model.callout}`);

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("heatmap tests: PASS");
