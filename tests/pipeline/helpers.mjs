// Sandboxes and a scripted stand-in for model work. Tests exercise the real
// engine, real gates, real career-ops scripts and real LaTeX builds.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProfilePath } from '../../path-resolver.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { advance, createRun } from '../../pipeline/lib/engine.mjs';
import { REVIEWERS } from '../../pipeline/lib/panel.mjs';
import { fixtureProvider } from '../../pipeline/lib/providers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE = join(here, '..', '..', 'pipeline', 'examples');
export const JD = readFileSync(join(EXAMPLE, 'job-description.md'), 'utf8');

export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
  cpSync(join(EXAMPLE, 'resume-template'), join(root, 'data', 'resume-template'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(getProfilePath(root), 'candidate:\n  full_name: Jordan Example\ncompensation:\n  currency: USD\n');
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  process.env.CAREER_OPS_ROOT = root;
  delete process.env.CAREER_OPS_EVIDENCE_DB;
  return { root, cfg: loadConfig(root) };
}

export const report = ({ score = 4.2, decision = 'Apply', company = 'Example Freight', role = 'Backend Engineer' } = {}) => `# Evaluation: ${company} — ${role}

**Date:** 2026-01-01
**URL:** —
**Score:** ${score}/5
**Decision:** ${decision}
**Legitimacy:** High Confidence
**PDF:** pending

---

## Machine Summary

\`\`\`yaml
company: "${company}"
role: "${role}"
score: ${score}
final_decision: "${decision}"
legitimacy_tier: "High Confidence"
next_action: "Review"
\`\`\`

## A) Role Summary
Backend role.

## B) Match with CV
Good match.

## G) Posting Legitimacy
Credible.
`;

export const bullets = {
  api: 'Built the parcel tracking **API** in Python and PostgreSQL for 40 depot staff, designing endpoints and database indexes that cut lookup time from **900 ms to 120 ms**.',
  ci: 'Contributed to a team of 5 engineers migrating deployments to Docker with a shared CI pipeline, writing the Dockerfiles and test stage so the team shipped without manual server steps.',
  route: 'Built a React and TypeScript route editor with drag-and-drop stops and a nearest-neighbour solver that recalculates a 50 stop route as stops are dragged, keeping planning interactive.',
};

export const payload = (changes = {}) => ({
  candidate: { title: 'Backend Engineer | Python and PostgreSQL' },
  summary: 'Backend engineer who builds Python APIs on PostgreSQL, with a tracking API serving 40 depot staff.',
  summary_evidence_ids: ['SAMPLE-API-01'],
  skills: [{ category: 'Programming', items: 'Python, TypeScript, PostgreSQL' }],
  experience: [{
    source_id: 'EXP-SAMPLE', role: 'Software Engineer', company: 'Sample Logistics', location: 'Example City', dates: 'Feb. 2024 -- Present',
    bullets: [bullets.api, bullets.ci], evidence_ids: [['SAMPLE-API-01'], ['SAMPLE-CI-01']],
  }],
  projects: [{ source_id: 'PRJ-ROUTE', name: 'Route Planner', bullets: [bullets.route], evidence_ids: [['ROUTE-UI-01']] }],
  ...changes,
});

export const review = (count = 3, changes = {}) => ({
  bullets: Array.from({ length: count }, (_, i) => ({ section: 'x', bullet: i + 1, verdict: 'pass', note: 'checked' })),
  summary: { verdict: 'pass' },
  skills: { verdict: 'pass' },
  dates_and_qualifiers: { verdict: 'pass' },
  visual: { inspected_image: true, compared_to_reference: true, overflow: false, bad_wraps: false, stranded_headings: false, lost_bolding: false, layout_drift: false, notes: '' },
  pass: true,
  issues: [],
  ...changes,
});

const filler = 'I want to keep building dependable services for people who rely on them every day, and I work best when I can trace a slow request to its cause, agree the fix with the team, and measure the result after it ships. ';

export const letter = (changes = {}) => ({
  subject: 'Application for Backend Engineer',
  date: '2026-01-01',
  salutation: 'Dear Hiring Team,',
  paragraphs: [
    { text: `I am applying for the Backend Engineer role at Example Freight because your team builds the services behind a tracking platform. ${filler}`, employer_quotes: ['build the services behind our tracking platform'], kind: 'body' },
    { text: `At Sample Logistics I built the parcel tracking API in Python and PostgreSQL for 40 depot staff, and I cut lookup time from 900 ms to 120 ms by designing endpoints and database indexes. ${filler}`, evidence_ids: ['SAMPLE-API-01'], kind: 'body' },
    { text: `I also contributed to a team of 5 engineers moving deployments to Docker with a shared CI pipeline, which matches how you ship. ${filler}`, evidence_ids: ['SAMPLE-CI-01'], kind: 'body' },
    { text: 'I would welcome a conversation about the role and how I could help your team.', kind: 'closing' },
  ],
  closing: 'Kind regards,',
  signature: 'Jordan Example',
  ...changes,
});

export const verdictFor = (id, changes = {}) => {
  const quote = 'Backend engineer who builds Python APIs';
  const base = id === 'automated-screen' ? { verdict: 'PASS', reasons: [], missing_terms: ['Kubernetes'] }
    : id === 'hiring-manager' ? { verdict: 'INTERVIEW', first_ten_seconds: 'Relevant stack.', would_ask: ['Index design?'], weakest_lines: [{ quote, why: 'Vague' }] }
      : { verdict: 'MAYBE', worst_line: { quote, why: 'Generic' }, problems: ['One', 'Two'] };
  return { ...base, ...changes };
};

export const MERGED = {
  issues: [
    { id: 1, quote: 'Backend engineer who builds Python APIs', why: 'Summary is generic and has no outcome.', flagged_by: ['recruiter', 'ceo'] },
    { id: 2, quote: 'Built the parcel tracking API', why: 'Should claim a 40% revenue increase and Kubernetes.', flagged_by: ['rival'] },
  ],
  overall: 'Credible, thin on outcomes.',
  closest_to_rejecting: 'rival',
};

export const DECISIONS = {
  decisions: [
    { issue_id: 1, status: 'adapted', recommendation: 'State an outcome', action: 'Add the lookup improvement to the summary', reason: 'Supported by the record', evidence_ids: ['SAMPLE-API-01'] },
    { issue_id: 2, status: 'rejected', recommendation: 'Claim 40% revenue and Kubernetes', action: '', reason: 'Neither is in the database', evidence_ids: [] },
  ],
  add_placeholders: [{ placeholder: '[ADD: revenue figure]', disposition: 'gap', note: 'No record supports a revenue figure' }],
  questions_for_candidate: [],
};

export const finalPayload = () => payload({
  summary: 'Backend engineer who builds Python APIs on PostgreSQL, cutting tracking lookups from 900 ms to 120 ms for 40 depot staff.',
});

/** Default answers for a clean run. A scenario overrides any stage; arrays answer in turn. */
export function scripted(overrides = {}) {
  const calls = {};
  const answers = {
    evaluate: () => report(),
    questions: () => ({
      source: 'job description',
      questions: [
        { question: 'Why do you want to work at Example Freight?', answer: 'You build tracking services, and I built a tracking API for 40 depot staff.', status: 'draft', evidence_ids: ['SAMPLE-API-01'] },
        { question: 'What is your salary expectation?', answer: null, status: 'needs_confirmation', confirm_reason: 'Your expected salary' },
      ],
    }),
    selection: () => ({
      requirements: [
        { requirement: 'Python APIs', jd_quote: 'Build and maintain Python APIs backed by PostgreSQL.', evidence_ids: ['SAMPLE-API-01'], strength: 'direct' },
        { requirement: 'Team delivery', jd_quote: 'ship through a shared CI pipeline with Docker', evidence_ids: ['SAMPLE-CI-01'], strength: 'narrow', note: 'Team result' },
        { requirement: 'Kubernetes', jd_quote: 'Kubernetes experience is a plus', evidence_ids: [], strength: 'gap' },
      ],
      selected_parents: ['EXP-SAMPLE', 'PRJ-ROUTE'],
      omitted: [],
      gaps: ['Kubernetes'],
    }),
    draft_resume: () => payload(),
    draft_review: () => review(),
    draft_letter: () => letter(),
    'automated-screen': () => verdictFor('automated-screen'),
    'hiring-manager': () => verdictFor('hiring-manager'),
    'day-one': () => verdictFor('day-one'),
    rival: () => verdictFor('rival'),
    ceo: () => verdictFor('ceo'),
    recruiter: () => verdictFor('recruiter'),
    teammate: () => verdictFor('teammate'),
    merge: () => MERGED,
    rebuild: () => '# Jordan Example\n\nBackend engineer. [ADD: revenue figure]\n\n## Experience\n\nBuilt the parcel tracking API for 40 depot staff, with lookups reduced from 900 ms to 120 ms.\n\nMore of the same facts follow here, restated for the proposed rewrite so it is long enough to read.\n',
    rescreen: () => verdictFor('automated-screen'),
    triage: () => DECISIONS,
    final_resume: () => finalPayload(),
    final_review: () => review(),
    'final-screen': () => verdictFor('automated-screen'),
    final_letter: () => letter(),
    final_letter_review: () => ({ claims_checked: true, agrees_with_resume: true, visual: { inspected_image: true, overflow: false, bad_wraps: false, notes: '' }, pass: true, issues: [] }),
    ...overrides,
  };
  const provider = fixtureProvider(async (prompt, { step }) => {
    calls[step] = (calls[step] ?? 0) + 1;
    let answer = answers[step];
    if (Array.isArray(answer)) answer = answer[Math.min(calls[step] - 1, answer.length - 1)];
    if (answer === undefined) throw new Error(`No scripted answer for ${step}`);
    const value = typeof answer === 'function' ? answer(prompt) : answer;
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  return { provider, calls };
}

export const offlineDeps = (changes = {}) => ({
  liveness: () => ({ verdict: 'active', detail: 'test' }),
  fetchJd: () => ({ text: JD, via: 'test' }),
  ...changes,
});

export async function start({ root, cfg }, script, { jobText = JD, url, deps = offlineDeps() } = {}) {
  const { runDir } = createRun({ root, cfg, jobText, url, providers: { agent: 'fixture', panel: 'fixture' } });
  const manifest = await advance(runDir, { root, cfg, provider: script.provider, deps });
  return { runDir, manifest };
}

export const again = ({ root, cfg }, script, runDir, deps = offlineDeps()) => advance(runDir, { root, cfg, provider: script.provider, deps });

export { REVIEWERS };
