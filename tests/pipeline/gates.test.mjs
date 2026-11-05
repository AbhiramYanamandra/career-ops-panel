// Fact gates: what software can and must refuse on its own.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkLetterConsistency, letterMarkdown, renderLetterTex, renderResumeTex, texEscape, validateLetter } from '../../pipeline/lib/documents.mjs';
import { loadDatabase, numberIsIn, numbersIn, skillSupported, skillCorpus, validatePayload, validateSelection } from '../../pipeline/lib/evidence.mjs';
import { extractJson, formatLetterDate } from '../../pipeline/lib/util.mjs';

test('cover-letter dates use day month year in editable text and PDF source', () => {
  const { cfg } = setup();
  const longDateCfg = { ...cfg, letterDateFormat: 'day-month-year' };
  const draft = { ...letter(), date: '2026-11-04' };
  assert.equal(formatLetterDate('2026-11-04', 'day-month-year'), '4 November 2026');
  assert.match(letterMarkdown(draft, longDateCfg), /^4 November 2026\n/);
  assert.match(renderLetterTex(draft, longDateCfg, 'Engineer'), /\\par 4 November 2026/);
  assert.match(renderLetterTex(draft, cfg, 'Engineer'), /\\par 2026-11-04/);
  assert.throws(() => formatLetterDate('2026-02-31', 'day-month-year'), /Invalid cover-letter date/);
});
import { JD, bullets, letter, payload, sandbox } from './helpers.mjs';

const setup = () => {
  const { root, cfg } = sandbox();
  return { root, cfg, db: loadDatabase(cfg.databasePath) };
};

test('numbers match as whole values, so "5" is not supported by "95" or "5.5"', () => {
  assert.equal(numberIsIn('5', 'reduced by 95%'), false);
  assert.equal(numberIsIn('5', 'a 5.5 ms figure'), false);
  assert.equal(numberIsIn('5', 'team of 5 engineers'), true);
  assert.equal(numberIsIn('50000', 'all 50,000 images'), true);
});

test('a percentage needs a percentage: "40%" is not supported by "40 depot staff"', () => {
  assert.deepEqual(numbersIn('up 40% and 12 percent, for 3 teams'), ['40%', '12%', '3']);
  assert.equal(numberIsIn('40%', 'for 40 depot staff'), false);
  assert.equal(numberIsIn('40%', 'reduced by 40 percent'), true);
  assert.equal(numberIsIn('95.5%', 'reducing error by 95.5%'), true);
});

test('a clean payload passes and every bullet is recorded with its evidence and restrictions', () => {
  const { db, cfg } = setup();
  const { errors, audit } = validatePayload(payload(), db, cfg);
  assert.deepEqual(errors, []);
  const ci = audit.find((a) => a.evidence_ids?.includes('SAMPLE-CI-01'));
  assert.deepEqual(ci.restrictions, ['Use as team result']);
});

test('an unsupported metric is refused', () => {
  const { db, cfg } = setup();
  const p = payload();
  p.experience[0].bullets[0] = bullets.api.replace('120 ms', '99 ms');
  assert.match(validatePayload(p, db, cfg).errors.join(), /number 99 is absent/);
});

test('evidence restricted by claim_restriction cannot be cited', () => {
  const { db, cfg } = setup();
  const p = payload();
  p.experience[0].evidence_ids[0] = ['SAMPLE-RAW-01'];
  assert.match(validatePayload(p, db, cfg).errors.join(), /SAMPLE-RAW-01 is not cleared/);
});

test('missing or misattributed evidence is refused', () => {
  const { db, cfg } = setup();
  const unknown = payload();
  unknown.experience[0].evidence_ids[0] = ['NOPE-01'];
  assert.match(validatePayload(unknown, db, cfg).errors.join(), /unknown evidence ID NOPE-01/);
  const wrongParent = payload();
  wrongParent.experience[0].evidence_ids[0] = ['ROUTE-UI-01'];
  assert.match(validatePayload(wrongParent, db, cfg).errors.join(), /belongs to PRJ-ROUTE, not EXP-SAMPLE/);
  const unknownParent = payload();
  unknownParent.projects[0].source_id = 'PRJ-NOPE';
  assert.match(validatePayload(unknownParent, db, cfg).errors.join(), /unknown database source_id/);
});

