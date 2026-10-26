import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline/promises';
import { defaultUserSettings, passwordProblem, usernameProblem } from '@opencord/shared';
import { VERSION, buildApp } from './app';
import { CertManager } from './acme';
import { loadConfig, watchConfig } from './config';
import { setTomlValue } from './config-edit';
import { openDatabase } from './db';
import { hashPassword } from './routes/auth';
import { snowflake } from './util';

const HELP = `OpenCord server ${VERSION}

Usage: opencord-server [command] [--config <path>]

Commands:
  start                              Start the server (default)
  init                               Write a default config.toml and exit
  allow-email add <email> [note]     Allow an email to register (allowlist mode)
  allow-email remove <email>         Remove an email from the allowlist
  allow-email list                   Show the allowlist
  set-registration <mode>            open | invite_only | allowlist | closed
  create-admin                       Interactively create an admin account
  make-admin <username>              Grant instance admin to an existing user
  reset-password <username>          Set a new password for a user
  disable-user <username>            Disable an account and sign it out
  enable-user <username>             Re-enable a disabled account
  users                              List accounts
  backup [file]                      Write a consistent copy of the database
  version                            Print the version

The config path defaults to ./config.toml (or $OPENCORD_CONFIG).`;

async function prompt(q: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const out = rl as any;
    out._writeToOutput = (s: string) => out.output.write(s.includes(q) ? s : '');
  }
  const a = await rl.question(q);
  if (hidden) process.stdout.write('\n');
  rl.close();
  return a.trim();
}

