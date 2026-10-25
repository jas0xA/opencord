import fs from 'node:fs';

/**
 * Sets `key = value` inside `[section]` of a TOML file, preserving comments and layout.
 * Supports scalars and flat arrays of strings.
 */
export function setTomlValue(file: string, section: string, key: string, value: string | number | boolean | string[]) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const literal = Array.isArray(value) ? `[${value.map((v) => JSON.stringify(v)).join(', ')}]` : typeof value === 'string' ? JSON.stringify(value) : String(value);
  let inSection = false;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (header) {
      if (inSection) {
        sectionEnd = i;
        break;
      }
      inSection = header[1].trim() === section;
      continue;
    }
    if (inSection && new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      const comment = /\s+#.*$/.exec(lines[i].replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length)))?.[0] ?? '';
      lines[i] = `${key} = ${literal}${comment}`;
      fs.writeFileSync(file, lines.join('\n'));
      return;
    }
  }
  if (inSection) {
    lines.splice(sectionEnd === -1 ? lines.length : sectionEnd, 0, `${key} = ${literal}`);
  } else {
    lines.push('', `[${section}]`, `${key} = ${literal}`);
  }
  fs.writeFileSync(file, lines.join('\n'));
}