test('titles and dates must agree with the database parent', () => {
  const { db, cfg } = setup();
  const title = payload();
  title.experience[0].role = 'Principal Engineer';
  assert.match(validatePayload(title, db, cfg).errors.join(), /company or title differs/);
  const dates = payload();
  dates.experience[0].dates = 'Jan. 2021 -- Present';
  assert.match(validatePayload(dates, db, cfg).errors.join(), /differ from database/);
});

test('a skill the database does not support is refused unless mapped to cleared evidence', () => {
  const { db, cfg } = setup();
  const p = payload({ skills: [{ category: 'Cloud', items: 'Kubernetes' }] });
  assert.match(validatePayload(p, db, cfg).errors.join(), /Skill "Kubernetes" is not in the database/);
  const mapped = payload({ skills: [{ category: 'Cloud', items: 'Container delivery' }], skills_evidence: { 'Container delivery': ['SAMPLE-CI-01'] } });
  assert.deepEqual(validatePayload(mapped, db, cfg).errors, []);
  assert.equal(skillSupported('C', skillCorpus(db)), false);
  assert.equal(skillSupported('PostgreSQL (indexes)', skillCorpus(db)), true);
});

test('short generic bullets, collapsed descriptions and placeholders are refused', () => {
  const { db, cfg } = setup();
  const short = payload();
  short.experience[0].bullets[0] = 'Built an API.';
  assert.match(validatePayload(short, db, cfg).errors.join(), /add source-backed method/);
  const collapsed = payload();
  collapsed.projects[0].description = 'merged text';
  assert.match(validatePayload(collapsed, db, cfg).errors.join(), /collapse separate bullets/);
  const placeholder = payload();
  placeholder.summary = 'Backend engineer with [ADD: years] of experience.';
  assert.match(validatePayload(placeholder, db, cfg).errors.join(), /placeholder/);
});

test('the summary needs evidence and its numbers must trace', () => {
  const { db, cfg } = setup();
  const noIds = payload({ summary_evidence_ids: [] });
  assert.match(validatePayload(noIds, db, cfg).errors.join(), /Summary: evidence_ids must be/);
  const badNumber = payload({ summary: 'Engineer serving 400 depot staff.' });
  assert.match(validatePayload(badNumber, db, cfg).errors.join(), /Summary: number 400/);
});

test('verified overrides replace template values and old values cannot be written back', () => {
  const { db, cfg } = setup();
  const tex = renderResumeTex(payload(), cfg);
  assert.match(tex, /GPA: 3\.4/);
  assert.doesNotMatch(tex, /GPA: 3\.1/);
  const stale = payload({ summary: 'Backend engineer, GPA: 2.9, who builds Python APIs for 40 depot staff.' });
  assert.match(validatePayload(stale, db, cfg).errors.join(), /verified overrides replace/);
  const missing = { ...cfg, overrides: {} };
  assert.throws(() => renderResumeTex(payload(), missing), /Override "gpa" is not defined/);
});

test('the approved template is rendered, not modified', () => {
  const { cfg } = setup();
  const tex = renderResumeTex(payload(), cfg);
  const master = readFileSync(cfg.templatePath, 'utf8');
  const preamble = master.slice(0, master.indexOf('\\begin{document}'));
  assert.ok(tex.startsWith(preamble));
  assert.match(tex, /top=19\.4pt,bottom=0pt,left=36pt,right=36pt/);
  assert.match(tex, /\\documentclass\[a4paper,9pt\]/);
});

test('a template that lost its anchors stops the render', () => {
  const { cfg } = setup();
  writeFileSync(cfg.templatePath, readFileSync(cfg.templatePath, 'utf8').replace('Example Tagline', 'Other'));
  assert.throws(() => renderResumeTex(payload(), cfg), /tagline anchor is missing/);
});

test('LaTeX specials and typographic quotes are escaped correctly', () => {
  assert.equal(texEscape('50% & C#'), '50\\% \\& C\\#');
  assert.equal(texEscape('“quoted”'), "``quoted''");
  assert.equal(texEscape('a_b'), 'a\\_b');
});

