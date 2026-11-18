#!/usr/bin/env node
/**
 * The code Ambient is allowed to read, as one file.
 *
 * The Worker cannot read its own src/ at runtime and the browser can only reach
 * what is served, so "the assistant can read the app" needs a file on the asset
 * side: this one. It is a deliberate list, not a walk of the repo - secret files,
 * wrangler.jsonc (binding ids) and evidence/ are never in it.
 *
 * Run it after changing any of those files: npm run snapshot
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'public', 'source-snapshot.json');

/** Directories whose files are in, by extension. */
const DIRS = [
  ['src', (name) => name.endsWith('.js')],
  ['docs', (name) => name.endsWith('.md')],
];
/** Single files that are always in. */
const FILES = ['AGENTS.md', 'public/index.html', 'public/style.css', 'public/script.js'];

function walk(dir, keep) {
  const found = [];
  const visit = (rel) => {
    let entries;
    try { entries = readdirSync(join(ROOT, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const child = rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        visit(child);
      } else if (keep(entry.name)) {
        found.push(child);
      }
    }
  };
  visit(dir);
  return found;
}

/** One line saying what a file is for, read from the file itself. */
function purpose(text, path) {
  if (path.endsWith('.md')) {
    const heading = text.match(/^#\s+(.+)$/m);
    return heading ? heading[1].trim().slice(0, 120) : '';
  }
  const doc = text.match(/\/\*\*([\s\S]*?)\*\//);
  const line = doc ? doc[1] : ((text.match(/^\s*\/\/\s*(.+)$/m) || [])[1] || '');
  return line.replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

const list = [...FILES];
for (const [dir, keep] of DIRS) list.push(...walk(dir, keep));

const files = [];
for (const path of list) {
  let text;
  try {
    if (!statSync(join(ROOT, path)).isFile()) continue;
    text = readFileSync(join(ROOT, path), 'utf8');
  } catch (e) {
    continue;
  }
  files.push({
    path,
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').length,
    purpose: purpose(text, path),
    text
  });
}

files.sort((a, b) => a.path.localeCompare(b.path));
const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  count: files.length,
  bytes: files.reduce((sum, f) => sum + f.bytes, 0),
  files
};
writeFileSync(OUT, JSON.stringify(payload));

console.log(`source snapshot: ${payload.count} files, ${(payload.bytes / 1024).toFixed(0)} KiB of source -> public/source-snapshot.json (${(JSON.stringify(payload).length / 1024).toFixed(0)} KiB)`);
