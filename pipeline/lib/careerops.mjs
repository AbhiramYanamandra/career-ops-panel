// Adapters over the ordinary career-ops scripts. These call the existing tools
// instead of reimplementing them, so gates, tracker rules and report numbering
// stay exactly what the rest of career-ops uses.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../../lib/yaml-document.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { findBlacklistEntry, loadBlacklist } from '../../scan.mjs';
import { REPO_ROOT } from './config.mjs';
import { atomicWrite, run, slugify } from './util.mjs';

const node = (script, args, root, opts = {}) => run(process.execPath, [join(REPO_ROOT, script), ...args], {
  cwd: REPO_ROOT,
  env: { ...process.env, CAREER_OPS_ROOT: root },
  ...opts,
});

const AGGREGATOR_HOSTS = /(^|\.)(linkedin\.com|seek\.com(\.au)?|indeed\.[a-z.]+|glassdoor\.[a-z.]+|ziprecruiter\.com|wellfound\.com|instahyre\.com|cutshort\.io|internshala\.com|naukri\.com)$/i;

export function urlFacts(url) {
  if (!url) return { url: null, linkedin: false, aggregator: false };
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new Error(`Not a valid URL: ${url}`); }
  return { url, host, linkedin: /(^|\.)linkedin\.com$/i.test(host), aggregator: AGGREGATOR_HOSTS.test(host) };
}

export const realDeps = (root) => ({
  /** Returns "active", "expired" or "uncertain". */
  liveness(url) {
    const res = node('check-liveness.mjs', [url], root, { timeout: 180_000 });
    const verdict = (res.stdout.match(/\b(active|expired|uncertain)\b\s+(?:\(api\)\s+)?\S*http/) ?? [])[1];
    return { verdict: verdict ?? 'uncertain', detail: res.stdout.trim().split('\n').slice(0, 6).join(' ').slice(0, 400) };
  },
  /** Reads a JD through free ATS APIs, then one browser extraction. Null on a miss. */
  fetchJd(url) {
    const api = node('fetch-jd.mjs', [url], root, { timeout: 60_000 });
    if (api.status === 0 && api.stdout.trim().length > 200) return { text: api.stdout, via: 'ats-api' };
    const browser = node('browser-extract.mjs', [url, '--max-chars', '60000'], root, { timeout: 120_000 });
    if (browser.status !== 0) return null;
    try {
      const { text } = JSON.parse(browser.stdout);
      return text?.trim().length > 200 ? { text, via: 'browser' } : null;
    } catch {
      return null;
    }
  },
});

/**
 * Blacklist gate. Before evaluation the employer is unconfirmed, so a company
 * entry is matched against the posting's opening text; after evaluation it is
 * matched exactly against the company the report names.
 */
export function blacklistHit(root, { company, url, jobText }) {
  const file = join(root, 'data', 'blacklist.md');
  if (!existsSync(file)) return null;
  const list = loadBlacklist(file);
  const direct = findBlacklistEntry(list, company ?? '', url ?? '');
  if (direct) return direct;
  if (!company && jobText) {
    const head = jobText.slice(0, 2500).toLowerCase();
    for (const entry of list.values()) {
      if (entry.scope === 'domain') continue;
      const name = entry.company.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9])${name}(?![a-z0-9])`).test(head)) return entry;
    }
  }
  return null;
}

export function reserveReportNumber(root) {
  const res = node('reserve-report-num.mjs', [], root);
  const num = res.stdout.trim().match(/\d{3,}/)?.[0];
  if (res.status !== 0 || !num) throw new Error(`Could not reserve a report number: ${res.stderr || res.stdout}`);
  return num;
}

export const releaseReportNumber = (root, num) => node('reserve-report-num.mjs', ['--release', num], root);

/** Validate the evaluation report the same way the career-ops contract defines it. */
export function parseReport(text) {
  const errors = [];
  const summaryBlock = text.match(/## Machine Summary\s+```ya?ml\n([\s\S]*?)\n```/);
  let summary = null;
  if (!summaryBlock) errors.push('Report is missing the "## Machine Summary" YAML block');
  else {
    try { summary = loadYaml(summaryBlock[1]); } catch (err) { errors.push(`Machine Summary is not valid YAML: ${err.message}`); }
  }
  const header = (name) => text.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, 'm'))?.[1];
  for (const name of ['URL', 'Score', 'Legitimacy', 'PDF']) {
    if (!header(name)) errors.push(`Report header is missing **${name}:**`);
  }
  const score = Number(summary?.score ?? header('Score')?.match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(score) || score < 0 || score > 5) errors.push('Report needs a numeric score between 0 and 5');
  for (const block of ['## A)', '## B)', '## G)']) {
    if (!text.includes(block)) errors.push(`Report is missing block ${block}`);
  }
  if (!summary?.company) errors.push('Machine Summary is missing company');
  if (!summary?.role) errors.push('Machine Summary is missing role');
  return {
    errors,
    company: summary?.company ?? null,
    role: summary?.role ?? null,
    score,
    decision: summary?.final_decision ?? header('Decision') ?? null,
    legitimacy: summary?.legitimacy_tier ?? header('Legitimacy') ?? null,
    risk: summary?.risk_level ?? null,
    nextAction: summary?.next_action ?? null,
  };
}

export const reportFileName = (num, company, date) => `${num}-${slugify(company)}-${date}.md`;

/** Save or update a report. The verbatim JD is appended when the agent left it out. */
export function saveReport(root, relPath, reportText, jobText) {
  let body = reportText.trimEnd();
  if (!/^## Job Description \(archived verbatim\)/m.test(body)) {
    body += `\n\n---\n\n## Job Description (archived verbatim)\n\n${jobText.trim()}`;
  }
  atomicWrite(join(root, relPath), `${body}\n`);
}

