// The standalone panel and the isolation of its reviewers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, SKILL_ATTRIBUTION, VENDORED_SKILL } from '../../pipeline/lib/config.mjs';
import { REVIEWERS, mergePrompt, reviewerPrompt, runPanel, validateMerged } from '../../pipeline/lib/panel.mjs';
import { createProvider, fixtureProvider } from '../../pipeline/lib/providers.mjs';
import { readJson } from '../../pipeline/lib/util.mjs';
import { JD, MERGED, scripted, verdictFor } from './helpers.mjs';

const RESUME = 'Jordan Example\njordan@example.com\nBackend engineer who builds Python APIs on PostgreSQL.\nBuilt the parcel tracking API for 40 depot staff.\nTwo more lines of plain resume text follow here so the panel has something to read.\n';
const tmp = () => mkdtempSync(join(tmpdir(), 'panel-test-'));

test('the seven reviewers match the vendored skill', () => {
  const skill = readFileSync(VENDORED_SKILL, 'utf8');
  assert.equal(REVIEWERS.length, 7);
  assert.ok(skill.includes('Start five sub-agents at once'));
  for (const phrase of [
    'decides whether a real human should even see this resume',
    'decides whether this person gets an interview',
    'can this person do the job on day one?',
    'where is this resume weaker',
    'what did this person change, and by how much?',
    '30 seconds and 100 resumes today',
    'how they work with others',
  ]) {
    assert.ok(skill.includes(phrase), `skill: ${phrase}`);
    assert.ok(REVIEWERS.some((r) => r.brief.includes(phrase) || r.brief.includes(phrase.replace('this resume weaker', 'this resume weaker'))), `reviewers: ${phrase}`);
  }
});

test('a reviewer prompt holds only its role, the resume and the job', () => {
  for (const reviewer of REVIEWERS) {
    const prompt = reviewerPrompt(reviewer, { resumeText: RESUME, jobText: JD });
    assert.ok(prompt.includes(RESUME));
    assert.ok(prompt.includes(JD));
    assert.doesNotMatch(prompt, /evidence_id|SAMPLE-API-01|claim_restriction|desired verdict/);
    for (const other of REVIEWERS) if (other.id !== reviewer.id) assert.ok(!prompt.includes(other.brief));
  }
});

test('the panel writes the skill\'s two files with attribution, and reviewers cannot see each other', async () => {
  const dir = tmp();
  const seen = {};
  const base = scripted();
  const provider = fixtureProvider(async (prompt, options) => {
    seen[options.step] = { prompt, options };
    return base.provider.complete(prompt, options);
  });
  const result = await runPanel({ resumeText: RESUME, jobText: JD, provider, workDir: dir, name: 'Jordan Example', date: '2026-01-01' });
  assert.ok(result.panelFile.endsWith(join('.hiring-panel', '2026-01-01-jordan-example', 'PANEL.md')));
  for (const f of [result.panelFile, result.improvedFile]) {
    assert.ok(readFileSync(f, 'utf8').trimEnd().endsWith(SKILL_ATTRIBUTION));
  }
  assert.match(readFileSync(result.panelFile, 'utf8'), /does not guarantee an interview/);
  assert.deepEqual(result.addPlaceholders, ['[ADD: revenue figure]']);
  for (const r of REVIEWERS) {
    assert.equal(seen[r.id].options.isolated, true);
    assert.doesNotMatch(seen[r.id].prompt, /"verdict":"(MAYBE|INTERVIEW)"[^|]/, `${r.id} saw another verdict`);
  }
  assert.match(seen.merge.prompt, /Relevant stack/, 'only the merge step sees the verdicts');
});

test('a panel with no job still runs, and says so', async () => {
  const dir = tmp();
  const result = await runPanel({ resumeText: RESUME, provider: scripted().provider, workDir: dir, name: 'general' });
  const panel = readFileSync(result.panelFile, 'utf8');
  assert.match(panel, /Role: none supplied \(assumed general\)/);
  const withRole = await runPanel({ resumeText: RESUME, role: 'Data Engineer', provider: scripted().provider, workDir: tmp(), name: 'role' });
  assert.match(readFileSync(withRole.panelFile, 'utf8'), /Role: Data Engineer/);
});

