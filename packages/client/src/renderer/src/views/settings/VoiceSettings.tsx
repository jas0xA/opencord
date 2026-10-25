import { useEffect, useRef, useState } from 'react';
import type { UserSettings } from '@opencord/shared';
import { updateSettings, useStore } from '../../lib/store';
import { voice } from '../../lib/voice';
import { Toggle } from '../server-settings/ServerSettings';
import { Row } from './UserSettings';
import { StreamQualityPicker } from '../../components/Voice';

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    // Labels are only exposed after permission is granted once.
    navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), load())).catch(load);
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);
  return devices;
}

function DeviceSelect({ kind, k }: { kind: MediaDeviceKind; k: keyof UserSettings }) {
  const devices = useDevices().filter((d) => d.kind === kind);
  const value = useStore((s) => s.me!.settings[k]) as string;
  return (
    <select className="input select" value={value} onChange={(e) => updateSettings({ [k]: e.target.value } as Partial<UserSettings>)}>
      <option value="default">Default</option>
      {devices.filter((d) => d.deviceId !== 'default').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 12)}</option>)}
    </select>
  );
}

function MicTest() {
  const [level, setLevel] = useState(-100);
  const [running, setRunning] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const threshold = useStore((s) => s.me!.settings.vad_threshold);
  useEffect(() => () => stop.current?.(), []);
  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 100) / 100) * 100));
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          className="btn"
          onClick={async () => {
            if (running) {
              stop.current?.();
              setRunning(false);
              setLevel(-100);
            } else {
              stop.current = await voice.testMic(setLevel);
              setRunning(true);
            }
          }}
        >
          {running ? 'Stop Testing' : "Let's Check"}
        </button>
        <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'var(--bg-input)', position: 'relative', overflow: 'hidden' }}>
          <div style={{ width: `${pct(level)}%`, height: '100%', background: level > threshold ? 'var(--green-status)' : 'var(--yellow-status)', transition: 'width .05s' }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${pct(threshold)}%`, width: 2, background: '#fff' }} />
        </div>
      </div>
      <div className="us-field-label" style={{ marginTop: 20 }}>Input Sensitivity — {threshold} dB</div>
      <input type="range" min={-100} max={0} value={threshold} onChange={(e) => updateSettings({ vad_threshold: +e.target.value })} style={{ width: '100%' }} />
    </div>
  );
}

function CameraPreview() {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const deviceId = useStore((s) => s.me!.settings.video_device);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined } })
      .then((s) => {
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch(() => setOn(false));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [on, deviceId]);
  return (
    <div style={{ borderRadius: 8, background: '#000', aspectRatio: '16/9', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      {on ? <video ref={ref} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} /> : <button className="btn" onClick={() => setOn(true)}>Test Video</button>}
    </div>
  );
}

export function VoicePage() {
  const s = useStore((st) => st.me!.settings);
  const [binding, setBinding] = useState(false);
  useEffect(() => {
    if (!binding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      updateSettings({ ptt_key: e.code });
      setBinding(false);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [binding]);
  return (
    <div className="us-page">
      <h3>Voice Settings</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <div>
          <div className="us-field-label" style={{ marginBottom: 8 }}>Input Device</div>
          <DeviceSelect kind="audioinput" k="input_device" />
          <div className="us-field-label" style={{ margin: '16px 0 8px' }}>Input Volume — {s.input_volume}%</div>
          <input type="range" min={0} max={200} value={s.input_volume} onChange={(e) => updateSettings({ input_volume: +e.target.value })} style={{ width: '100%' }} />
        </div>
        <div>
          <div className="us-field-label" style={{ marginBottom: 8 }}>Output Device</div>
          <DeviceSelect kind="audiooutput" k="output_device" />
          <div className="us-field-label" style={{ margin: '16px 0 8px' }}>Output Volume — {s.output_volume}%</div>
          <input type="range" min={0} max={200} value={s.output_volume} onChange={(e) => updateSettings({ output_volume: +e.target.value })} style={{ width: '100%' }} />
        </div>
      </div>
      <h3>Mic Test</h3>
      <MicTest />
      <h3 style={{ marginTop: 32 }}>Input Mode</h3>
      <div className="choice-list" style={{ marginBottom: 16 }}>
        <button className={`choice${s.input_mode === 'vad' ? ' selected' : ''}`} onClick={() => updateSettings({ input_mode: 'vad' })}>Voice Activity</button>
        <button className={`choice${s.input_mode === 'ptt' ? ' selected' : ''}`} onClick={() => updateSettings({ input_mode: 'ptt' })}>Push to Talk</button>
      </div>
      {s.input_mode === 'ptt' && (
        <Row title="Shortcut" desc="Hold this key while the OpenCord window is focused to talk.">
          <button className={`btn sm${binding ? ' danger' : ' secondary'}`} onClick={() => setBinding(true)}>{binding ? 'Press a key…' : s.ptt_key || 'Record Keybind'}</button>
        </Row>
      )}
      <h3 style={{ marginTop: 32 }}>Voice Processing</h3>
      <Row title="Echo Cancellation"><Toggle on={s.echo_cancellation} onChange={(v) => updateSettings({ echo_cancellation: v })} /></Row>
      <Row title="Noise Suppression" desc="Suppress background noise from your mic."><Toggle on={s.noise_suppression} onChange={(v) => updateSettings({ noise_suppression: v })} /></Row>
      <Row title="Automatic Gain Control"><Toggle on={s.auto_gain} onChange={(v) => updateSettings({ auto_gain: v })} /></Row>
      <h3 style={{ marginTop: 32 }}>Screen Share Quality</h3>
      <StreamQualityPicker />
      <h3 style={{ marginTop: 32 }}>Video Settings</h3>
      <div className="us-field-label" style={{ marginBottom: 8 }}>Camera</div>
      <DeviceSelect kind="videoinput" k="video_device" />
      <div style={{ marginTop: 16 }}><CameraPreview /></div>
    </div>
  );
}
