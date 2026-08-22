import {
  detectOnsetsOffline, noteFeaturesOffline, peakNormalize,
} from "../src/audio/dsp.js";

export function mountAnalyze(root) {
  root.innerHTML = `
    <section class="dev">
      <h1>Analyze file</h1>
      <p>Decode at the file sample rate, channel 0, peak-normalize, offline detector (global-max envelope).</p>
      <label>WAV <input id="wav" type="file" accept="audio/wav,audio/*"></label>
      <label>Reference CSV <input id="csv" type="file" accept=".csv,text/csv"></label>
      <label>BPM <input id="bpm" type="number" value="80"></label>
      <label>Subdiv <input id="sub" type="number" value="3"></label>
      <button id="run" class="primary">Compare</button>
      <pre id="sum"></pre>
      <div class="table-wrap"><table id="tbl"></table></div>
    </section>
  `;
  root.querySelector("#run").onclick = () => run(root);
}

async function run(root) {
  const wavF = root.querySelector("#wav").files[0];
  const csvF = root.querySelector("#csv").files[0];
  const bpm = +root.querySelector("#bpm").value;
  const subdiv = +root.querySelector("#sub").value;
  const sum = root.querySelector("#sum");
  const tbl = root.querySelector("#tbl");
  if (!wavF || !csvF) {
    sum.textContent = "Choose a WAV and the rmi_analyzer.py --csv file.";
    return;
  }
  const buf = await wavF.arrayBuffer();
  const decoded = await decodeAtNativeRate(buf);
  let y = decoded.getChannelData(0);
  y = peakNormalize(y);
  const sr = decoded.sampleRate;
  const step = 60 / bpm / subdiv;
  const onsets = detectOnsetsOffline(y, sr, 0.5 * step, 0.15);
  const feats = noteFeaturesOffline(y, sr, onsets);
  const ref = parseCsv(await csvF.text());

  const n = Math.min(feats.length, ref.length);
  const dts = [];
  for (let i = 0; i < n; i++) dts.push((feats[i].onset_s - ref[i].onset_s) * 1000);
  const med = median(dts);
  const centered = dts.map((d) => d - med);
  const st = std(centered);
  let timeOk = 0;
  let peakOk = 0;
  let cenOk = 0;
  const rows = [];
  for (let i = 0; i < Math.max(feats.length, ref.length); i++) {
    const a = feats[i];
    const b = ref[i];
    if (!a || !b) {
      rows.push({ i, status: "MISSING", dt: "", pk: "", cen: "" });
      continue;
    }
    const dt = (a.onset_s - b.onset_s) * 1000 - med;
    const pk = (a.peak / (b.peak || 1e-12) - 1) * 100;
    const cen = (a.centroid / (b.centroid || 1e-12) - 1) * 100;
    if (Math.abs(dt) <= 1) timeOk++;
    if (Math.abs(pk) <= 2) peakOk++;
    if (Math.abs(cen) <= 5) cenOk++;
    rows.push({
      i,
      status: Math.abs(dt) <= 1 && Math.abs(pk) <= 2 && Math.abs(cen) <= 5 ? "PASS" : "fail",
      dt: dt.toFixed(2),
      pk: pk.toFixed(2),
      cen: cen.toFixed(2),
      tA: a.onset_s.toFixed(4),
      tB: b.onset_s.toFixed(4),
    });
  }
  const countPass = feats.length === ref.length;
  const stdPass = st < 1;
  const tPass = n && timeOk === n;
  const pPass = n && peakOk === n;
  const cPass = n && cenOk === n;
  sum.textContent = [
    `file sr=${sr}  browser n=${feats.length}  ref n=${ref.length}  ${countPass ? "PASS" : "FAIL"} count`,
    `median offset ${med.toFixed(2)} ms   std ${st.toFixed(3)} ms  ${stdPass ? "PASS" : "FAIL"} (need < 1 ms)`,
    `time ±1 ms after median: ${timeOk}/${n}  ${tPass ? "PASS" : "FAIL"}`,
    `peak ±2%: ${peakOk}/${n}  ${pPass ? "PASS" : "FAIL"}`,
    `centroid ±5%: ${cenOk}/${n}  ${cPass ? "PASS" : "FAIL"}`,
    `OVERALL ${countPass && stdPass && tPass && pPass && cPass ? "PASS" : "FAIL"}`,
  ].join("\n");
  tbl.innerHTML = `<thead><tr><th>#</th><th>Δms</th><th>peak %</th><th>cent %</th><th>ours s</th><th>ref s</th><th></th></tr></thead>` +
    rows.map((r) => `<tr class="${r.status === "PASS" ? "ok" : "bad"}"><td>${r.i}</td><td>${r.dt}</td><td>${r.pk}</td><td>${r.cen}</td><td>${r.tA || ""}</td><td>${r.tB || ""}</td><td>${r.status}</td></tr>`).join("");
}

async function decodeAtNativeRate(arrayBuffer) {
  const info = readWavHeader(arrayBuffer);
  const frames = info ? info.frames : 48000 * 30;
  const sr = info ? info.sampleRate : 48000;
  const off = new OfflineAudioContext(1, frames, sr);
  return off.decodeAudioData(arrayBuffer.slice(0));
}

function readWavHeader(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 44) return null;
  if (String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)) !== "RIFF") return null;
  const sampleRate = v.getUint32(24, true);
  const channels = v.getUint16(22, true);
  let offset = 12;
  while (offset + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(offset), v.getUint8(offset + 1), v.getUint8(offset + 2), v.getUint8(offset + 3));
    const size = v.getUint32(offset + 4, true);
    if (id === "data") {
      const bits = v.getUint16(34, true);
      const bytesPer = (bits / 8) * channels;
      return { sampleRate, frames: bytesPer ? Math.floor(size / bytesPer) : 0 };
    }
    offset += 8 + size + (size % 2);
  }
  return { sampleRate, frames: sampleRate * 60 };
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const hdr = lines[0].split(",");
  const ti = hdr.indexOf("onset_s");
  const pi = hdr.indexOf("peak");
  const ci = hdr.indexOf("centroid");
  return lines.slice(1).map((ln) => {
    const c = ln.split(",");
    return { onset_s: +c[ti], peak: +c[pi], centroid: +c[ci] };
  });
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}