test('a selection must quote the job, cite cleared records, and record gaps honestly', () => {
  const { db } = setup();
  const base = { selected_parents: ['EXP-SAMPLE'], omitted: [], gaps: [] };
  assert.match(validateSelection({ ...base, requirements: [{ requirement: 'x', jd_quote: 'not in the posting at all', evidence_ids: ['SAMPLE-API-01'], strength: 'direct' }] }, db, JD).join(), /copied from the job description/);
  assert.match(validateSelection({ ...base, requirements: [{ requirement: 'x', jd_quote: 'Kubernetes experience is a plus', evidence_ids: ['SAMPLE-CI-01'], strength: 'gap' }] }, db, JD).join(), /a gap cannot cite evidence/);
  assert.match(validateSelection({ ...base, requirements: [{ requirement: 'x', jd_quote: 'Kubernetes experience is a plus', evidence_ids: ['SAMPLE-RAW-01'], strength: 'direct' }] }, db, JD).join(), /not cleared/);
  assert.deepEqual(validateSelection({ ...base, requirements: [{ requirement: 'x', jd_quote: 'Kubernetes experience is a plus', evidence_ids: [], strength: 'gap' }] }, db, JD), []);
});

test('letter claims trace to evidence and company claims to the job description', () => {
  const { db, cfg } = setup();
  const job = { company: 'Example Freight', role: 'Backend Engineer' };
  assert.deepEqual(validateLetter(letter(), db, cfg, JD, job), []);
  const invented = letter();
  invented.paragraphs[1].text = invented.paragraphs[1].text.replace('40 depot', '400 depot');
  assert.match(validateLetter(invented, db, cfg, JD, job).join(), /number 400 does not trace/);
  const fakeQuote = letter();
  fakeQuote.paragraphs[0].employer_quotes = ['Winner of the 2025 best workplace award'];
  assert.match(validateLetter(fakeQuote, db, cfg, JD, job).join(), /not in the job description/);
  const unsourced = letter();
  delete unsourced.paragraphs[1].evidence_ids;
  assert.match(validateLetter(unsourced, db, cfg, JD, job).join(), /cite evidence_ids/);
  const thin = { ...letter(), paragraphs: letter().paragraphs.map((p) => ({ ...p, text: p.text.slice(0, 80) })) };
  assert.match(validateLetter(thin, db, cfg, JD, job).join(), /needs at least 180/);
  const generic = letter();
  generic.subject = 'Application';
  generic.paragraphs[0].text = generic.paragraphs[0].text.replace('at Example Freight', 'at your company');
  assert.match(validateLetter(generic, db, cfg, JD, job).join(), /never names the company/);
});

test('the final letter must agree with the final resume', () => {
  const { db } = setup();
  const resume = 'Sample Logistics Python PostgreSQL 40 depot staff 900 ms 120 ms team of 5 Docker';
  const p = payload();
  assert.deepEqual(checkLetterConsistency(letter(), resume, p, db).errors, []);
  const tool = letter();
  tool.paragraphs[2].text += ' I have also used TypeScript heavily.';
  assert.match(checkLetterConsistency(tool, resume, p, db).errors.join(), /names "TypeScript"/);
  const number = letter();
  number.paragraphs[2].text += ' I worked there for 7 years.';
  assert.match(checkLetterConsistency(number, resume, p, db).errors.join(), /number 7/);
  const date = letter();
  date.paragraphs[2].text += ' I started in Mar. 2019.';
  assert.match(checkLetterConsistency(date, resume, p, db).errors.join(), /date "Mar\. 2019"/);
  assert.ok(checkLetterConsistency(letter(), resume, { experience: [], projects: [] }, db).warnings.length > 0);
});

test('model output parsing accepts a fenced object and refuses prose', () => {
  assert.deepEqual(extractJson('Here it is:\n```json\n{"a":1}\n```\nDone.'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson('I could not do that.'), /parseable JSON/);
});

test('no machine-specific path is hardcoded in product code', () => {
  const files = ['lib/config.mjs', 'lib/engine.mjs', 'lib/tasks.mjs', 'lib/documents.mjs', 'lib/evidence.mjs', 'lib/panel.mjs', 'lib/providers.mjs', 'lib/careerops.mjs', 'cli.mjs'];
  for (const f of files) {
    const text = readFileSync(join(import.meta.dirname, '..', '..', 'pipeline', f), 'utf8');
    assert.doesNotMatch(text, /\/Users\/|\/home\//, f);
  }
});
