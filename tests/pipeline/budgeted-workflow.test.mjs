import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { recordAnswer, workflowTier } from '../../pipeline/lib/engine.mjs';
import { removeLowestRanked } from '../../pipeline/lib/fit.mjs';
import { hasCommand } from '../../pipeline/lib/util.mjs';
import { again, offlineDeps, payload, report, sandbox, scripted, start } from './helpers.mjs';

const tools = ['tectonic', 'pdftotext', 'pdftoppm', 'pdfinfo', 'pdffonts'].every(hasCommand);
const test = tools ? nodeTest : nodeTest.skip;
const decisions = (prompt) => {
  const file = prompt.match(/Merged issues: ([^\n]+)/)?.[1];
  const issues = JSON.parse(readFileSync(file, 'utf8')).issues;
  return {
    decisions: issues.map((x) => ({ issue_id: x.id, status: 'rejected', reason: 'No new supported claim', action: '', evidence_ids: [] })),
    add_placeholders: [], questions_for_candidate: [],
  };
};

nodeTest('score boundaries are exact', () => {
  assert.equal(workflowTier(2.99), 'lean');
  assert.equal(workflowTier(3), 'focused');
  assert.equal(workflowTier(4), 'full');
});

nodeTest('fitting removes complete lowest-ranked bullets and keeps evidence aligned', () => {
  const bank = payload();
  bank.projects[0].bullets.push('A lower-ranked supported route change.');
  bank.projects[0].evidence_ids.push(['ROUTE-UI-01']);
  const removed = removeLowestRanked(bank);
  assert.equal(removed.section, 'projects');
  assert.equal(bank.projects[0].bullets.length, 1);
  assert.deepEqual(bank.projects[0].evidence_ids, [['ROUTE-UI-01']]);
  assert.equal(removeLowestRanked(bank).section, 'experience');
  assert.equal(bank.experience[0].bullets.length, bank.experience[0].evidence_ids.length);
});

test('below 3 produces resume and letter in four model calls without panel or tracker write', async () => {
  const box = sandbox();
  const script = scripted({ evaluate: () => report({ score: 2.4, decision: 'Skip' }) });
  const { runDir, manifest } = await start(box, script);
  assert.equal(manifest.status, 'complete', manifest.error?.message);
  assert.equal(manifest.workflow.tier, 'lean');
  assert.deepEqual(Object.keys(script.calls).sort(), ['draft_letter', 'draft_resume', 'evaluate', 'selection']);
  assert.equal(manifest.usage.calls.length, 4);
  assert.equal(manifest.stages.panel.status, 'skipped');
  assert.equal(manifest.stages.draft_review.status, 'skipped');
  assert.equal(manifest.stages.final_screen.status, 'skipped');
  assert.equal(manifest.report.path, 'evaluation/brief.md');
  assert.ok(existsSync(join(runDir, manifest.final.resume_pdf)));
  assert.ok(existsSync(join(runDir, manifest.final.letter_pdf)));
  assert.equal(readFileSync(join(box.root, 'data/applications.md'), 'utf8').split('\n').filter((x) => /^\| \d/.test(x)).length, 0);
});

test('scores 3 to under 4 use three reviewers once, then one revision', async () => {
  const script = scripted({ evaluate: () => report({ score: 3.4 }), triage: decisions });
  const { manifest } = await start(sandbox(), script);
  assert.equal(manifest.status, 'complete', manifest.error?.message);
  assert.equal(manifest.workflow.tier, 'focused');
  assert.deepEqual(Object.keys(manifest.panel.reviewers).sort(), ['automated-screen', 'hiring-manager', 'recruiter']);
  assert.equal(script.calls.final_resume, 1);
  assert.equal(script.calls['final-screen'], undefined);
  assert.equal(script.calls.final_review, undefined);
  assert.equal(script.calls.final_letter, 1);
});

test('scores 4 and above use seven reviewers once and no final screen', async () => {
  const script = scripted({ triage: decisions });
  const { manifest } = await start(sandbox(), script);
  assert.equal(manifest.status, 'complete', manifest.error?.message);
  assert.equal(manifest.workflow.tier, 'full');
  assert.equal(Object.keys(manifest.panel.reviewers).length, 7);
  assert.equal(script.calls.merge, undefined);
  assert.equal(script.calls.rebuild, undefined);
  assert.equal(script.calls.rescreen, undefined);
  assert.equal(script.calls['final-screen'], undefined);
  assert.equal(script.calls.final_resume, 1);
});

test('a bad low-score payload stops without paying for another draft', async () => {
  const script = scripted({ evaluate: () => report({ score: 2 }), draft_resume: () => ({ status: 'needs_user_input' }) });
  const { manifest } = await start(sandbox(), script);
  assert.equal(manifest.status, 'failed');
  assert.equal(script.calls.draft_resume, 1);
  assert.equal(script.calls.draft_letter, undefined);
  assert.equal(manifest.final, undefined);
});

test('closed posting stops before any model call or tracker write', async () => {
  const box = sandbox();
  const script = scripted();
  const { manifest } = await start(box, script, { jobText: null, url: 'https://jobs.ashbyhq.com/example/closed', deps: offlineDeps({ liveness: () => ({ verdict: 'expired', detail: 'closed' }) }) });
  assert.equal(manifest.status, 'stopped');
  assert.deepEqual(script.calls, {});
  assert.equal(readFileSync(join(box.root, 'data/applications.md'), 'utf8').split('\n').filter((x) => /^\| \d/.test(x)).length, 0);
});

test('blacklist requires the candidate answer before scoring', async () => {
  const box = sandbox();
  writeFileSync(join(box.root, 'data/blacklist.md'), '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Example Freight | 2025-01-01 | company | Bad experience |\n');
  const script = scripted({ evaluate: () => report({ score: 2.2 }) });
  const { runDir, manifest } = await start(box, script);
  assert.equal(manifest.status, 'awaiting_user');
  assert.equal(script.calls.evaluate, undefined);
  recordAnswer(runDir, { text: 'evaluate anyway' });
  assert.equal((await again(box, script, runDir)).status, 'complete');
});

test('pinned evidence copy survives later database edits', async () => {
  const box = sandbox();
  const script = scripted({ evaluate: () => report({ score: 2.5 }) });
  const { runDir, manifest } = await start(box, script);
  assert.equal(manifest.status, 'complete', manifest.error?.message);
  const snapshot = readFileSync(join(runDir, 'inputs/evidence-database.json'), 'utf8');
  writeFileSync(box.cfg.databasePath, '{}');
  assert.equal(readFileSync(join(runDir, 'inputs/evidence-database.json'), 'utf8'), snapshot);
});