async function main() {
  const args = process.argv.slice(2).filter((a, i, arr) => a !== '--config' && arr[i - 1] !== '--config');
  const cmd = args[0] ?? 'start';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'version' || cmd === '--version') return console.log(VERSION);

  const config = loadConfig();
  if (cmd === 'init') return console.log(`Config: ${config.configPath}`);

  const db = openDatabase(config.dataDir);
  const findUser = (name: string) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(name.toLowerCase(), name.toLowerCase()) as any;
    if (!u) throw new Error(`No user named ${name}`);
    return u;
  };

  switch (cmd) {
    case 'start':
      return start(config, db);

    case 'allow-email': {
      const [, sub, email, ...note] = args;
      if (sub === 'list') {
        const rows = db.prepare('SELECT * FROM allowlist ORDER BY added_at').all() as any[];
        if (!rows.length) console.log('Allowlist is empty.');
        for (const r of rows) console.log(`${r.email.padEnd(40)} ${r.used_at ? 'used ' + new Date(r.used_at).toISOString() : 'unused'}  ${r.note}`);
      } else if (sub === 'add' && email) {
        db.prepare('INSERT INTO allowlist (email, note, added_at) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET used_at = NULL').run(
          email.toLowerCase(), note.join(' '), Date.now(),
        );
        console.log(`Added ${email}.`);
        if (config.registration.mode !== 'allowlist') {
          console.log(`Note: registration mode is "${config.registration.mode}". Run "set-registration allowlist" to require the allowlist.`);
        }
      } else if (sub === 'remove' && email) {
        const r = db.prepare('DELETE FROM allowlist WHERE email = ?').run(email.toLowerCase());
        console.log(r.changes ? `Removed ${email}.` : `${email} was not on the allowlist.`);
      } else console.log('Usage: allow-email add|remove|list <email>');
      return;
    }

    case 'set-registration': {
      const mode = args[1];
      if (!['open', 'invite_only', 'allowlist', 'closed'].includes(mode)) return console.log('Mode must be one of: open, invite_only, allowlist, closed');
      setTomlValue(config.configPath, 'registration', 'mode', mode);
      return console.log(`Registration mode set to "${mode}" in ${config.configPath}. A running server picks this up automatically.`);
    }

    case 'create-admin': {
      const username = (await prompt('Username: ')).toLowerCase();
      const nameErr = usernameProblem(username);
      if (nameErr) throw new Error(`Username: ${nameErr}`);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('Username is taken');
      const email = (await prompt('Email: ')).toLowerCase();
      const password = await prompt('Password: ', true);
      const pwErr = passwordProblem(password, { minLength: config.registration.min_password_length, username });
      if (pwErr) throw new Error(`Password: ${pwErr}`);
      db.prepare(
        'INSERT INTO users (id, username, email, password_hash, admin, email_verified, settings, created_at) VALUES (?,?,?,?,1,1,?,?)',
      ).run(snowflake(), username, email, await hashPassword(password), JSON.stringify(defaultUserSettings()), Date.now());
      return console.log(`Admin ${username} created.`);
    }

    case 'make-admin': {
      const u = findUser(args[1] ?? '');
      db.prepare('UPDATE users SET admin = 1 WHERE id = ?').run(u.id);
      return console.log(`${u.username} is now an instance admin.`);
    }

    case 'reset-password': {
      const u = findUser(args[1] ?? '');
      const password = await prompt(`New password for ${u.username}: `, true);
      const pwErr = passwordProblem(password, { minLength: config.registration.min_password_length, username: u.username });
      if (pwErr) throw new Error(`Password: ${pwErr}`);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      return console.log('Password updated; all sessions signed out.');
    }

    case 'disable-user':
    case 'enable-user': {
      const u = findUser(args[1] ?? '');
      const disable = cmd === 'disable-user';
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(+disable, u.id);
      if (disable) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      return console.log(`${u.username} ${disable ? 'disabled' : 'enabled'}.`);
    }

    case 'users': {
      for (const u of db.prepare('SELECT username, email, admin, disabled, created_at FROM users ORDER BY created_at').all() as any[]) {
        console.log(`${u.username.padEnd(24)} ${u.email.padEnd(36)} ${u.admin ? 'admin ' : ''}${u.disabled ? 'disabled' : ''}`);
      }
      return;
    }

    case 'backup': {
      const target = path.resolve(args[1] ?? `opencord-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      await db.backup(target);
      return console.log(`Backup written to ${target}`);
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

async function start(config: ReturnType<typeof loadConfig>, db: ReturnType<typeof openDatabase>) {
  if (config.logging.file) {
    const stream = fs.createWriteStream(config.logging.file, { flags: 'a' });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      stream.write(chunk);
      return orig(chunk, ...rest);
    }) as any;
  }
  // Automatic HTTPS: a certificate must exist before the HTTPS server starts.
  let certs: CertManager | null = null;
  if (config.tls.auto) {
    certs = new CertManager({
      dataDir: config.dataDir,
      publicUrl: config.server.public_url,
      email: config.tls.email,
      directory: config.tls.acme_directory,
      httpPort: config.tls.http_port,
      host: config.server.host,
    });
    await certs.listen();
    await certs.ensure();
    Object.assign(config.tls, { enabled: true, ...certs.files });
  }
  const { app } = await buildApp(config, db);
  watchConfig(config);
  await app.listen({ host: config.server.host, port: config.server.port });
  certs?.startRenewal((files) => {
    (app.server as unknown as https.Server).setSecureContext({ cert: fs.readFileSync(files.cert), key: fs.readFileSync(files.key) });
    console.log('[tls] now serving the renewed certificate');
  });
  const proto = config.tls.enabled ? 'https' : 'http';
  console.log(`\n  OpenCord ${VERSION} — "${config.instance.name}"`);
  console.log(`  Listening on ${proto}://${config.server.host}:${config.server.port}`);
  if (certs) console.log(`  HTTPS:  automatic certificate for ${certs.identifier.value} (port ${config.tls.http_port} for validation)`);
  console.log(`  Registration: ${config.registration.mode}`);
  console.log(`  Config: ${config.configPath}`);
  console.log(`  Data:   ${config.dataDir}\n`);

  const shutdown = async () => {
    await certs?.close();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
