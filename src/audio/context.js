const DISABLE_VOICE = {
  echoCancellation: false,
  autoGainControl: false,
  noiseSuppression: false,
};

export function createAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return new Ctx({ latencyHint: "interactive" });
}

export async function resumeContext(ctx) {
  if (ctx.state !== "running") await ctx.resume();
  return ctx.state;
}

export async function requestInputStream(deviceId) {
  const audio = {
    ...DISABLE_VOICE,
    channelCount: { ideal: 1 },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

export async function listInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export function trackSettings(stream) {
  const track = stream?.getAudioTracks?.()[0];
  return track ? track.getSettings() : {};
}

export function describeSettings(settings) {
  const flags = [
    ["echoCancellation", settings.echoCancellation],
    ["autoGainControl", settings.autoGainControl],
    ["noiseSuppression", settings.noiseSuppression],
  ];
  const bad = flags.filter(([, v]) => v === true).map(([k]) => k);
  const ok = flags.every(([, v]) => v === false);
  return { ok, bad, settings };
}

export async function loadWorklet(ctx) {
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  return new AudioWorkletNode(ctx, "onset-detector", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
  });
}
