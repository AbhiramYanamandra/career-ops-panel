# Application pipeline: operator guide

This repository combines [career-ops](https://github.com/career-ops-hq/career-ops) and the standalone [hiring panel](https://github.com/alexyc9381/hiring-panel-skill). Its application pipeline scores a posting against the pinned career evidence database, then produces an evidence-linked one-page resume and cover letter. Review effort depends on fit. The separate upstream features remain available.

**Nothing here submits an application, fills a form or sends a message.** You review the documents and apply yourself.

## Install

You need a Node.js version supported by this repository (`^22.13.0` or `>=23.4.0`), [tectonic](https://tectonic-typesetting.github.io), and poppler (`pdftotext`, `pdftoppm`, `pdfinfo`, `pdffonts`). To run reviewers without a host agent, you also need the `claude` or `codex` CLI, signed in.

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
node pipeline/cli.mjs setup
```

`setup` tells the career-ops updater to leave this repository's own files alone, and reports any missing tools. Run it once per clone: its declaration file is deliberately not committed.

Coming from an existing career-ops checkout? Copy your data across. The source is only read, and existing files are never overwritten:

```bash
node pipeline/cli.mjs setup --from ../career-ops
```

To try it with a fictional candidate first:

```bash
node pipeline/cli.mjs setup --example
```

## Configure

Personal material lives in `data/resume-template/`, which git ignores and updates never touch:

| File | Purpose |
|---|---|
| `pipeline.json` | Template anchors, override rules, candidate name, default provider |
| your `.tex` and reference `.pdf` | The approved one-page layout. It must define `\sectionline`, `\titleline`, `\plainline` and `\bulletline`, and have one marker where the body starts |
| `career-database.path`, or `database.path` in `pipeline.json` | Where your evidence database is. `CAREER_OPS_EVIDENCE_DB` overrides both |
| `verified-overrides.json` | Facts you confirmed over older database values |

`pipeline/examples/resume-template/` is a complete working example, including the database format. `CAREER_OPS_ROOT` moves all your data outside the repository if you prefer.

Where candidate facts come from, highest priority first:

1. Verified overrides.
2. The approved template's fixed identity and education text.
3. The evidence database, for every tailored resume and letter claim.

Job postings, earlier resumes, panel opinions and model output are never proof of experience.

## Run the full pipeline

From a live posting:

```bash
node pipeline/cli.mjs start --url "https://jobs.example.com/123" --provider claude
```

From a pasted description saved to a file:

```bash
node pipeline/cli.mjs start --jd-file job.md --provider claude
```

Or ask your agent: `/application-pipeline`, or "run the full application pipeline for this role".

| Fit score | Pipeline path | Normal model calls | Output |
|---|---|---:|---|
| Below 3/5 | One pass; no panel, tracker entry or editorial revision | 4 maximum | Brief fit/gap record, resume, cover letter |
| 3.0–3.9/5 | Three independent reviewers, one evidence-checked revision | 10; cap 12 | Evaluation/tracker, resume, cover letter, review |
| 4.0–5.0/5 | Seven independent reviewers, one evidence-checked revision | 14; cap 16 | Evaluation/tracker, resume, cover letter, panel |

The model writes a ranked content bank from the database. The local fitter renders that full bank, then finds the smallest number of complete low-ranked bullet or entry removals needed for one page. Evidence IDs stay attached to retained bullets. The fitter records page fill; if supported content cannot reach the 80% target, it reports that without inventing material or making another model call. The engine checks evidence IDs, numbers, selected parents, PDF length and letter consistency with scripts. It stops visibly on an invalid draft instead of trying repeated model repairs.

| Provider | What runs | Reviewer isolation |
|---|---|---|
| `claude` | `claude -p` | Enforced: empty folder, no tools, no settings, one process each |
| `codex` | `codex exec`, read-only sandbox | Empty folder, one process each. Codex may still load your global Codex instructions |
| `host` | The agent driving the CLI does each step and submits files, with subagents for the panel | Attested by the host, not enforced. The manifest says so |

Use different providers with `--provider codex --panel-provider claude`. `--model`, `--panel-model`, `--effort` and `--panel-effort` override run defaults. For stage-specific routing, set `providers.claude.stages` or `providers.codex.stages` in your user-layer `pipeline.json`, for example `"evaluate": {"model":"<configured model>","effort":"low"}` and `"draft_resume": {"model":"<configured model>","effort":"high"}`. `max_model_calls` can set per-path caps (`lean`, `focused`, `full`). The manifest records the runtime, model, effort, stage, status and elapsed time of every CLI model call. Provider CLIs do not consistently return comparable token usage, so the manifest does not claim an exact token total. Host-mode work is outside the CLI call cap. The panel never falls back to one blended review.

## When a run stops

```bash
node pipeline/cli.mjs status
```

```bash
node pipeline/cli.mjs status <run>
```

| Status | Meaning | What to do |
|---|---|---|
| `complete` | Final documents are ready | Read `SUMMARY.md`, check the PDFs, apply yourself |
| `awaiting_user` | A gate needs you: blacklist hit, agency question, unreadable posting | `answer <run> "..."` or `answer <run> --jd-file job.md`, then `resume <run>` |
| `awaiting_agent` | Host mode: the agent's turn | `next <run>`, do the work, `resume <run>` |
| `stopped` | The posting is closed | Find a live posting |
| `failed` | A stage failed; the error says which and why | Fix the cause, then `resume <run>` |

```bash
node pipeline/cli.mjs resume <run>
```

Resuming repeats nothing that finished, including individual reviewers. Starting the same posting twice resumes the existing run. Your data never gets a duplicate tracker row.

## Where things are

Each run lives in `data/application-runs/<run>/`:

| Path | Contents |
|---|---|
| `SUMMARY.md` | Start here: fit, documents, path taken, checks, what needs you |
| `final/` | Final resume PDF, LaTeX, text, payload and audit; final letter PDF, Markdown and LaTeX; change log |
| `draft/` | First resume and, on the low-score path, the final letter; payload, evidence audit and selection |
| `panel/` | One `REVIEW.md` (3 readers) or `PANEL.md` (7 readers) when fit is at least 3 |
| `panel/verdicts/`, `panel/prompts/` | Each reviewer's raw answer and exact prompt |
| `revision/` | Accepted, adapted and rejected decisions, and the change log |
| `final-work/` | Revised versions before release when fit is at least 3 |
| `inputs/` | Archived job description, pinned copy of the evidence database, shortlist |
| `attempts/` | Every refused or superseded artifact |
| `manifest.json` | Stage status, input hashes, path and call log, reviewer implementation, final paths |

For scores at least 3, the evaluation report is in `reports/` and the tracker row stays `Evaluated` until you change it. Below 3, only `evaluation/brief.md` is produced; there is no tracker entry.

Set `"letter": { "date_format": "day-month-year" }` in your user-layer `pipeline.json` to display dates such as `4 November 2026` in the editable Markdown and PDF, even if a worker returns an ISO date. The default remains `iso`. A completed run remains a pinned historical snapshot; later evidence-database corrections apply to new runs, not old artifacts.

## Use the hiring panel on its own

Any resume, with or without a job:

```bash
node pipeline/cli.mjs panel --resume resume.pdf --job job.md --provider claude
```

```bash
node pipeline/cli.mjs panel --resume resume.md --role "Data Engineer" --provider codex
```

It writes `.hiring-panel/<date>-<name>/PANEL.md` and `RESUME-IMPROVED.md` in your current folder, and touches nothing else. The original skill is also available unchanged as `/hiring-panel`.

## Use career-ops on its own

Everything is where it was: `/career-ops`, modes, `scan.mjs`, `merge-tracker.mjs`, the dashboard, and the rest of `README.md`. Plain auto-pipeline behaves as it does upstream, subject to your `modes/_custom.md`.

## Tests

```bash
node --test tests/pipeline/*.test.mjs
```

```bash
node test-all.mjs
```

The first is this feature's small targeted suite. It uses real LaTeX builds and real career-ops scripts, with scripted model answers and no paid AI calls. Run upstream's `test-all.mjs` only for a separate upstream update or broad compatibility check; it is not part of an ordinary application or this feature's acceptance gate.

## Updates

```bash
node update-system.mjs check
```

```bash
node update-system.mjs apply --confirm
```

The updater changes career-ops system files and leaves `pipeline/`, `vendor/`, the two added skills and all your data alone. It only appends to `.gitignore`. One local change sits in a system file, `cv-templates.mjs` (`cv.template_path`), and the updater replaces that file, so re-apply the change or prefer `git merge upstream/main`. See `pipeline/docs/ARCHITECTURE.md`, which also covers updating the panel.

## Known limits

- **Checks are not proof.** Software catches wrong IDs, parents, dates and numbers and unsupported skills. It cannot prove a paraphrase is fair, or tell when a number in a record is used to mean something else. A separate review stage reads each claim against its records, and that review is itself a model's judgment. Read your final documents.
- **Word numbers are not checked.** "Three models" escapes the numeric gate, though not the review.
- **Fit is a model judgment.** The scoring task reads a compact inventory and the pinned full evidence database, not `cv.md`. Review the score and supporting rationale yourself.
- **Application forms are only read when a worker can reach them.** Otherwise answers come from questions in the posting, or the generic set.
- **A panel verdict is a language model's opinion.** It does not predict an employer's response.
- **Slow service responses stall a step.** A timed-out worker fails visibly without an automatic second call. After fixing the cause, `resume <run>` continues from the failed stage. You can use `--provider host` to supply that stage manually.
- **Your template's typesetting is reported, not changed.** If a screen objects to ligatures or to link labels without visible URLs, the summary says so and the decision is yours.
- **One template shape.** The renderer expects the section order and commands described above.
