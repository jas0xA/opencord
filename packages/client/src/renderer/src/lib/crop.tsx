// Crop & reposition for avatars, banners and icons. Instead of re-encoding through a canvas (which
// would flatten GIF/APNG/WebP animation), the crop is stored as a "#crop=x,y,zoom" fragment on the
// image URL and applied at render time: x/y are the focal point in percent (object-position) and the
// image is scaled by `zoom` around that point. Any image type keeps working, animated or not.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { fileToDataUrl, pickFile } from './api';

export interface Crop {
  x: number;
  y: number;
  zoom: number;
}

export type CropShape = 'circle' | 'square' | 'banner' | 'guild-banner';

const ASPECT: Record<CropShape, number> = { circle: 1, square: 1, banner: 5 / 2, 'guild-banner': 16 / 9 };

const CROP_RE = /#crop=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/;

export function parseCrop(url: string | null | undefined): Crop | null {
  const m = url ? CROP_RE.exec(url) : null;
  if (!m) return null;
  return { x: clamp(+m[1], 0, 100), y: clamp(+m[2], 0, 100), zoom: clamp(+m[3], 1, 5) };
}

export function stripCrop(url: string): string {
  return url.replace(CROP_RE, '');
}

export function withCrop(url: string, c: Crop): string {
  return `${stripCrop(url)}#crop=${c.x.toFixed(1)},${c.y.toFixed(1)},${c.zoom.toFixed(2)}`;
}

/** Style for an <img> with object-fit: cover. */
export function cropImgStyle(c: Crop | null): CSSProperties | undefined {
  if (!c) return undefined;
  const origin = `${c.x}% ${c.y}%`;
  return { objectFit: 'cover', objectPosition: origin, transform: c.zoom !== 1 ? `scale(${c.zoom})` : undefined, transformOrigin: origin };
}

/**
 * Background style for a cropped image. The zoomed layer is drawn by a ::before (see .crop-bg in
 * app.css) so the element's own children stay unscaled.
 */
export function cropBgStyle(url: string, c: Crop | null): CSSProperties {
  if (!c) return { backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  return {
    backgroundColor: '#000',
    ['--crop-img' as string]: `url(${url})`,
    ['--crop-pos' as string]: `${c.x}% ${c.y}%`,
    ['--crop-zoom' as string]: String(c.zoom),
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function CropDialog({ src, shape, onDone }: { src: string; shape: CropShape; onDone: (c: Crop | null) => void }) {
  const [crop, setCrop] = useState<Crop>(parseCrop(src) ?? { x: 50, y: 50, zoom: 1 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; start: Crop } | null>(null);
  const aspect = ASPECT[shape];
  const fw = Math.min(440, 320 * aspect);
  const fh = fw / aspect;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone(null);
      if (e.key === 'Enter') onDone(crop);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [crop, onDone]);

  // Size of the image after object-fit: cover, before zoom.
  const cover = natural ? Math.max(fw / natural.w, fh / natural.h) : 1;
  const cw = natural ? natural.w * cover : fw;
  const ch = natural ? natural.h * cover : fh;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, start: crop };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // A focal-point change of 1% moves the image by (frame − scaled image) / 100 px; invert that so
    // the point under the cursor follows it.
    const slackX = fw - d.start.zoom * cw;
    const slackY = fh - d.start.zoom * ch;
    const x = slackX < -0.5 ? d.start.x + (100 * (e.clientX - d.px)) / slackX : d.start.x;
    const y = slackY < -0.5 ? d.start.y + (100 * (e.clientY - d.py)) / slackY : d.start.y;
    setCrop({ ...d.start, x: clamp(x, 0, 100), y: clamp(y, 0, 100) });
  };
  const onWheel = (e: React.WheelEvent) => setCrop((c) => ({ ...c, zoom: clamp(c.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 5) }));

  const imgSrc = stripCrop(src);
  return (
    <div className="layer crop-layer" onMouseDown={() => onDone(null)}>
      <div className="modal crop-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Edit Image</h2>
        </div>
        <div className="modal-body">
          <div
            ref={frame}
            className={`crop-frame${shape === 'circle' ? ' circle' : ''}`}
            style={{ width: fw, height: fh }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onWheel={onWheel}
          >
            <img
              src={imgSrc}
              alt=""
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={{ width: '100%', height: '100%', display: 'block', ...cropImgStyle(crop) }}
            />
            <div className="crop-mask" />
          </div>
          <div className="crop-zoom">
            <span>−</span>
            <input type="range" min={1} max={5} step={0.01} value={crop.zoom} onChange={(e) => setCrop({ ...crop, zoom: +e.target.value })} />
            <span>+</span>
          </div>
          <div className="crop-hint">Drag to reposition · scroll or use the slider to zoom</div>
        </div>
        <div className="modal-footer">
          <button className="btn link left" onClick={() => setCrop({ x: 50, y: 50, zoom: 1 })}>Reset</button>
          <button className="btn link" onClick={() => onDone(null)}>Cancel</button>
          <button className="btn" onClick={() => onDone(crop)}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/** Opens the crop dialog for an image (data: or http URL). Resolves to the URL with its crop, or null if cancelled. */
export function cropImage(src: string, shape: CropShape): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (c: Crop | null) => {
      root.unmount();
      host.remove();
      resolve(c ? withCrop(src, c) : null);
    };
    root.render(<CropDialog src={src} shape={shape} onDone={done} />);
  });
}

/** File picker → crop dialog. Resolves to a data URL carrying its crop, or null if cancelled. */
export async function pickAndCropImage(shape: CropShape, accept = 'image/*'): Promise<string | null> {
  const [f] = await pickFile(accept);
  if (!f) return null;
  return cropImage(await fileToDataUrl(f), shape);
}
