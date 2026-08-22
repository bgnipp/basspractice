import { applyStreakEvent, createStreakState, grade } from "../src/scoring.js";

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}

const step = 0.25; // 250 ms
assert(grade(5, step) === "perfect", "5 ms is perfect at 250 ms step (4%=10ms)");
assert(grade(20, step) === "good", "20 ms is good (12%=30ms)");
assert(grade(40, step) === "off", "40 ms is off");

let s = createStreakState();
const stream = [
  { type: "hit", scored: true, devMs: 4, gridStep: step },   // perfect
  { type: "hit", scored: true, devMs: 15, gridStep: step },  // good
  { type: "hit", scored: false, devMs: 80, gridStep: step }, // count-in: ignore
  { type: "hit", scored: true, devMs: 6, gridStep: step },   // perfect → streak 3
  { type: "extra", scored: true, devMs: 0, gridStep: step }, // no reset
  { type: "ghost", scored: true },                           // reset
  { type: "hit", scored: true, devMs: 3, gridStep: step },   // 1
  { type: "missed", scored: true },                          // reset
  { type: "hit", scored: true, devMs: 2, gridStep: step },   // 1
  { type: "hit", scored: true, devMs: 50, gridStep: step },  // off → reset
  { type: "double", scored: true },                          // stays 0
  { type: "hit", scored: true, devMs: 1, gridStep: step },   // 1
  { type: "hit", scored: true, devMs: 2, gridStep: step },   // 2
];

for (const ev of stream) s = applyStreakEvent(s, ev);

assert(s.tallies.perfect === 6, `perfect ${s.tallies.perfect} !== 6`);
assert(s.tallies.good === 1, `good ${s.tallies.good} !== 1`);
assert(s.tallies.off === 1, `off ${s.tallies.off} !== 1`);
assert(s.tallies.ghosts === 1, `ghosts ${s.tallies.ghosts} !== 1`);
assert(s.tallies.missed === 1, `missed ${s.tallies.missed} !== 1`);
assert(s.tallies.doubles === 1, `doubles ${s.tallies.doubles} !== 1`);
assert(s.streak === 2, `streak ${s.streak} !== 2`);
assert(s.bestStreak === 3, `bestStreak ${s.bestStreak} !== 3`);
assert(s.lastBreak === "", `lastBreak should be clear after rebuild, got ${s.lastBreak}`);

let broken = applyStreakEvent(createStreakState(), { type: "hit", scored: true, devMs: 2, gridStep: step });
broken = applyStreakEvent(broken, { type: "ghost", scored: true });
assert(broken.streak === 0 && broken.lastBreak === "ghost", "ghost names the break");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("streak tests: PASS");
