// Evidence database access and the deterministic fact gates.
//
// These gates catch what software can catch: unknown or uncleared IDs, wrong
// parents, untraceable numbers, unsupported skills, wrong dates, placeholders.
// They cannot prove a paraphrase is fair, so a review stage must still read
// every claim against its records. Nothing here says otherwise in its output.
import { readFileSync } from 'node:fs';
import { sha256, squash } from './util.mjs';

export function loadDatabase(path) {
  const text = readFileSync(path, 'utf8');
  const raw = JSON.parse(text);
  for (const key of ['experiences', 'projects', 'evidence', 'skills']) {
    if (!Array.isArray(raw[key])) throw new Error(`Evidence database is missing the "${key}" list`);
  }
  return {
    raw,
    path,
    sha256: sha256(text),
    evidenceById: new Map(raw.evidence.map((e) => [e.evidence_id, e])),
    parentsById: new Map([
      ...raw.experiences.map((p) => [p.experience_id, p]),
      ...raw.projects.map((p) => [p.project_id, p]),
    ]),
  };
}

export function isCleared(record) {
  return Boolean(record.verified_by_user)
    && !record.sensitive
    && !/^do not (use|claim)/i.test(String(record.claim_restriction ?? ''));
}

const STOP = new Set('about after across also and are as based be been before between business can company development each ensure experience for from have including into its job looking maintain more must needs our role should skills strong support team than that the their them these this through under users with work working you your'.split(' '));
const words = (s) => (String(s).toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) || []).filter((w) => !STOP.has(w));

