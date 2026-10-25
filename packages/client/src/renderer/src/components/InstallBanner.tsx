import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { canPromptInstall, isAndroid, isIOS, isStandalone, isWeb, onInstallPromptChange, promptInstall } from '../lib/web';

const DISMISS_KEY = 'opencord.installBanner.dismissed';

/** Web only: how to install OpenCord on this device (home-screen shortcut, PWA install or Android APK). */
export function InstallBanner() {
  const instance = useStore((s) => s.instance);
  const [, force] = useState(0);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => onInstallPromptChange(() => force((n) => n + 1)), []);
  if (!isWeb() || isStandalone() || dismissed) return null;

  const apk = isAndroid() && instance?.web?.android_apk;
  const ios = isIOS();
  const prompt = canPromptInstall();
  if (!ios && !apk && !prompt) return null;

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="install-banner">
      <img src="./icon-192.png" alt="" />
      <div className="ib-text">
        <b>Get the OpenCord app</b>
        {ios ? (
          <span>
            Tap <Share size={13} style={{ verticalAlign: -2 }} /> <b>Share</b>, then <b>Add to Home Screen</b>.
          </span>
        ) : (
          <span>Install it for a full-screen app with its own icon.</span>
        )}
      </div>
      {prompt && (
        <button className="btn sm" onClick={() => promptInstall().then((ok) => ok && close())}>
          Install
        </button>
      )}
      {apk && (
        <a className="btn sm secondary" href="/download/android" download>
          <Download size={14} /> APK
        </a>
      )}
      <button className="icon-btn" aria-label="Dismiss" onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}
