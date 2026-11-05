// The run state machine. Every stage has declared inputs and outputs and records
// its result in manifest.json, so a stopped run resumes where it stopped, and a
// failure is visible rather than papered over. Nothing here can submit anything:
// no stage touches a form, a mailbox, or an external system's write path.
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { getProfilePath } from '../../path-resolver.mjs';
import {
  blacklistHit, checkDuplicate, countTrackerRows, findTrackerRow, mergeIntoTracker, parseReport, realDeps, registerFinalPdf,
  releaseReportNumber, reportFileName, reserveReportNumber, saveReport, setReportHeader, upsertReportSection, urlFacts,
} from './careerops.mjs';
import { REPO_ROOT, VENDORED_SKILL, runsDir } from './config.mjs';
import { buildLetter, buildResume, checkLetterConsistency, validateLetter } from './documents.mjs';
import {
  isCleared, loadDatabase, numberIsIn, numbersIn, payloadEvidenceIds, plain, shortlistEvidence, validatePayload, validateSelection,
} from './evidence.mjs';
import { FOCUSED_REVIEWER_IDS, PanelNeedsHost, REVIEWERS, runApplicationPanel, runPanel, runScreen } from './panel.mjs';
import { HostWorkRequired } from './providers.mjs';
import { TASKS } from './tasks.mjs';
import { fitResumePayload } from './fit.mjs';
import { atomicWrite, ensureDir, extractJson, readJson, sha256, sha256File, slugify, squash, stripFence, todayLocal, writeJson } from './util.mjs';

export const STAGE_ORDER = [
  'intake', 'evaluate', 'report_track', 'questions', 'shortlist', 'selection', 'draft_resume', 'draft_build', 'draft_review',
  'draft_letter', 'draft_letter_build', 'panel', 'triage', 'final_resume', 'final_build', 'final_review', 'final_screen',
  'screen_response', 'final_letter', 'final_letter_build', 'final_letter_review', 'finalize',
];

const TERMINAL = new Set(['complete', 'stopped']);
export const workflowTier = (score) => Number(score) < 3 ? 'lean' : Number(score) < 4 ? 'focused' : 'full';

const SKIP_BY_TIER = {
  lean: new Set(['questions', 'draft_review', 'panel', 'triage', 'final_resume', 'final_build', 'final_review', 'final_screen', 'screen_response', 'final_letter', 'final_letter_build', 'final_letter_review']),
  focused: new Set(['draft_review', 'draft_letter', 'draft_letter_build', 'final_review', 'final_screen', 'screen_response', 'final_letter_review']),
  full: new Set(['draft_review', 'draft_letter', 'draft_letter_build', 'final_review', 'final_screen', 'screen_response', 'final_letter_review']),
};

// ------------------------------------------------------------ run creation

export function runIdFor({ jobText, url, today }) {
  return `${today}-${sha256(`${jobText ?? ''}|${url ?? ''}`).slice(0, 8)}`;
}

/** Create a run, or return the existing one for the same posting. */
export function createRun({ root, cfg, jobText, url, providers, today = todayLocal() }) {
  urlFacts(url);
  if (!jobText && !url) throw new Error('Provide a job description or a posting URL');
  const id = runIdFor({ jobText, url, today });
  const runDir = join(runsDir(root), id);
  if (existsSync(join(runDir, 'manifest.json'))) return { runDir, id, existing: true };
  for (const dir of ['inputs', 'tasks', 'attempts', 'evaluation', 'draft', 'panel', 'revision', 'final-work', 'final']) ensureDir(join(runDir, dir));

  const dbCopy = join(runDir, 'inputs', 'evidence-database.json');
  copyFileSync(cfg.databasePath, dbCopy);
  if (jobText) atomicWrite(join(runDir, 'inputs', 'job-description.md'), jobText.endsWith('\n') ? jobText : `${jobText}\n`);

  const manifest = {
    schema: 1,
    run_id: id,
    today,
    status: 'running',
    created_at: new Date().toISOString(),
    source: { kind: jobText ? 'pasted' : 'url', url: url ?? null },
    providers,
    source_of_truth_order: ['verified overrides', 'approved template (identity and education only)', 'evidence database'],
    inputs: {
      database_sha256: sha256File(dbCopy),
      template_sha256: sha256File(cfg.templatePath),
      reference_pdf_sha256: sha256File(cfg.referencePdf),
      overrides: cfg.overrides,
      skill_sha256: existsSync(VENDORED_SKILL) ? sha256File(VENDORED_SKILL) : null,
      skill_commit: readSkillCommit(),
      career_ops_version: readVersion(),
    },
    gates: {},
    job: {},
    report: {},
    panel: {},
    screens: {},
    warnings: [],
    user_answers: [],
    unresolved_gaps: [],
    revisions: 0,
    stages: Object.fromEntries(STAGE_ORDER.map((s) => [s, { status: 'pending', attempts: 0 }])),
  };
  writeJson(join(runDir, 'manifest.json'), manifest);
  return { runDir, id, existing: false };
}