test('malformed reviewer output is retried, then fails with no substitute', async () => {
  const flaky = scripted({ recruiter: ['no json here', () => JSON.stringify(verdictFor('recruiter'))] });
  await runPanel({ resumeText: RESUME, jobText: JD, provider: flaky.provider, workDir: tmp(), name: 'x' });
  assert.equal(flaky.calls.recruiter, 2);
  const broken = scripted({ recruiter: () => 'never json' });
  await assert.rejects(runPanel({ resumeText: RESUME, jobText: JD, provider: broken.provider, workDir: tmp(), name: 'x' }), /no substitute is used/);
  const badVerdict = scripted({ recruiter: () => JSON.stringify({ verdict: 'GREAT', worst_line: { quote: 'x' } }) });
  await assert.rejects(runPanel({ resumeText: RESUME, jobText: JD, provider: badVerdict.provider, workDir: tmp(), name: 'x' }), /verdict must be one of/);
});

test('merged issues must name real reviewers; a misquote is flagged', () => {
  assert.deepEqual(validateMerged(MERGED, 'Backend engineer who builds Python APIs and Built the parcel tracking API').errors, []);
  assert.match(validateMerged({ issues: [{ id: 1, why: 'x', flagged_by: ['the intern'] }] }, '').errors.join(), /must name reviewers/);
  assert.equal(validateMerged({ issues: [{ id: 1, quote: 'not there', why: 'x', flagged_by: ['ceo'] }] }, 'resume').warnings.length, 1);
  assert.ok(mergePrompt(Object.fromEntries(REVIEWERS.map((r) => [r.id, verdictFor(r.id)])), { resumeText: RESUME }).includes('hiring-manager'));
});

/** A stand-in `claude` that records how it was called, then answers like a reviewer. */
function fakeClaude() {
  const bin = tmp();
  const log = join(bin, 'calls');
  mkdirSync(log);
  const script = `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
const id = process.hrtime.bigint() + '-' + process.pid;
fs.writeFileSync(${JSON.stringify(log)} + '/' + id + '.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.'), input }));
const first = input.split('\\n')[0];
if (first.includes('automated system')) console.log(JSON.stringify({ verdict: 'PASS', reasons: [] }));
else if (first.includes('who decides whether this person gets an interview')) console.log(JSON.stringify({ verdict: 'NO', first_ten_seconds: 'x', would_ask: ['y'], weakest_lines: [{ quote: 'a', why: 'b' }] }));
else if (first.startsWith('Merge these')) console.log(JSON.stringify({ issues: [{ id: 1, quote: 'Backend engineer', why: 'Generic', flagged_by: ['ceo'] }] }));
else if (first.startsWith('Write the improved')) console.log('# Improved resume\\n\\n' + 'Same facts, with the mistakes fixed. '.repeat(10));
else console.log(JSON.stringify({ verdict: 'PASS', worst_line: { quote: 'a', why: 'b' }, problems: ['c', 'd'] }));
`;
  const path = join(bin, 'claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { bin, log };
}

test('the Claude runtime runs each reviewer with no tools, no settings and an empty folder', async () => {
  const { bin, log } = fakeClaude();
  const original = process.env.PATH;
  process.env.PATH = `${bin}:${original}`;
  try {
    const provider = createProvider('claude', { model: 'test-model' });
    const dir = tmp();
    const result = await runPanel({ resumeText: RESUME, jobText: JD, provider, workDir: dir, name: 'iso' });
    const calls = readdirSync(log).map((f) => readJson(join(log, f)));
    assert.equal(calls.length, 10, 'seven reviewers, merge, rebuild, re-screen');
    const cwds = new Set();
    for (const call of calls) {
      const tools = call.args.indexOf('--tools');
      assert.equal(call.args[tools + 1], '', 'no tools');
      assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '', 'no settings');
      assert.ok(call.args.includes('--strict-mcp-config'));
      assert.ok(call.args.includes('--no-session-persistence'));
      assert.deepEqual(call.files, [], 'empty working directory');
      assert.ok(!resolve(call.cwd).startsWith(REPO_ROOT));
      cwds.add(call.cwd);
    }
    assert.equal(cwds.size, 10, 'each call has its own folder');
    assert.equal(result.implementations.ceo.runtime, 'claude -p');
    assert.equal(result.implementations.ceo.model, 'test-model');
    assert.equal(result.implementations.ceo.isolated, true);
    assert.match(readFileSync(result.panelFile, 'utf8'), /Reviewer implementation: claude -p \(model: test-model\)/);
  } finally {
    process.env.PATH = original;
  }
});

