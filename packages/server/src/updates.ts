// "Update available" for the Server Admin page: polls the latest GitHub release a few times a day.
import type { Config } from './config';

const REPO = 'jas0xA/opencord';
const EVERY_MS = 6 * 3600_000;

export interface UpdateInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  url: string | null;
  checked_at: number | null;
  /** How this server was installed, so the admin page can show the right update steps. */
  install: 'docker' | 'tarball' | 'source';
}

/** Compares dotted versions ("0.10.2" > "0.9.9"); ignores a leading "v". */
export function newer(a: string, b: string) {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export class UpdateChecker {
  private info: UpdateInfo;
  private timer: NodeJS.Timeout | null = null;

  constructor(private config: Config, current: string) {
    const install = process.env.OPENCORD_DOCKER ? 'docker' : process.argv[1]?.endsWith('.mjs') ? 'tarball' : 'source';
    this.info = { current, latest: null, update_available: false, url: null, checked_at: null, install };
  }

  start() {
    if (!this.config.updates.check) return;
    const run = () => void this.check().catch(() => {});
    setTimeout(run, 10_000).unref?.();
    this.timer = setInterval(run, EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async check() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'opencord-server' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return this.info;
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    if (rel.tag_name) {
      this.info = { ...this.info, latest: rel.tag_name.replace(/^v/, ''), url: rel.html_url ?? null, checked_at: Date.now(), update_available: newer(rel.tag_name, this.info.current) };
    }
    return this.info;
  }

  get status(): UpdateInfo {
    return this.info;
  }
}
