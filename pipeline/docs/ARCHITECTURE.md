# Architecture

## Why a fork with bounded additions

career-ops has more than 200 scripts, its own data contract, an updater and a very large test suite. A narrow new application would lose all of that, and wrapping it from outside would break its assumption that scripts and modes live at the repository root. So this repository is career-ops at a pinned commit plus additions in paths the updater does not manage, and calls the existing scripts rather than copying their logic. The hiring panel is small and agent-instruction based, so it is vendored verbatim and its behaviour is reimplemented as software beside it.

| Layer | Where | Updated by |
|---|---|---|
| career-ops system files | Repository root, `modes/`, `tests/`, and so on | `update-system.mjs` or `git merge upstream/main` |
| Hiring panel, verbatim | `vendor/hiring-panel-skill/`, `.claude/skills/hiring-panel/`, `.agents/skills/hiring-panel/` | By hand, below |
| This feature | `pipeline/`, `PIPELINE.md`, `NOTICE.md`, `.claude/skills/application-pipeline/`, `.agents/skills/application-pipeline/` | This repository |
| Your data | The career-ops user layer, including `data/resume-template/` and `data/application-runs/` | Only you and your runs |

## Stages

The engine (`pipeline/lib/engine.mjs`) records each stage in `manifest.json`. **Auto** stages are deterministic code. **Worker** stages use a provider or host agent and are checked before moving on. Workers get read-only tools. After scoring, the engine skips stages according to the path: lean below 3, focused from 3 to below 4, full from 4 upward.

| Stage | Kind | Input | Output | Refuses when |
|---|---|---|---|---|
| `intake` | Auto | URL or pasted text | Archived JD, gate results, reserved report number | Closed posting, unreadable JD, blacklist hit |
| `evaluate` | Worker | JD, pinned database inventory and full records, career-ops scoring rubric | Concise report | Report contract is unmet; asks the user on agency or dealbreaker gates |
| `report_track` | Auto | Report | Below 3: brief gap record only. Otherwise: report and tracker row | Row is missing or duplicated afterwards |
| `questions` | Worker, score at least 3.0 | JD, report, evidence | Answer drafts in the report | A private fact is answered without a verifiable source |
| `shortlist` | Auto | JD, database | Lexical retrieval aid | |
| `selection` | Worker | Shortlist, database | Requirement map, omissions, gaps | Quote is not in the JD; evidence is not cleared; a gap cites evidence |
| `draft_resume` | Worker | Selection and all relevant cleared evidence | Ranked evidence-linked content bank | Invalid JSON or unsupported claims |
| `draft_build` | Auto | Full payload | TeX, PDF, text, image, audit and fit record | Any fact gate fails, or content cannot fit on one A4 page after complete low-ranked items are removed |
| `draft_letter`, `draft_letter_build` | Worker, Auto; lean only | Draft, evidence, JD | Full letter, PDF | Unsupported claim or one-page build failure |
| `panel` | Isolated reviewers; focused/full only | Rendered draft text and JD only | Three or seven verdicts and one merged issue list | Any reviewer fails; no blended substitute |
| `triage` | Worker | Issues, evidence | Accepted, adapted or rejected, for each issue | An issue lacks a decision; an applied change lacks support; a placeholder lacks a disposition |
| `final_resume`, `final_build` | Worker, Auto; focused/full only | Decisions, draft | One revised candidate and change log | Same gates as draft; accepted changes left the payload unchanged |
| `final_letter`, `final_letter_build` | Worker, Auto; focused/full only | Final resume, evidence, JD | Reconciled letter | Tools, numbers, dates or employers disagree with the final resume |
| `finalize` | Auto | Everything | `final/`, report header, PDF flag, `SUMMARY.md` | Any required stage or reviewer result is missing |

## State and resuming

`manifest.json` is written atomically after each transition. A stage is `pending`, `running`, `done`, `skipped`, `blocked` or `failed`, and a crash leaves a stage that simply re-runs. Worker artifacts are the state: if a valid one exists, the provider is not called. Reviewers are keyed by a hash of their exact prompt, so a resume skips those that already answered, while a changed draft re-runs them. Refused artifacts move to `attempts/`.

The integrated path has no automatic editorial loop: a failed worker artifact stops visibly, and a manual resume after a concrete correction continues at that stage. The provider call cap remains attached to the run. The standalone panel keeps its original rebuild and rescreen behavior.

Run IDs hash the JD and URL with the date, so a repeat on the same day finds the same run. For scores at least 3, tracker writes go through the ordinary merge, which matches on report number, URL, and company plus role, and the engine verifies there is exactly one row. Below 3, no tracker write occurs.

## Trust boundaries

| Material | Treated as | Can | Cannot |
|---|---|---|---|
| Job posting | Untrusted data | Set requirements, supply quotes | Establish your experience, or issue instructions |
| Evidence database, overrides | Trusted facts | Support claims | Be edited by a run. Each run uses a pinned copy |
| Worker drafts | Proposals | Become payloads after validation | Bypass a gate |
| Panel opinions | Independent criticism | Prompt changes | Supply facts, alter the score, or replace the template |
| Rendered documents | Outputs | Be reviewed and released | Be called final before `finalize` |

Reviewers receive only their role, the resume text and the job. Their prompts are saved so this can be checked, and `tests/pipeline/panel.test.mjs` checks it.

## Personal changes in system files

`cv-templates.mjs` and `tests/cv-templates.test.mjs` carry `cv.template_path`, the uncommitted change from the source checkout, as its own commit. An `update-system.mjs apply` overwrites those two files and removes the feature. `git merge upstream/main` keeps it. The integrated pipeline does not depend on it, but your ordinary CV modes do if `cv.template_path` is set. Consider contributing it upstream.

## Taking upstream changes

**career-ops:** `git fetch upstream && git merge upstream/main` is the complete route and keeps the commit above. `update-system.mjs apply` also works, and was tested against a newer upstream commit. Then run `node --test tests/pipeline/*.test.mjs`, which catches the integrated path and its evidence and panel gates. Use the broad upstream suite only for an upstream compatibility check, not for an ordinary application.

**hiring panel:** replace the files in `vendor/hiring-panel-skill/` from the new commit, update `UPSTREAM.txt`, copy `SKILL.md` to the two skill folders, review the diff for changes to the reviewer roles, carry them into `REVIEWERS` in `pipeline/lib/panel.mjs`, and run the tests. A test asserts the reviewers still match the skill's wording.

## Adding a provider

Add it to `pipeline/lib/providers.mjs`. It needs a `name`, a truthful `implementation(isolated)`, and `complete(prompt, { isolated, tools, dataDir, step })` returning text. When `isolated` is true it must give the model nothing but the prompt, or report plainly in `implementation` that it cannot.
