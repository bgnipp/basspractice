import { parsePattern, PRESETS } from "../src/pattern.js";

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}

for (const p of PRESETS) {
  const r = parsePattern(p.pattern);
  assert(r.ok, `${p.id} should parse: ${r.error}`);
}

assert(!parsePattern("rm i").ok, "unequal slots rejected");
assert(!parsePattern("abc").ok, "bad chars rejected");
assert(!parsePattern("xxx xxx").ok, "all rests rejected");
assert(parsePattern("rmi rmi").ok, "valid accepted");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("pattern tests: PASS", PRESETS.length, "presets");
