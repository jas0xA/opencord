// Small synthesized UI sounds, so the client ships no audio assets.
let ctx: AudioContext | null = null;
const audio = () => (ctx ??= new AudioContext());

function tone(freqs: number[], duration = 0.12, gap = 0.08, volume = 0.15, type: OscillatorType = 'sine') {
  const c = audio();
  let t = c.currentTime;
  for (const f of freqs) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    t += gap;
  }
}

export type SoundName = 'message' | 'join' | 'leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'request' | 'disconnect';

let enabled = true;
export function setSoundsEnabled(v: boolean) {
  enabled = v;
}

export function playSound(name: SoundName) {
  if (!enabled) return;
  try {
    switch (name) {
      case 'message': return tone([880, 1320], 0.12, 0.07, 0.08);
      case 'join': return tone([523, 784], 0.15, 0.09, 0.12);
      case 'leave': return tone([784, 523], 0.15, 0.09, 0.12);
      case 'disconnect': return tone([659, 440, 330], 0.15, 0.08, 0.12);
      case 'mute': return tone([440], 0.08, 0, 0.1, 'triangle');
      case 'unmute': return tone([660], 0.08, 0, 0.1, 'triangle');
      case 'deafen': return tone([392, 330], 0.08, 0.06, 0.1, 'triangle');
      case 'undeafen': return tone([330, 392], 0.08, 0.06, 0.1, 'triangle');
      case 'request': return tone([660, 880, 990], 0.1, 0.07, 0.08);
    }
  } catch {
    /* audio unavailable */
  }
}

let ringTimer: ReturnType<typeof setInterval> | null = null;
export function startRinging() {
  if (ringTimer) return;
  const ring = () => tone([784, 988, 784, 988], 0.18, 0.2, 0.12);
  ring();
  ringTimer = setInterval(ring, 2500);
}
export function stopRinging() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}
