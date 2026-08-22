const IDB_NAME = "pluck-trainer";
const IDB_STORE = "sessions";
const LS_CUSTOM = "pluck.customPatterns";
const LS_CAL = "pluck.calibration";
const LS_SETTINGS = "pluck.settings";
const LS_SEQ = "pluck.customSequences";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(record) {
  const db = await openDb();
  const all = await listSessions();
  const withHits = all.filter((s) => s.hits?.length).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (record.hits && withHits.length >= 20 && !withHits.some((s) => s.id === record.id)) {
    const drop = withHits[withHits.length - 1];
    if (drop.id !== record.id) {
      const tx0 = db.transaction(IDB_STORE, "readwrite");
      const slim = { ...drop };
      delete slim.hits;
      tx0.objectStore(IDB_STORE).put(slim);
      await txDone(tx0);
    }
  }
  const tx = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).put(record);
  await txDone(tx);
  db.close();
}

export async function listSessions() {
  const db = await openDb();
  const tx = db.transaction(IDB_STORE, "readonly");
  const req = tx.objectStore(IDB_STORE).getAll();
  const rows = await reqDone(req);
  db.close();
  return (rows || []).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

export async function getSession(id) {
  const db = await openDb();
  const tx = db.transaction(IDB_STORE, "readonly");
  const row = await reqDone(tx.objectStore(IDB_STORE).get(id));
  db.close();
  return row;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function loadCustomPatterns() {
  try {
    return JSON.parse(localStorage.getItem(LS_CUSTOM) || "[]");
  } catch {
    return [];
  }
}

export function saveCustomPattern(p) {
  const all = loadCustomPatterns().filter((x) => x.id !== p.id);
  all.unshift(p);
  localStorage.setItem(LS_CUSTOM, JSON.stringify(all));
  return all;
}

export function deleteCustomPattern(id) {
  const all = loadCustomPatterns().filter((x) => x.id !== id);
  localStorage.setItem(LS_CUSTOM, JSON.stringify(all));
  return all;
}

export function loadCalibration() {
  try {
    return JSON.parse(localStorage.getItem(LS_CAL) || "{}");
  } catch {
    return {};
  }
}

export function saveCalibration(deviceId, ms) {
  const all = loadCalibration();
  all[deviceId || "default"] = ms;
  localStorage.setItem(LS_CAL, JSON.stringify(all));
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

export function loadCustomSequences() {
  try {
    return JSON.parse(localStorage.getItem(LS_SEQ) || "[]");
  } catch {
    return [];
  }
}

export function saveCustomSequence(s) {
  const all = loadCustomSequences().filter((x) => x.id !== s.id);
  all.unshift(s);
  localStorage.setItem(LS_SEQ, JSON.stringify(all));
  return all;
}

export function deleteCustomSequence(id) {
  const all = loadCustomSequences().filter((x) => x.id !== id);
  localStorage.setItem(LS_SEQ, JSON.stringify(all));
  return all;
}