const readVersion = () => {
  try { return readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').split(/\s/)[0]; } catch { return null; }
};
const readSkillCommit = () => {
  try { return readFileSync(join(REPO_ROOT, 'vendor/hiring-panel-skill/UPSTREAM.txt'), 'utf8').match(/commit: (\w+)/)?.[1] ?? null; } catch { return null; }
};

export const loadManifest = (runDir) => readJson(join(runDir, 'manifest.json'));

function makeContext(runDir, opts) {
  const manifest = loadManifest(runDir);
  manifest.usage ??= { calls: [], reported_tokens: null };
  const ctx = {
    runDir,
    manifest,
    root: opts.root,
    cfg: opts.cfg,
    db: loadDatabase(join(runDir, 'inputs', 'evidence-database.json')),
    provider: null,
    panelProvider: null,
    deps: opts.deps ?? realDeps(opts.root),
    path: (p) => join(runDir, p),
    jobText: () => readFileSync(join(runDir, 'inputs', 'job-description.md'), 'utf8'),
    save: () => { manifest.updated_at = new Date().toISOString(); writeJson(join(runDir, 'manifest.json'), manifest); },
    warn: (w) => { if (!manifest.warnings.includes(w)) manifest.warnings.push(w); },
    answered: (pattern) => manifest.user_answers.some((a) => pattern.test(a.text)),
  };
  const instrument = (provider) => ({
    ...provider,
    async complete(prompt, options = {}) {
      const tier = manifest.workflow?.tier;
      const limit = ctx.cfg.max_model_calls?.[tier] ?? ({ lean: 4, focused: 12, full: 16 }[tier] ?? 16);
      if (manifest.usage.calls.length >= limit) throw new Error(`Model-call limit ${limit} reached; no further AI stages will run automatically`);
      const started = Date.now();
      const record = { stage: options.step ?? 'unknown', ...provider.implementation(Boolean(options.isolated), options.step), status: 'running' };
      manifest.usage.calls.push(record);
      ctx.save();
      try {
        const answer = await provider.complete(prompt, options);
        record.status = 'done';
        record.elapsed_ms = Date.now() - started;
        ctx.save();
        return answer;
      } catch (err) {
        record.status = 'failed';
        record.elapsed_ms = Date.now() - started;
        record.error = err.message;
        ctx.save();
        throw err;
      }
    },
  });
  ctx.provider = instrument(opts.provider);
  ctx.panelProvider = instrument(opts.panelProvider ?? opts.provider);
  return ctx;
}

// ----------------------------------------------------------- stage outcomes

const done = (extra = {}) => ({ done: true, ...extra });
const skip = (reason) => ({ skip: reason });
const stop = (reason, message) => ({ stop: { reason, message } });
const awaitUser = (reason, question) => ({ awaitUser: { reason, question } });
const redo = (stages, feedback) => ({ redo: { stages, feedback } });

// ------------------------------------------------------------- auto stages

const AUTO = {
  intake(ctx) {
    const { manifest } = ctx;
    const url = manifest.source.url;
    const facts = urlFacts(url);
    const jdFile = ctx.path('inputs/job-description.md');
    let hasJd = existsSync(jdFile);

    if (url && !facts.linkedin) {
      const live = ctx.deps.liveness(url);
      manifest.gates.liveness = live.verdict;
      manifest.gates.liveness_detail = live.detail;
      if (live.verdict === 'expired') {
        return stop('posting_closed', `The posting is closed: ${url}. Share a live posting to evaluate it.`);
      }
      if (live.verdict === 'uncertain') ctx.warn('Liveness is unconfirmed: the checker could not read the posting.');
    } else if (url) {
      manifest.gates.liveness = 'unconfirmed (LinkedIn is not checked here)';
      ctx.warn('LinkedIn liveness is unconfirmed; confirm the role on the employer\'s own careers page.');
    } else {
      manifest.gates.liveness = 'not applicable (pasted job description)';
    }
    if (facts.aggregator) {
      manifest.gates.aggregator = true;
      ctx.warn(`${facts.host} is an aggregator. The role is UNCONFIRMED until it is found on the employer's own careers page.`);
    }

    if (!hasJd) {
      const fetched = facts.linkedin ? null : ctx.deps.fetchJd(url);
      if (!fetched) {
        return awaitUser('jd_unavailable', `The job description could not be read from ${url}. Paste the text: node pipeline/cli.mjs answer ${manifest.run_id} --jd-file <file>`);
      }
      atomicWrite(jdFile, `${fetched.text.trim()}\n`);
      manifest.source.jd_via = fetched.via;
      hasJd = true;
    }
    const jobText = ctx.jobText();
    if (jobText.trim().length < 200) {
      return awaitUser('jd_too_short', 'The job description is too short to evaluate. Paste the full text.');
    }
    manifest.inputs.job_sha256 = sha256(jobText);
    writeJson(ctx.path('inputs/evidence-index.json'), {
      note: 'Compact inventory for fit assessment; inspect full pinned records before claiming a gap or writing a resume fact.',
      experiences: (ctx.db.raw.experiences ?? []).map((e) => ({ id: e.experience_id, role: e.role, organisation: e.organisation, summary: e.summary, technologies: e.technologies })),
      projects: (ctx.db.raw.projects ?? []).map((p) => ({ id: p.project_id, name: p.name, summary: p.summary, technologies: p.technologies })),
      skills: (ctx.db.raw.skills ?? []).map((s) => s.skill),
      shortlisted: shortlistEvidence(ctx.db, jobText),
    });

    const hit = blacklistHit(ctx.root, { url, jobText });
    if (hit && !ctx.answered(/evaluate anyway/i)) {
      return awaitUser('blacklist', `${hit.company} is on your blacklist (since ${hit.since}): ${hit.reason}. To continue, answer "evaluate anyway".`);
    }
    if (!manifest.report.num) manifest.report.num = reserveReportNumber(ctx.root);
    return done();
  },

  report_track(ctx) {
    const { manifest } = ctx;
    const text = readFileSync(ctx.path('evaluation/report.md'), 'utf8');
    const parsed = parseReport(text);
    manifest.job = { company: parsed.company, role: parsed.role, slug: slugify(parsed.company) };
    Object.assign(manifest.report, {
      score: parsed.score,
      decision: parsed.decision,
      legitimacy: parsed.legitimacy,
      next_action: parsed.nextAction,
    });
    manifest.workflow = { tier: workflowTier(parsed.score), panel_rounds: Number(parsed.score) < 3 ? 0 : 1, editorial_revisions: Number(parsed.score) < 3 ? 0 : 1 };
    if (manifest.workflow.tier === 'lean') {
      releaseReportNumber(ctx.root, manifest.report.num);
      manifest.report.num = null;
      manifest.report.path = 'evaluation/brief.md';
      atomicWrite(ctx.path(manifest.report.path), [
        `# ${parsed.role} — ${parsed.company === '?' ? 'Undisclosed employer' : parsed.company}`,
        '', `Fit: ${parsed.score}/5 (${parsed.decision}).`,
        '', `Main gap: ${parsed.nextAction ?? 'See the pinned evaluation for details.'}`,
        '', 'This is a brief fit record. No tracker entry or hiring panel was created.', '',
      ].join('\n'));
      return done({ artifacts: [manifest.report.path] });
    }
    manifest.report.path ??= join('reports', reportFileName(manifest.report.num, parsed.company, manifest.today));

    const hit = blacklistHit(ctx.root, { company: parsed.company, url: manifest.source.url });
    if (hit && !ctx.answered(/evaluate anyway/i)) {
      return awaitUser('blacklist', `${hit.company} is on your blacklist (since ${hit.since}): ${hit.reason}. To continue, answer "evaluate anyway".`);
    }

    saveReport(ctx.root, manifest.report.path, text, ctx.jobText());
    // The URL header is a fact of this run, not something a worker may misreport.
    setReportHeader(ctx.root, manifest.report.path, { URL: manifest.source.url ?? '—' });
    releaseReportNumber(ctx.root, manifest.report.num);

    const dup = checkDuplicate(ctx.root, { company: parsed.company, role: parsed.role, url: manifest.source.url });
    if (dup?.matches?.length ?? dup?.candidates?.length) {
      manifest.gates.duplicate_candidates = dup.matches ?? dup.candidates;
      ctx.warn('The tracker already has a row that may be this opening; the ordinary merge rules decide whether it is updated in place.');
    }

    const score = Number(parsed.score);
    if (score < ctx.cfg.recommend_against_below) {
      ctx.warn(`Fit score ${score}/5 is below ${ctx.cfg.recommend_against_below}: career-ops recommends against applying unless you have a specific reason. The documents are prepared only because you asked for the full pipeline.`);
    }

    const merge = mergeIntoTracker(ctx.root, {
      num: manifest.report.num,
      date: manifest.today,
      company: parsed.company,
      role: parsed.role,
      score,
      pdf: false,
      report: manifest.report.path,
      notes: `${parsed.decision ?? 'Evaluated'}; application run ${manifest.run_id}`,
      url: manifest.source.url,
    });
    manifest.report.tracker_merge = merge.merged ? 'merged' : merge.reason;
    if (!findTrackerRow(ctx.root, manifest.report.num)) {
      throw new Error(`Report ${manifest.report.num} has no tracker row after the merge`);
    }
    if (countTrackerRows(ctx.root, manifest.report.num) !== 1) {
      throw new Error(`Report ${manifest.report.num} has more than one tracker row`);
    }
    return done({ artifacts: [manifest.report.path] });
  },

  shortlist(ctx) {
    writeJson(ctx.path('inputs/shortlist.json'), {
      note: 'Lexical shortlist only. Review all evidence, restrictions, ownership and role relevance before drafting.',
      shortlisted: shortlistEvidence(ctx.db, ctx.jobText()),
    });
    return done({ artifacts: ['inputs/shortlist.json'] });
  },

  draft_build(ctx) {
    return buildStage(ctx, 'draft/resume', 'draft/resume-payload.json', ['draft_resume'], (payload) => {
      const selection = readJson(ctx.path('draft/selection.json'));
      const allowed = new Set(selection.requirements.flatMap((r) => r.evidence_ids ?? []));
      const parents = new Set(selection.selected_parents);
      const errors = [];
      for (const entry of [...payload.experience, ...payload.projects]) {
        if (!parents.has(entry.source_id)) errors.push(`${entry.source_id} is on the resume but not in selection.selected_parents`);
      }
      // Evidence may support a selected parent without mapping to one requirement.
      for (const id of payloadEvidenceIds(payload)) {
        const record = ctx.db.evidenceById.get(id);
        if (record && !allowed.has(id) && !parents.has(record.parent_id)) errors.push(`${id} is on the resume but was not selected`);
      }
      return errors;
    });
  },

  draft_letter_build(ctx) {
    return letterBuildStage(ctx, 'draft/cover-letter', ['draft_letter']);
  },

  async panel(ctx) {
    const resumeText = readFileSync(ctx.path('draft/resume.txt'), 'utf8');
    const result = await runApplicationPanel({
      resumeText,
      jobText: ctx.jobText(),
      provider: ctx.panelProvider,
      workDir: ctx.path('panel'),
      tier: ctx.manifest.workflow.tier,
    });
    const missing = result.reviewers.filter((r) => !result.implementations[r.id]).map((r) => r.id);
    if (missing.length) throw new Error(`Panel did not record a reviewer implementation for: ${missing.join(', ')}`);
    ctx.manifest.panel = {
      panel_file: result.panelFile,
      improved_file: null,
      reviewers: Object.fromEntries(result.reviewers.map((r) => [r.id, { verdict: result.verdicts[r.id].verdict, ...result.implementations[r.id] }])),
      add_placeholders: [],
      warnings: [],
      inputs: 'rendered draft resume text and archived job description only',
    };
    ctx.manifest.screens.before = result.verdicts['automated-screen'];
    return done({ artifacts: [relative(ctx.runDir, result.panelFile)] });
  },

  final_build(ctx) {
    const result = buildStage(ctx, 'final-work/resume', 'final-work/resume-payload.json', ['final_resume'], (payload) => {
      const decisions = readJson(ctx.path('revision/decisions.json')).decisions;
      const applied = decisions.filter((d) => d.status !== 'rejected');
      const draft = readJson(ctx.path('draft/resume-payload.json'));
      if (applied.length && JSON.stringify(payload) === JSON.stringify(draft)) {
        return [`${applied.length} panel change(s) were accepted or adapted, but the payload did not change`];
      }
      return [];
    });
    if (result.done) writeChangelog(ctx);
    return result;
  },

  async final_screen(ctx) {
    const { verdict, implementation } = await runScreen({
      resumeText: readFileSync(ctx.path('final-work/resume.txt'), 'utf8'),
      jobText: ctx.jobText(),
      provider: ctx.panelProvider,
      file: ctx.path(`final-work/final-screen-${ctx.manifest.revisions ?? 0}.json`),
    });
    ctx.manifest.screens.after = verdict;
    ctx.manifest.screens.after_implementation = implementation;
    return done();
  },

  final_letter_build(ctx) {
    const built = letterBuildStage(ctx, 'final-work/cover-letter', ['final_letter']);
    if (!built.done) return built;
    const letter = readJson(ctx.path('final-work/cover-letter.json'));
    const payload = readJson(ctx.path('final-work/resume-payload.json'));
    const resumeText = readFileSync(ctx.path('final-work/resume.txt'), 'utf8');
    const { errors, warnings } = checkLetterConsistency(letter, resumeText, payload, ctx.db);
    writeJson(ctx.path('final-work/letter-consistency.json'), { errors, warnings });
    warnings.forEach(ctx.warn);
    if (errors.length) throw new Error(`The letter disagrees with the final resume:\n- ${errors.join('\n- ')}`);
    return built;
  },

  async finalize(ctx) {
    const { manifest } = ctx;
    const lean = manifest.workflow?.tier === 'lean';
    const blockers = [];
    for (const id of STAGE_ORDER) {
      if (id === 'finalize') continue;
      const status = manifest.stages[id].status;
      if (status !== 'done' && status !== 'skipped') blockers.push(`stage ${id} is ${status}`);
    }
    if (!lean) {
      const expected = manifest.workflow?.tier === 'focused' ? FOCUSED_REVIEWER_IDS : REVIEWERS.map((r) => r.id);
      for (const id of expected) if (!manifest.panel.reviewers?.[id]) blockers.push(`reviewer ${id} has no result`);
    }
    if (blockers.length) throw new Error(`Refusing to label documents final:\n- ${blockers.join('\n- ')}`);

    const resumeSource = lean ? 'draft/resume' : 'final-work/resume';
    const letterSource = lean ? 'draft/cover-letter' : 'final-work/cover-letter';
    const finalText = readFileSync(ctx.path(`${resumeSource}.txt`), 'utf8');
    if (/\[ADD:/.test(finalText)) throw new Error('The final resume contains an [ADD: ...] placeholder');

    const stem = `${slugify(ctx.cfg.candidateName ?? 'candidate')}-${manifest.job.slug}`;
    if (lean) atomicWrite(ctx.path('revision/CHANGELOG.md'), 'Single-pass low-score run: no panel or editorial revision.\n');
    const copies = {
      resume_pdf: [`${resumeSource}.pdf`, `final/${stem}-resume.pdf`],
      resume_tex: [`${resumeSource}.tex`, `final/${stem}-resume.tex`],
      resume_text: [`${resumeSource}.txt`, `final/${stem}-resume.txt`],
      resume_payload: [`${resumeSource}-payload.json`, `final/${stem}-resume-payload.json`],
      resume_audit: [`${resumeSource}.evidence-audit.json`, `final/${stem}-resume-evidence-audit.json`],
      letter_pdf: [`${letterSource}.pdf`, `final/${stem}-cover-letter.pdf`],
      letter_text: [`${letterSource}.md`, `final/${stem}-cover-letter.md`],
      letter_tex: [`${letterSource}.tex`, `final/${stem}-cover-letter.tex`],
      change_log: ['revision/CHANGELOG.md', 'final/CHANGELOG.md'],
    };
    const final = {};
    for (const [key, [from, to]] of Object.entries(copies)) {
      copyFileSync(ctx.path(from), ctx.path(to));
      final[key] = to;
    }
    manifest.final = final;
    manifest.final_artifact_sha256 = Object.fromEntries(Object.entries(final).map(([k, p]) => [k, sha256File(ctx.path(p))]));

    const rel = (p) => relative(ctx.root, ctx.path(p));
    if (!lean) {
      setReportHeader(ctx.root, manifest.report.path, {
        PDF: rel(final.resume_pdf),
        'Cover Letter': rel(final.letter_pdf),
        'Application Run': relative(ctx.root, ctx.runDir),
      });
      await registerFinalPdf(ctx.root, { reportNum: manifest.report.num, pdf: rel(final.resume_pdf), html: rel(final.resume_tex), date: manifest.today });
    }

    atomicWrite(ctx.path('SUMMARY.md'), renderSummary(ctx));
    return done({ artifacts: Object.values(final) });
  },
};

function buildStage(ctx, stem, payloadFile, redoStages, extraCheck) {
  const payload = readJson(ctx.path(payloadFile));
  const extra = extraCheck(payload);
  if (extra.length) throw new Error(`The payload failed its checks:\n- ${extra.join('\n- ')}`);
  const fitted = fitResumePayload(payload, ctx, stem);
  writeJson(ctx.path(payloadFile), fitted.payload);
  const built = buildResume(fitted.payload, ctx.path(stem), ctx, validatePayload);
  built.warnings?.forEach(ctx.warn);
  if (!built.ok) throw new Error(`The resume did not build (${built.stage}):\n- ${built.errors.join('\n- ')}`);
  if (fitted.below_target) ctx.warn(`Supported content fills ${(fitted.page_fill * 100).toFixed(0)}% of the page; no padding or extra model call was used.`);
  if (basename(payloadFile) !== `${basename(stem)}-payload.json`) copyFileSync(ctx.path(payloadFile), ctx.path(`${stem}-payload.json`));
  return done({ artifacts: [`${stem}.tex`, `${stem}.pdf`, `${stem}.txt`, `${stem}.png`, `${stem}.evidence-audit.json`] });
}

function letterBuildStage(ctx, stem, redoStages) {
  const letter = readJson(ctx.path(`${stem}.json`));
  const resume = readJson(ctx.path(`${dirname(stem)}/resume-payload.json`));
  const built = buildLetter(letter, ctx.path(stem), ctx, resume.candidate?.title);
  if (!built.ok) throw new Error(`The cover letter did not build:\n- ${built.errors.join('\n- ')}`);
  return done({ artifacts: [`${stem}.md`, `${stem}.tex`, `${stem}.pdf`] });
}

// ----------------------------------------------------------- agent artifacts

function checkPrivateFacts(questions, ctx) {
  const errors = [];
  const privatePattern = /salary|remuneration|compensation|pay expectation|notice period|availab|start date|visa|work rights|right to work|work authori[sz]ation|citizenship|sponsor|leave|previous(ly)? (work|employ)|worked (for|at|with) (us|this)|referr|how did you hear/i;
  const sources = {
    'config/profile.yml': () => readFileSync(getProfilePath(), 'utf8'),
    'evidence-database-profile': () => JSON.stringify(ctx.db.raw.profile ?? []),
    'approved-template': () => readFileSync(ctx.cfg.templatePath, 'utf8'),
    'user-answer': () => ctx.manifest.user_answers.map((a) => a.text).join('\n'),
  };
  questions.forEach((q, i) => {
    const where = `Question ${i + 1}`;
    if (!q.question) errors.push(`${where}: missing question`);
    if (!['draft', 'needs_confirmation'].includes(q.status)) errors.push(`${where}: status must be draft or needs_confirmation`);
    if (q.status === 'needs_confirmation') {
      if (q.answer) errors.push(`${where}: needs_confirmation must not carry an answer`);
      if (!q.confirm_reason) errors.push(`${where}: say what the candidate must supply`);
      return;
    }
    if (!q.answer) errors.push(`${where}: a draft needs an answer`);
    for (const id of q.evidence_ids ?? []) {
      const record = ctx.db.evidenceById.get(id);
      if (!record || !isCleared(record)) errors.push(`${where}: evidence ${id} is unknown or not cleared`);
    }
    if (privatePattern.test(q.question)) {
      const read = sources[q.fact_source];
      if (!read) errors.push(`${where}: "${q.question}" needs a private fact; mark it needs_confirmation or cite where it is established`);
      else {
        let text = '';
        try { text = read(); } catch { /* an unreadable source supports nothing */ }
        if (!q.fact_quote || !squash(text).includes(squash(q.fact_quote))) errors.push(`${where}: fact_quote is not in ${q.fact_source}`);
      }
    }
    const cited = (q.evidence_ids ?? []).map((id) => ctx.db.evidenceById.get(id)).filter(Boolean)
      .map((r) => [r.raw_fact, r.action, r.result, r.metric, r.context].join(' ')).join(' ');
    const support = `${cited} ${q.fact_quote ?? ''} ${ctx.jobText()}`;
    for (const n of numbersIn(q.answer)) {
      if (!numberIsIn(n, support)) errors.push(`${where}: number ${n} does not trace to its sources`);
    }
  });
  return errors;
}

function checkReview(value, auditFile, ctx) {
  const errors = [];
  const audit = readJson(ctx.path(auditFile));
  const expected = audit.bullets.filter((b) => b.bullet).length;
  if (!Array.isArray(value.bullets) || value.bullets.length !== expected) {
    errors.push(`Review must judge all ${expected} bullets; it judged ${value.bullets?.length ?? 0}`);
  }
  for (const key of ['summary', 'skills', 'dates_and_qualifiers']) {
    if (!value[key]?.verdict) errors.push(`Review is missing ${key}.verdict`);
  }
  if (value.visual?.inspected_image !== true || value.visual?.compared_to_reference !== true) {
    errors.push('Review must open the rendered image and compare it with the reference');
  }
  if (typeof value.pass !== 'boolean') errors.push('Review needs pass: true or false');
  return errors;
}

const reviewFailed = (value) => value.pass === false
  || (value.bullets ?? []).some((b) => b.verdict === 'fail')
  || ['summary', 'skills', 'dates_and_qualifiers'].some((k) => value[k]?.verdict === 'fail')
  || ['overflow', 'bad_wraps', 'stranded_headings', 'lost_bolding', 'layout_drift'].some((k) => value.visual?.[k] === true);

const reviewFeedback = (value) => {
  const failed = (value.bullets ?? []).filter((b) => b.verdict === 'fail').map((b) => `${b.section} bullet ${b.bullet}: ${b.note}`);
  return `The review failed this version:\n- ${[...(value.issues ?? []), ...failed].join('\n- ') || 'see the review artifact'}`;
};

/** A passing review ends one round of fixes, so the next round has its own budget. */
function reviewPassed(ctx, target) {
  ctx.manifest.stages[target].redo_count = 0;
  return done();
}

const AGENT_RULES = {
  evaluate: {
    validate(text) { return /^needs_confirmation:/m.test(text.trim().split('\n')[0]) ? [] : parseReport(text).errors; },
    after(ctx, text) {
      const line = text.trim().split('\n')[0];
      if (/^needs_confirmation:/.test(line)) return awaitUser('evaluation_gate', line.replace(/^needs_confirmation:\s*/, ''));
      return done();
    },
  },
  questions: {
    when: (ctx) => {
      const score = Number(ctx.manifest.report.score);
      return score >= ctx.cfg.questions_threshold ? null : `Score ${score}/5 is below the ${ctx.cfg.questions_threshold} answer-drafting threshold`;
    },
    validate(value, ctx) {
      if (!Array.isArray(value.questions)) return ['questions must be a list'];
      return checkPrivateFacts(value.questions, ctx);
    },
    after(ctx, value) {
      const open = value.questions.filter((q) => q.status === 'needs_confirmation');
      ctx.manifest.questions_needing_confirmation = open.map((q) => ({ question: q.question, needed: q.confirm_reason }));
      const body = value.questions.map((q) => (q.status === 'draft'
        ? `**${q.question}**\n\n${q.answer}`
        : `**${q.question}**\n\n> NEEDS YOUR ANSWER: ${q.confirm_reason}`)).join('\n\n');
      upsertReportSection(ctx.root, ctx.manifest.report.path, '## H) Draft Application Answers', `Drafts for your review. Nothing has been submitted.\n\n${body}`);
      return done();
    },
  },
  selection: { validate: (value, ctx) => validateSelection(value, ctx.db, ctx.jobText()) },
  draft_resume: { validate: (value, ctx) => validatePayload(value, ctx.db, ctx.cfg).errors },
  draft_review: {
    validate: (value, ctx) => checkReview(value, 'draft/resume.evidence-audit.json', ctx),
    after: (ctx, value) => (reviewFailed(value) ? redo(['draft_resume', 'draft_build', 'draft_review'], reviewFeedback(value)) : reviewPassed(ctx, 'draft_resume')),
  },
  draft_letter: { validate: (value, ctx) => validateLetter(value, ctx.db, ctx.cfg, ctx.jobText(), ctx.manifest.job) },
  triage: {
    validate(value, ctx) {
      const errors = [];
      const issues = readJson(ctx.path('panel/merged.json')).issues;
      const decided = new Map((value.decisions ?? []).map((d) => [d.issue_id, d]));
      for (const issue of issues) {
        if (!decided.has(issue.id)) errors.push(`Issue ${issue.id} has no decision`);
      }
      for (const d of value.decisions ?? []) {
        if (!['accepted', 'adapted', 'rejected'].includes(d.status)) errors.push(`Issue ${d.issue_id}: status must be accepted, adapted or rejected`);
        if (!d.reason) errors.push(`Issue ${d.issue_id}: a reason is required`);
        if (d.status !== 'rejected' && !d.no_new_claim && !(d.evidence_ids ?? []).length) {
          errors.push(`Issue ${d.issue_id}: an applied change cites evidence, or sets no_new_claim`);
        }
        for (const id of d.evidence_ids ?? []) {
          const record = ctx.db.evidenceById.get(id);
          if (!record || !isCleared(record)) errors.push(`Issue ${d.issue_id}: evidence ${id} is unknown or not cleared`);
        }
      }
      const listed = new Set((value.add_placeholders ?? []).map((p) => p.placeholder));
      for (const p of ctx.manifest.panel.add_placeholders ?? []) {
        if (!listed.has(p)) errors.push(`Placeholder ${p} has no disposition`);
      }
      return errors;
    },
    after(ctx, value) {
      const gaps = (value.add_placeholders ?? []).filter((p) => p.disposition === 'gap').map((p) => `${p.placeholder}: ${p.note ?? ''}`);
      ctx.manifest.evidence_gaps = gaps;
      ctx.manifest.questions_for_candidate = value.questions_for_candidate ?? [];
      return done();
    },
  },
  final_resume: { validate: (value, ctx) => validatePayload(value, ctx.db, ctx.cfg).errors },
  final_review: {
    validate: (value, ctx) => checkReview(value, 'final-work/resume.evidence-audit.json', ctx),
    after: (ctx, value) => (reviewFailed(value) ? redo(['final_resume', 'final_build', 'final_review'], reviewFeedback(value)) : reviewPassed(ctx, 'final_resume')),
  },
  screen_response: {
    when: (ctx) => (ctx.manifest.screens.after?.verdict === 'REJECT' ? null : 'The final screen passed'),
    validate(value) {
      const errors = [];
      if (!Array.isArray(value.reasons) || !value.reasons.length) errors.push('Classify every rejection reason');
      if (!['revise', 'unresolved'].includes(value.action)) errors.push('action must be revise or unresolved');
      if (value.action === 'revise' && !value.payload?.summary) errors.push('revise needs the whole revised payload');
      const known = ['fixable', 'needs_evidence', 'approved_format'];
      for (const r of value.reasons ?? []) {
        if (!known.includes(r.classification)) errors.push(`Unknown classification "${r.classification}": use ${known.join(', ')}`);
      }
      const fixable = (value.reasons ?? []).filter((r) => r.classification === 'fixable');
      if (value.action === 'unresolved' && fixable.length) errors.push('A fixable rejection cannot be left unresolved');
      if (value.action === 'revise' && !fixable.length) errors.push('There is nothing to revise when no reason is fixable; use unresolved and disclose them');
      return errors;
    },
    after(ctx, value) {
      if (value.action === 'unresolved') {
        ctx.manifest.unresolved_gaps.push(...value.reasons.map((r) => `${r.classification === 'approved_format' ? '[your approved format] ' : ''}${r.reason}${r.note ? `: ${r.note}` : ''}`));
        return done();
      }
      ctx.manifest.revisions = (ctx.manifest.revisions ?? 0) + 1;
      if (ctx.manifest.revisions > ctx.cfg.max_final_revisions) {
        throw new Error(`The final screen still rejects after ${ctx.cfg.max_final_revisions} revisions`);
      }
      archive(ctx, 'final-work/resume-payload.json', 'final_resume');
      writeJson(ctx.path('final-work/resume-payload.json'), value.payload);
      return { redoOnly: ['final_build', 'final_review', 'final_screen', 'screen_response'] };
    },
  },
  final_letter: { validate: (value, ctx) => validateLetter(value, ctx.db, ctx.cfg, ctx.jobText(), ctx.manifest.job) },
  final_letter_review: {
    validate(value) {
      const errors = [];
      if (value.visual?.inspected_image !== true) errors.push('Review must open the rendered letter image');
      if (typeof value.pass !== 'boolean') errors.push('Review needs pass: true or false');
      return errors;
    },
    after: (ctx, value) => (value.pass && !value.visual?.overflow && !value.visual?.bad_wraps
      ? reviewPassed(ctx, 'final_letter')
      : redo(['final_letter', 'final_letter_build', 'final_letter_review'], `The letter review failed:\n- ${(value.issues ?? []).join('\n- ') || value.visual?.notes}`)),
  },
};

function archive(ctx, rel, id) {
  const from = ctx.path(rel);
  if (!existsSync(from)) return null;
  const n = readdirSync(ctx.path('attempts')).filter((f) => f.startsWith(`${id}.`)).length + 1;
  const to = `attempts/${id}.${n}.${basename(rel)}`;
  renameSync(from, ctx.path(to));
  return to;
}

function resetStages(ctx, stages, feedback) {
  for (const id of stages) {
    const stage = ctx.manifest.stages[id];
    const task = TASKS[id]?.(ctx);
    const previous = task ? archive(ctx, task.artifact, id) : null;
    if (previous) stage.previous_version = previous;
    stage.status = 'pending';
    delete stage.finished_at;
    if (feedback && id === stages[0]) stage.feedback = feedback;
  }
  // Everything after a redone stage depends on it.
  const first = Math.min(...stages.map((s) => STAGE_ORDER.indexOf(s)));
  STAGE_ORDER.slice(first + 1).forEach((id) => {
    if (ctx.manifest.stages[id].status === 'done') {
      ctx.manifest.stages[id].status = 'pending';
      const task = TASKS[id]?.(ctx);
      if (task) archive(ctx, task.artifact, id);
    }
  });
}

/** Produce or check one stage's artifact. Returns an outcome, or null to wait. */
async function runAgentStage(id, ctx) {
  const rule = AGENT_RULES[id] ?? {};
  const stage = ctx.manifest.stages[id];
  if (rule.when) {
    const reason = rule.when(ctx);
    if (reason) return skip(reason);
  }
  const task = TASKS[id](ctx);
  const artifact = ctx.path(task.artifact);
  const taskFile = ctx.path(`tasks/${id}.md`);

  for (;;) {
    const brief = stage.feedback
      ? `${task.prompt}\n\nThe previous attempt was refused. Fix exactly this and resubmit:\n${stage.feedback}\n${stage.previous_version ? `\nYour previous version is ${ctx.path(stage.previous_version)}. Start from it and change only what the refusal requires, so that work already checked stays as it is.\n` : ''}`
      : task.prompt;
    atomicWrite(taskFile, brief);

    if (existsSync(artifact)) {
      let value;
      let errors = [];
      try {
        const text = readFileSync(artifact, 'utf8');
        value = task.format === 'json' ? JSON.parse(text) : text;
        errors = rule.validate ? rule.validate(value, ctx) : [];
      } catch (err) {
        errors = [`Artifact could not be read: ${err.message}`];
      }
      if (!errors.length) {
        const outcome = rule.after ? rule.after(ctx, value) : done();
        if (outcome.done || outcome.redoOnly) {
          delete stage.feedback;
          delete stage.previous_version;
        }
        return { ...outcome, artifacts: [task.artifact] };
      }
      stage.attempts += 1;
      stage.last_errors = errors;
      stage.feedback = errors.map((e) => `- ${e}`).join('\n');
      stage.previous_version = archive(ctx, task.artifact, id) ?? stage.previous_version;
      if (stage.attempts >= ctx.cfg.max_stage_attempts) {
        throw new Error(`Stage ${id} failed validation ${stage.attempts} times:\n${stage.feedback}`);
      }
      ctx.save();
      continue;
    }

    if (ctx.provider.name === 'host') {
      // A host may take over after an earlier CLI worker timed out. Record the
      // implementation of the agent now asked to supply this artifact, so a
      // stale provider label cannot survive into the completed manifest.
      stage.implementation = ctx.provider.implementation(false);
      return { waitHost: { stage: id, task_file: taskFile, output_file: artifact, format: task.format } };
    }
    // Research can take a while; drafting from local files should not.
    const timeoutMs = (task.tools.includes('WebSearch') ? 40 : 20) * 60 * 1000;
    let text;
    text = await ctx.provider.complete(brief, { tools: task.tools, dataDir: ctx.root, step: id, timeoutMs });
    stage.implementation = ctx.provider.implementation(false);
    if (task.format === 'json') {
      try {
        writeJson(artifact, extractJson(text));
      } catch (err) {
        stage.attempts += 1;
        stage.feedback = `Your output could not be parsed: ${err.message}. Return only one JSON object.`;
        if (stage.attempts >= ctx.cfg.max_stage_attempts) throw new Error(`Stage ${id}: ${stage.feedback}`);
        ctx.save();
      }
    } else {
      atomicWrite(artifact, stripFence(text));
    }
  }
}

// ----------------------------------------------------------------- the loop

function bumpRedo(ctx, id, outcome) {
  const stage = ctx.manifest.stages[outcome.redo.stages[0]];
  stage.redo_count = (stage.redo_count ?? 0) + 1;
  if (stage.redo_count > ctx.cfg.max_stage_attempts) {
    throw new Error(`Stage ${outcome.redo.stages[0]} was sent back ${stage.redo_count - 1} times from ${id} and still fails:\n${outcome.redo.feedback}`);
  }
  resetStages(ctx, outcome.redo.stages, outcome.redo.feedback);
}

export async function advance(runDir, opts) {
  const ctx = makeContext(runDir, opts);
  const { manifest } = ctx;
  if (TERMINAL.has(manifest.status)) return manifest;
  // A resume after a failure gets a fresh retry budget; finished stages stay finished.
  if (manifest.status === 'failed') {
    for (const stage of Object.values(manifest.stages)) {
      stage.attempts = 0;
      stage.redo_count = 0;
    }
  }
  manifest.status = 'running';
  delete manifest.waiting;
  delete manifest.error;
  ctx.save();

  let current = null;
  try {
    for (;;) {
      const id = STAGE_ORDER.find((s) => !['done', 'skipped'].includes(manifest.stages[s].status));
      current = id;
      if (!id) {
        manifest.status = 'complete';
        manifest.completed_at = new Date().toISOString();
        ctx.save();
        return manifest;
      }
      const stage = manifest.stages[id];
      if (SKIP_BY_TIER[manifest.workflow?.tier]?.has(id)) {
        stage.status = 'skipped';
        stage.skip_reason = `${manifest.workflow.tier} workflow omits this AI stage`;
        ctx.save();
        continue;
      }
      stage.status = 'running';
      stage.started_at ??= new Date().toISOString();
      delete stage.error;
      ctx.save();

      const outcome = AUTO[id] ? await AUTO[id](ctx) : await runAgentStage(id, ctx);

      if (outcome.waitHost) {
        stage.status = 'pending';
        manifest.status = 'awaiting_agent';
        manifest.waiting = outcome.waitHost;
        ctx.save();
        return manifest;
      }
      if (outcome.stop) {
        stage.status = 'blocked';
        manifest.status = 'stopped';
        manifest.stop_reason = outcome.stop;
        if (manifest.report.num) releaseReportNumber(ctx.root, manifest.report.num);
        ctx.save();
        return manifest;
      }
      if (outcome.awaitUser) {
        stage.status = 'pending';
        manifest.status = 'awaiting_user';
        manifest.waiting = outcome.awaitUser;
        // A question from the evaluation must be asked again only if unanswered.
        if (id === 'evaluate') archive(ctx, 'evaluation/report.md', id);
        ctx.save();
        return manifest;
      }
      if (outcome.redo) {
        stage.status = 'pending';
        bumpRedo(ctx, id, outcome);
        ctx.save();
        continue;
      }
      if (outcome.redoOnly) {
        stage.status = 'pending';
        resetStages(ctx, outcome.redoOnly);
        ctx.save();
        continue;
      }
      if (outcome.skip) {
        stage.status = 'skipped';
        stage.skip_reason = outcome.skip;
      } else {
        stage.status = 'done';
        stage.finished_at = new Date().toISOString();
        stage.artifacts = outcome.artifacts ?? stage.artifacts;
      }
      ctx.save();
    }
  } catch (err) {
    const id = current;
    if (err instanceof PanelNeedsHost || err instanceof HostWorkRequired) {
      if (id) manifest.stages[id].status = 'pending';
      manifest.status = 'awaiting_agent';
      manifest.waiting = { stage: id, panel_tasks: err.tasks ?? [] };
      ctx.save();
      return manifest;
    }
    if (id) {
      manifest.stages[id].status = 'failed';
      manifest.stages[id].error = err.message;
    }
    manifest.status = 'failed';
    manifest.error = { stage: id, message: err.message };
    ctx.save();
    return manifest;
  }
}

/** Record the candidate's answer. Answers unblock a waiting gate on the next advance. */
export function recordAnswer(runDir, { text, jdText }) {
  const manifest = loadManifest(runDir);
  if (jdText) atomicWrite(join(runDir, 'inputs', 'job-description.md'), `${jdText.trim()}\n`);
  if (text) manifest.user_answers.push({ text, at: new Date().toISOString() });
  writeJson(join(runDir, 'manifest.json'), manifest);
  return manifest;
}

// --------------------------------------------------------------- reporting

function writeChangelog(ctx) {
  const decisions = readJson(ctx.path('revision/decisions.json'));
  const issues = new Map(readJson(ctx.path('panel/merged.json')).issues.map((i) => [i.id, i]));
  const draft = readJson(ctx.path('draft/resume-payload.json'));
  const finalPayload = readJson(ctx.path('final-work/resume-payload.json'));
  const bullets = (p) => [...p.experience, ...p.projects].flatMap((e) => e.bullets.map((b) => plain(b)));
  const before = bullets(draft);
  const after = bullets(finalPayload);
  const removed = before.filter((b) => !after.includes(b));
  const added = after.filter((b) => !before.includes(b));
  const rows = decisions.decisions.map((d) => {
    const issue = issues.get(d.issue_id);
    return `### Issue ${d.issue_id}: ${d.status.toUpperCase()}\n\n- Panel: "${issue?.quote ?? ''}" ${issue?.why ?? ''} (${(issue?.flagged_by ?? []).join(', ')})\n- Recommendation: ${d.recommendation ?? ''}\n- Action: ${d.action || 'none'}\n- Reason: ${d.reason}\n- Evidence: ${(d.evidence_ids ?? []).join(', ') || (d.no_new_claim ? 'no new claim' : 'none')}`;
  });
  const count = (s) => decisions.decisions.filter((d) => d.status === s).length;
  const text = [
    '# Panel change log',
    '',
    `Accepted ${count('accepted')}, adapted ${count('adapted')}, rejected ${count('rejected')}.`,
    '',
    ...rows.flatMap((r) => [r, '']),
    '## Bullets changed between draft and final',
    '',
    ...removed.map((b) => `- Removed or rewritten: ${b}`),
    ...added.map((b) => `+ New or rewritten: ${b}`),
    !removed.length && !added.length ? 'No bullet text changed.' : '',
    '',
    plain(draft.summary) === plain(finalPayload.summary) ? 'Summary unchanged.' : `Summary before: ${plain(draft.summary)}\n\nSummary after: ${plain(finalPayload.summary)}`,
    '',
  ];
  atomicWrite(ctx.path('revision/CHANGELOG.md'), text.join('\n'));
}

function renderSummary(ctx) {
  const m = ctx.manifest;
  if (m.workflow?.tier === 'lean') {
    const fit = readJson(ctx.path('draft/resume.fit.json'));
    return `# ${m.job.role}, ${m.job.company === '?' ? 'undisclosed employer' : m.job.company}

Nothing has been submitted.

## Fit
- Score: ${m.report.score}/5 (${m.report.decision})
- Brief assessment: ${m.report.path}
- Main gap or next action: ${m.report.next_action ?? 'See assessment'}

## Documents
- Resume PDF: ${m.final.resume_pdf}
- Resume LaTeX: ${m.final.resume_tex}
- Cover letter PDF: ${m.final.letter_pdf}
- Cover letter, editable: ${m.final.letter_text}

## Checks
- One-page resume fill: ${(fit.page_fill * 100).toFixed(1)}%
- Scripted evidence and PDF checks passed.
- Hiring panel and editorial revisions: not run for a score below 3/5.
${fit.below_target ? '- The selected evidence could not honestly fill the 80% target.\n' : ''}`;
  }
  const decisions = readJson(ctx.path('revision/decisions.json')).decisions;
  const count = (s) => decisions.filter((d) => d.status === s).length;
  const impl = Object.values(m.panel.reviewers);
  const fixture = impl.some((r) => r.provider === 'fixture');
  return `${fixture ? '> DEMO RUN: canned reviewer responses, NOT a real panel review.\n\n' : ''}# ${m.job.role}, ${m.job.company}

Nothing has been submitted. These documents are for your review.

## Fit
- Score: ${m.report.score}/5 (unchanged by the panel)
- Recommendation: ${m.report.decision ?? 'see report'}
- Legitimacy: ${m.report.legitimacy ?? 'see report'}
- Liveness: ${m.gates.liveness ?? 'n/a'}
- Report: ${m.report.path}

## Final documents
- Resume PDF: ${m.final.resume_pdf}
- Resume LaTeX: ${m.final.resume_tex}
- Cover letter PDF: ${m.final.letter_pdf}
- Cover letter, editable: ${m.final.letter_text}

## Panel
- Reviewers: ${[...new Set(impl.map((r) => `${r.runtime} (model: ${r.model ?? 'n/a'})`))].join('; ')}
${Object.entries(m.panel.reviewers).map(([id, r]) => `- ${id}: ${r.verdict}`).join('\n')}
- Report: ${relative(ctx.runDir, m.panel.panel_file)}
- Review rounds: one; final AI screen: not run.

## Panel recommendations
Accepted ${count('accepted')}, adapted ${count('adapted')}, rejected ${count('rejected')}. See ${m.final.change_log}.

## Needs your attention
${[
    ...(m.questions_needing_confirmation ?? []).map((q) => `- Application question: ${q.question} (${q.needed})`),
    ...(m.questions_for_candidate ?? []).map((q) => `- ${q}`),
    ...(m.evidence_gaps ?? []).map((g) => `- Evidence gap: ${g}`),
    ...m.unresolved_gaps.map((g) => `- Unresolved screen issue: ${g}`),
    ...m.warnings.map((w) => `- ${w}`),
  ].join('\n') || '- Nothing flagged.'}
`;
}

export function listRuns(root) {
  const dir = runsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'manifest.json')))
    .map((name) => ({ name, mtime: statSync(join(dir, name, 'manifest.json')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ name }) => {
      const m = readJson(join(dir, name, 'manifest.json'));
      return { run: name, status: m.status, company: m.job?.company, role: m.job?.role, score: m.report?.score };
    });
}