/** Lexical retrieval aid. The drafting agent makes the actual selection. */
export function shortlistEvidence(db, jobText, limit = 30) {
  const query = new Set(words(jobText));
  return db.raw.evidence
    .filter(isCleared)
    .map((e) => {
      const parent = db.parentsById.get(e.parent_id);
      const searchable = [e.raw_fact, e.context, e.action, e.result, e.technologies, e.competencies, e.role_tags, parent?.summary].join(' ');
      const hits = [...new Set(words(searchable))].filter((w) => query.has(w));
      return { id: e.evidence_id, parent: e.parent_id, score: hits.length, hits, fact: e.raw_fact, action: e.action, result: e.result, metric: e.metric, restriction: e.claim_restriction };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

const normalizeNumbers = (s) => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1');

/** Numbers as written, keeping a percent sign: "40%" is a different claim from "40 staff". */
export const numbersIn = (s) => (normalizeNumbers(s).match(/\d+(?:\.\d+)?(?:\s?(?:%|percent\b))?/g) || [])
  .map((n) => n.replace(/\s?(?:%|percent)$/, '%'));

/** Whole-number match, so "5" is not treated as supported by "95" or "5.5". */
export function numberIsIn(number, source) {
  const percent = number.endsWith('%');
  const escaped = number.replace('%', '').replace('.', '\\.');
  const unit = percent ? '\\s?(?:%|percent\\b)' : '(?![\\d]|\\.\\d)';
  return new RegExp(`(?<![\\d.])${escaped}${unit}`).test(normalizeNumbers(source));
}

export const evidenceText = (r) => [r.raw_fact, r.context, r.action, r.result, r.metric, r.technologies, r.notes].join(' ');
export const plain = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

const PLACEHOLDER = /\[ADD:|\[TODO|\{\{|\bTBD\b/;

function checkShared(text, where, cfg, errors) {
  if (PLACEHOLDER.test(text)) errors.push(`${where}: contains a placeholder`);
  for (const bad of cfg.forbiddenOutput) {
    if (text.includes(bad)) errors.push(`${where}: contains "${bad}", which the verified overrides replace`);
  }
}

function resolveIds(ids, parentId, where, db, errors) {
  if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string')) {
    errors.push(`${where}: evidence_ids must be a non-empty list of IDs`);
    return [];
  }
  const records = [];
  for (const id of ids) {
    const record = db.evidenceById.get(id);
    if (!record) { errors.push(`${where}: unknown evidence ID ${id}`); continue; }
    if (parentId && record.parent_id !== parentId) {
      errors.push(`${where}: ${id} belongs to ${record.parent_id}, not ${parentId}`);
      continue;
    }
    if (!isCleared(record)) {
      errors.push(`${where}: ${id} is not cleared for use (${record.claim_restriction})`);
      continue;
    }
    records.push(record);
  }
  return records;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function parseDateRange(text) {
  const parts = String(text).split(/\s*(?:--|–|—|-|to)\s*/);
  const one = (p) => {
    if (/present|current/i.test(p)) return 'present';
    const m = p.match(/([a-z]{3,4})[a-z]*\.?\s+(\d{4})/i);
    if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`;
    const y = p.match(/\b(\d{4})\b/);
    return y ? y[1] : null;
  };
  return parts.length >= 2 ? [one(parts[0]), one(parts[parts.length - 1])] : [one(parts[0]), null];
}

function datesAgree(written, parent) {
  const [start, end] = parseDateRange(written);
  const same = (a, b) => {
    if (!a || !b) return false;
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    return x === y || x.startsWith(y) || y.startsWith(x);
  };
  return same(start, parent.start) && same(end, parent.end);
}

/** A skill counts as supported if the database lists it or a cited record names it. */
export function skillSupported(item, corpus) {
  const name = plain(item).replace(/\(.*?\)/g, '').trim();
  if (!name) return true;
  const hit = (term) => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9+#])${escaped}(?![a-z0-9+#])`, 'i').test(corpus);
  };
  return hit(name) || name.split(/\s*\/\s*/).every(hit);
}

export const splitSkillItems = (items) => {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of String(items)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(current); current = ''; } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
};

export function skillCorpus(db) {
  return [
    ...db.raw.skills.map((s) => s.skill),
    ...db.raw.experiences.map((p) => p.technologies),
    ...db.raw.projects.map((p) => p.technologies),
    ...db.raw.evidence.filter(isCleared).flatMap((e) => [e.technologies, e.competencies]),
  ].join(' ; ').toLowerCase();
}

/**
 * Validate a tailored resume payload against the database.
 * Returns errors (block the build), warnings, and a per-claim audit.
 */
export function validatePayload(payload, db, cfg) {
  const errors = [];
  const warnings = [];
  const audit = [];

  for (const key of ['summary', 'skills', 'experience', 'projects']) {
    if (!payload?.[key]?.length) errors.push(`Missing resume section: ${key}`);
  }
  if (errors.length) return { errors, warnings, audit };

  const checkEntry = (entry, kind) => {
    const label = kind === 'experience' ? entry.company : entry.name;
    const parent = db.parentsById.get(entry.source_id);
    if (!parent) { errors.push(`${label}: unknown database source_id ${entry.source_id}`); return; }
    if (kind === 'experience') {
      if (!parent.experience_id) errors.push(`${label}: ${entry.source_id} is a project, not an experience`);
      const org = String(parent.organisation ?? '').toLowerCase();
      const role = String(parent.role ?? '').toLowerCase();
      if (!org.includes(String(entry.company).toLowerCase()) || !role.includes(String(entry.role).toLowerCase())) {
        errors.push(`${label}: company or title differs from database parent ${entry.source_id}`);
      }
      if (parent.start && !datesAgree(entry.dates, parent)) {
        errors.push(`${label}: dates "${entry.dates}" differ from database ${parent.start} to ${parent.end}`);
      }
    }
    if (entry.description) errors.push(`${label}: description would collapse separate bullets`);
    if (!Array.isArray(entry.bullets) || !entry.bullets.length || !Array.isArray(entry.evidence_ids) || entry.evidence_ids.length !== entry.bullets.length) {
      errors.push(`${label}: provide distinct bullets and one evidence_ids list per bullet`);
      return;
    }
    entry.bullets.forEach((bullet, i) => {
      const where = `${label} bullet ${i + 1}`;
      const written = plain(bullet);
      if ((String(bullet).match(/\*\*/g) || []).length % 2) errors.push(`${where}: unbalanced ** bold markers`);
      const records = resolveIds(entry.evidence_ids[i], entry.source_id, where, db, errors);
      if (written.length < cfg.min_bullet_chars) {
        errors.push(`${where}: ${written.length} characters; add source-backed method and outcome detail (minimum ${cfg.min_bullet_chars})`);
      }
      checkShared(written, where, cfg, errors);
      const source = records.map(evidenceText).join(' ');
      for (const number of numbersIn(written)) {
        if (!numberIsIn(number, source)) errors.push(`${where}: number ${number} is absent from selected evidence`);
      }
      audit.push({
        section: label,
        source_id: entry.source_id,
        bullet: i + 1,
        evidence_ids: entry.evidence_ids[i],
        restrictions: records.map((r) => r.claim_restriction),
        text: written,
      });
    });
  };
  payload.experience.forEach((e) => checkEntry(e, 'experience'));
  payload.projects.forEach((p) => checkEntry(p, 'project'));

  // Summary: every number must trace to the IDs it cites.
  const summary = plain(payload.summary);
  checkShared(summary, 'Summary', cfg, errors);
  const summaryRecords = resolveIds(payload.summary_evidence_ids, null, 'Summary', db, errors);
  const summarySource = summaryRecords.map(evidenceText).join(' ');
  for (const number of numbersIn(summary)) {
    if (!numberIsIn(number, summarySource)) errors.push(`Summary: number ${number} is absent from summary_evidence_ids`);
  }
  audit.push({ section: 'Summary', evidence_ids: payload.summary_evidence_ids, restrictions: summaryRecords.map((r) => r.claim_restriction), text: summary });

  // Skills: listed in the database, or explicitly mapped to cleared evidence.
  const corpus = skillCorpus(db);
  const mapping = payload.skills_evidence ?? {};
  for (const group of payload.skills) {
    for (const item of splitSkillItems(group.items)) {
      checkShared(item, `Skills (${group.category})`, cfg, errors);
      if (skillSupported(item, corpus)) continue;
      if (mapping[item]) {
        resolveIds(mapping[item], null, `Skill "${item}"`, db, errors);
        continue;
      }
      errors.push(`Skill "${item}" is not in the database; remove it or map it in skills_evidence to cleared records`);
    }
  }

  if (payload.candidate?.title) checkShared(payload.candidate.title, 'Title', cfg, errors);
  const seen = new Set();
  for (const a of audit) {
    const key = squash(a.text);
    if (seen.has(key)) errors.push(`${a.section}: duplicated claim "${a.text.slice(0, 60)}..."`);
    seen.add(key);
  }
  return { errors, warnings, audit };
}

/** Validate the requirement-to-evidence selection the drafting agent records. */
export function validateSelection(selection, db, jobText) {
  const errors = [];
  if (!Array.isArray(selection?.requirements) || !selection.requirements.length) {
    return ['selection.requirements must list the role requirements considered'];
  }
  const job = squash(jobText);
  selection.requirements.forEach((req, i) => {
    const where = `Requirement ${i + 1}`;
    if (!req.requirement) errors.push(`${where}: missing requirement text`);
    if (!req.jd_quote || !job.includes(squash(req.jd_quote))) {
      errors.push(`${where}: jd_quote must be copied from the job description`);
    }
    if (!['direct', 'narrow', 'gap'].includes(req.strength)) errors.push(`${where}: strength must be direct, narrow or gap`);
    if (req.strength === 'gap') {
      if ((req.evidence_ids ?? []).length) errors.push(`${where}: a gap cannot cite evidence`);
    } else {
      resolveIds(req.evidence_ids, null, where, db, errors);
    }
  });
  if (!Array.isArray(selection.selected_parents) || !selection.selected_parents.length) {
    errors.push('selection.selected_parents must name the chosen experience and project records');
  } else {
    for (const id of selection.selected_parents) {
      if (!db.parentsById.has(id)) errors.push(`selected_parents: unknown record ${id}`);
    }
  }
  if (!Array.isArray(selection.omitted)) errors.push('selection.omitted must explain plausible records left out');
  else {
    for (const item of selection.omitted) {
      if (!item.id || !item.reason) errors.push('selection.omitted entries need id and reason');
      else if (!db.parentsById.has(item.id) && !db.evidenceById.has(item.id)) errors.push(`omitted: unknown record ${item.id}`);
    }
  }
  if (!Array.isArray(selection.gaps)) errors.push('selection.gaps must be a list (empty when there are none)');
  return errors;
}

export const payloadEvidenceIds = (payload) => [
  ...new Set([...(payload.experience ?? []), ...(payload.projects ?? [])].flatMap((e) => (e.evidence_ids ?? []).flat())),
];

/** Conflicts the user has not resolved. Surfaced in every drafting task. */
export const openConflicts = (db) => (db.raw.conflicts ?? []).filter((c) => /restrict|unresolved/i.test(c.status));