test('standalone CLI: a text resume with a job writes the two files, using the Claude runtime', () => {
  const { bin } = fakeClaude();
  const cwd = tmp();
  writeFileSync(join(cwd, 'resume.md'), RESUME);
  writeFileSync(join(cwd, 'job.md'), JD);
  const res = spawnSync(process.execPath, [join(REPO_ROOT, 'pipeline/cli.mjs'), 'panel', '--resume', 'resume.md', '--job', 'job.md', '--name', 'Solo'], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Automated screen: PASS before, PASS after/);
  assert.match(res.stdout, /Reviewer implementation: claude -p/);
  const out = readdirSync(join(cwd, '.hiring-panel')).find((d) => d.endsWith('-solo') && !d.startsWith('.'));
  assert.ok(existsSync(join(cwd, '.hiring-panel', out, 'PANEL.md')));
  assert.ok(existsSync(join(cwd, '.hiring-panel', out, 'RESUME-IMPROVED.md')));
});

test('standalone CLI: host mode lists the prompts rather than pretending to review', () => {
  const cwd = tmp();
  writeFileSync(join(cwd, 'resume.md'), RESUME);
  const res = spawnSync(process.execPath, [join(REPO_ROOT, 'pipeline/cli.mjs'), 'panel', '--resume', 'resume.md', '--role', 'Analyst', '--provider', 'host', '--out', join(cwd, 'w')], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Give each agent ONLY its prompt file/);
  assert.equal((res.stdout.match(/prompt: /g) || []).length, 7);
  assert.ok(!existsSync(join(cwd, 'w', '.hiring-panel')));
});

test('setup --from copies the user layer without overwriting anything or changing the source', () => {
  const source = tmp();
  const target = tmp();
  writeFileSync(join(source, 'AGENTS.md'), 'marker');
  writeFileSync(join(source, 'cv.md'), 'source cv');
  mkdirSync(join(source, 'data', 'resume-template'), { recursive: true });
  mkdirSync(join(source, 'data', 'application-runs', 'old'), { recursive: true });
  writeFileSync(join(source, 'data', 'applications.md'), 'source tracker');
  writeFileSync(join(source, 'data', 'resume-template', 'approved.tex'), 'template');
  writeFileSync(join(source, 'data', 'application-runs', 'old', 'manifest.json'), '{}');
  mkdirSync(join(target, 'data'));
  writeFileSync(join(target, 'data', 'applications.md'), 'target tracker');
  const res = spawnSync(process.execPath, [join(REPO_ROOT, 'pipeline/cli.mjs'), 'setup', '--from', source], {
    cwd: target, encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: target },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(target, 'cv.md'), 'utf8'), 'source cv');
  assert.equal(readFileSync(join(target, 'data', 'resume-template', 'approved.tex'), 'utf8'), 'template');
  assert.equal(readFileSync(join(target, 'data', 'applications.md'), 'utf8'), 'target tracker');
  assert.ok(!existsSync(join(target, 'data', 'application-runs')));
  assert.equal(readFileSync(join(source, 'data', 'applications.md'), 'utf8'), 'source tracker');
});
