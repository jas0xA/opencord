import fs from 'node:fs';
import path from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import { snowflake, badRequest } from './util';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/apng': 'png',
  'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'video/mp4': 'mp4',
  'video/webm': 'webm', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip',
};

const CROP_RE = /#crop=\d{1,3}(?:\.\d+)?,\d{1,3}(?:\.\d+)?,\d(?:\.\d+)?$/;

/** Splits a client value like "data:...;base64,...#crop=50,40,1.2" into the image and its crop fragment. */
export function splitCrop(value: string): { image: string; crop: string } {
  const m = CROP_RE.exec(value);
  return m ? { image: value.slice(0, m.index), crop: m[0] } : { image: value, crop: '' };
}

export class FileStore {
  constructor(public root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  /** Saves a buffer and returns the public path (relative to /uploads). */
  saveBuffer(kind: string, buf: Buffer, ext: string, name?: string): string {
    const id = name ?? snowflake();
    const dir = path.join(this.root, kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${id}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'}`;
    fs.writeFileSync(path.join(dir, file), buf);
    return `${kind}/${file}`;
  }

  /** Accepts a data: URL (as sent by the client for avatars, icons, etc). */
  saveDataUrl(kind: string, dataUrl: string, maxBytes: number, allowed = /^image\//): string {
    const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/i.exec(splitCrop(dataUrl).image);
    if (!m) throw badRequest('Invalid image data');
    const mime = m[1].toLowerCase();
    if (!allowed.test(mime)) throw badRequest(`Unsupported file type ${mime}`);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > maxBytes) throw badRequest(`File is larger than ${Math.round(maxBytes / 1024)} KB`);
    return this.saveBuffer(kind, buf, EXT_BY_MIME[mime] ?? mime.split('/')[1] ?? 'bin');
  }

  /**
   * Applies a new avatar/banner/icon value against the stored one and returns what to store.
   * Values may carry a "#crop=x,y,zoom" fragment (render-time crop). Sending the current image's
   * URL with a new fragment only changes the crop; a data: URL replaces the file.
   */
  updateImage(kind: string, current: string | null, value: string | null, maxBytes: number): string | null {
    if (!value) {
      this.remove(current);
      return null;
    }
    const { image, crop } = splitCrop(value);
    const currentBase = current ? splitCrop(current).image : null;
    if (currentBase && (image === currentBase || image === `/uploads/${currentBase}` || image.endsWith(`/uploads/${currentBase}`))) {
      return currentBase + crop;
    }
    this.remove(current);
    return this.saveDataUrl(kind, image, maxBytes) + crop;
  }

  async saveMultipart(kind: string, file: MultipartFile, maxBytes: number) {
    const buf = await file.toBuffer();
    if (buf.length > maxBytes) throw badRequest('File too large');
    const ext = path.extname(file.filename).slice(1) || EXT_BY_MIME[file.mimetype] || 'bin';
    return { path: this.saveBuffer(kind, buf, ext), size: buf.length, mime: file.mimetype };
  }

  remove(rel: string | null | undefined) {
    if (!rel || rel.startsWith('market:') || /^https?:\/\//.test(rel)) return;
    const p = path.join(this.root, splitCrop(rel).image);
    if (p.startsWith(this.root)) fs.rm(p, { force: true }, () => {});
  }
}

/** Reads width/height from PNG/GIF/JPEG/WebP headers, without decoding. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* fallthrough */
  }
  return null;
}
