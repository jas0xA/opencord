// Starts electron-vite in dev mode. On Linux the unpackaged Electron binary's SUID sandbox helper is
// usually not root-owned, so the sandbox is disabled for development runs only (packaged builds keep it).
import { spawn } from 'node:child_process';

const env = { ...process.env };
if (process.platform === 'linux') env.ELECTRON_DISABLE_SANDBOX = '1';
const child = spawn('npx', ['electron-vite', 'dev', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
