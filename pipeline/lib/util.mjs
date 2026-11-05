// Small shared helpers for the application pipeline. No business rules here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const sha256File = (path) => sha256(readFileSync(path));

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write through a temp file so a crash never leaves a half-written artifact. */
export function atomicWrite(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
export const readIfExists = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.error && res.error.code === 'ENOENT') {
    return { status: 127, stdout: '', stderr: `${cmd}: command not found`, missing: true };
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export const hasCommand = (cmd) => run('which', [cmd]).status === 0;

export function slugify(text, max = 48) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'role';
}

export function todayLocal(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Display an ISO calendar date in the configured cover-letter style. */
export function formatLetterDate(value, format = 'iso') {
  const raw = String(value ?? '').trim();
  if (format === 'iso') return raw;
  if (format !== 'day-month-year') throw new Error(`Unknown cover-letter date format: ${format}`);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new Error(`Invalid cover-letter date: ${raw}`);
  }
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${day} ${months[month - 1]} ${year}`;
}

/** Compare quoted text against extracted text, ignoring whitespace, case and hyphen wraps. */
export function squash(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[\s •]+/g, '')
    .toLowerCase();
}

/**
 * Pull one JSON object out of model output: tolerates a code fence or a sentence
 * either side of it, and refuses anything that does not parse.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidates.unshift(fence[1]);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch { /* try the next candidate */ }
  }
  throw new Error('output did not contain a parseable JSON object');
}

/** Strip one wrapping markdown fence from a model's markdown output. */
export function stripFence(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/);
  return match ? match[1] : raw;
}
