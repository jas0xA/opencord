import type { PresenceStatus, PublicUser } from '@opencord/shared';
import { cdn } from '../lib/api';
import { cropImgStyle, parseCrop } from '../lib/crop';
import { statusOf, useStore } from '../lib/store';
import { defaultAvatarColor } from '../lib/utils';
import { Decoration } from './Cosmetics';
import { Logo, StatusIcon } from './Icons';

interface Props {
  user: PublicUser | null | undefined;
  size?: number;
  status?: PresenceStatus | boolean; // true = look up presence
  ring?: string; // status ring color (match background)
  speaking?: boolean;
  decoration?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}

export function Avatar({ user, size = 32, status, ring, speaking, decoration = true, onClick, className }: Props) {
  // Subscribe to presence so the dot updates live.
  const live = useStore((s) => (status === true && user ? s.presences[user.id]?.status : undefined));
  const resolved: PresenceStatus | null = status === true && user ? (live ?? statusOf(user.id)) : typeof status === 'string' ? status : null;
  const src = cdn(user?.avatar);
  const dot = Math.max(10, Math.round(size * 0.3));
  return (
    <div
      className={`avatar${speaking ? ' speaking' : ''}${className ? ' ' + className : ''}`}
      style={{
        width: size,
        height: size,
        cursor: onClick ? 'pointer' : undefined,
        ['--status-ring' as string]: ring,
        ['--speak-w' as string]: `${size >= 64 ? 4 : size >= 40 ? 3 : 2}px`,
        ['--speak-gap' as string]: `${size >= 64 ? 3 : size >= 40 ? 2 : 1}px`,
      }}
      onClick={onClick}
    >
      {src ? (
        // The wrapper does the circular clip: Chromium can skip border-radius on animated images
        // (GIF/APNG/WebP) composited on their own layer, which left square animated avatars.
        <div className="av-clip">
          <img className="av-img" src={src} alt="" draggable={false} style={cropImgStyle(parseCrop(src))} />
        </div>
      ) : (
        <div className="av-default" style={{ background: defaultAvatarColor(user?.id ?? '0') }}>
          <Logo size={size * 0.6} style={{ ['--logo-cut' as string]: defaultAvatarColor(user?.id ?? '0') }} />
        </div>
      )}
      {decoration && user?.avatar_decoration && <Decoration id={user.avatar_decoration} />}
      {resolved && (
        <div className="status" style={{ borderWidth: size >= 64 ? 5 : 3, right: size >= 64 ? -1 : -3, bottom: size >= 64 ? -1 : -3 }}>
          <StatusIcon status={resolved === 'invisible' ? 'offline' : resolved} size={size >= 64 ? Math.round(size * 0.2) : dot} />
        </div>
      )}
    </div>
  );
}