export function upsertReportSection(root, relPath, heading, content) {
  const path = join(root, relPath);
  const text = readFileSync(path, 'utf8');
  const section = `${heading}\n\n${content.trim()}\n\n`;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = new RegExp(`^${escaped}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm');
  let next;
  if (existing.test(text)) next = text.replace(existing, () => section);
  else {
    const anchor = text.search(/^## Job Description \(archived verbatim\)/m);
    next = anchor === -1 ? `${text.trimEnd()}\n\n${section}` : `${text.slice(0, anchor)}${section}${text.slice(anchor)}`;
  }
  atomicWrite(path, next);
}

export function setReportHeader(root, relPath, values) {
  const path = join(root, relPath);
  let text = readFileSync(path, 'utf8');
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^\\*\\*${name}:\\*\\*.*$`, 'm');
    if (line.test(text)) text = text.replace(line, () => `**${name}:** ${value}`);
    else text = text.replace(/^(\*\*PDF:\*\*.*)$/m, (whole) => `${whole}\n**${name}:** ${value}`);
  }
  atomicWrite(path, text);
}

export function findTrackerRow(root, reportNum) {
  const tracker = join(root, 'data', 'applications.md');
  if (!existsSync(tracker)) return null;
  const pattern = new RegExp(`\\[0*${Number(reportNum)}\\]\\(`);
  return readFileSync(tracker, 'utf8').split('\n').find((l) => l.startsWith('|') && pattern.test(l)) ?? null;
}

export const countTrackerRows = (root, reportNum) => {
  const tracker = join(root, 'data', 'applications.md');
  if (!existsSync(tracker)) return 0;
  const pattern = new RegExp(`\\[0*${Number(reportNum)}\\]\\(`);
  return readFileSync(tracker, 'utf8').split('\n').filter((l) => l.startsWith('|') && pattern.test(l)).length;
};

/** Add through the ordinary TSV merge. A row already linked to this report is left alone. */
export function mergeIntoTracker(root, row) {
  if (findTrackerRow(root, row.num)) return { merged: false, reason: 'row already present' };
  const dir = join(root, 'batch', 'tracker-additions');
  const cols = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes', 'url'];
  const clean = (v) => String(v ?? '').replace(/[\t\r\n|]+/g, ' ').trim();
  const values = {
    ...row,
    num: Number(row.num),
    status: 'Evaluated',
    score: `${row.score}/5`,
    pdf: row.pdf ? '✅' : '❌',
    report: `[${row.num}](${row.report})`,
  };
  const url = values.url ? clean(values.url) : '';
  const headers = url ? cols : cols.filter((c) => c !== 'url');
  const line = headers.map((c) => (c === 'url' ? url : clean(values[c]))).join('\t');
  atomicWrite(join(dir, `${row.num}-${slugify(row.company)}.tsv`), `${headers.join('\t')}\n${line}\n`);
  const res = node('merge-tracker.mjs', [], root);
  if (res.status !== 0) throw new Error(`merge-tracker failed: ${res.stderr || res.stdout}`);
  return { merged: true, output: res.stdout.trim().slice(0, 500) };
}

export function checkDuplicate(root, { company, role, url }) {
  const args = ['--company', company, '--title', role, '--json'];
  if (url) args.push('--url', url);
  const res = node('precheck-duplicate.mjs', args, root);
  try { return JSON.parse(res.stdout); } catch { return null; }
}

/** Point the tracker's PDF flag at the final document through the existing manifest. */
export async function registerFinalPdf(root, { reportNum, pdf, html, date }) {
  const { applyManifestRow } = await import('../../generate-pdf.mjs');
  const index = join(root, 'data', 'pdf-index.tsv');
  await withPipelineLock(index, () => {
    const lines = existsSync(index) ? readFileSync(index, 'utf8').split(/\r?\n/) : [];
    const header = lines.find((l) => l.startsWith('#')) ?? '# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs, do not edit';
    const kept = applyManifestRow(lines, { reportNum, pdf, html, format: 'a4', date, kind: 'cv' });
    atomicWrite(index, `${[header, ...kept].join('\n')}\n`);
  });
  const res = node('sync-pdf-flags.mjs', [], root);
  if (res.status !== 0) throw new Error(`sync-pdf-flags failed: ${res.stderr || res.stdout}`);
}

export const trackerAdditionsLeft = (root) => {
  const dir = join(root, 'batch', 'tracker-additions');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tsv')) : [];
};
