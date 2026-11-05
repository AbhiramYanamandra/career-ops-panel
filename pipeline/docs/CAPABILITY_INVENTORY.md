# Capability inventory

Recorded before integration, against career-ops v1.38.0 (`115bc98`) and hiring-panel-skill (commit in `vendor/hiring-panel-skill/UPSTREAM.txt`).

## career-ops

| Area | What exists | Kind | Status here |
|---|---|---|---|
| Entry point | `/career-ops` router in `.claude/skills/career-ops/SKILL.md`, shared with Codex, Pi, OpenCode and others | Agent instructions | Unchanged |
| Modes | `modes/*.md`: auto-pipeline, oferta, pdf, latex, cover, apply, scan, batch, triage, tracker, interview and about 40 more, plus 20 market sets | Agent instructions | Unchanged |
| Evaluation | A-G rubric, gates and report format in `modes/oferta.md` and `modes/_shared.md`; validated by `check-jd-archive.mjs` | Instructions and scripts | Used as is |
| Auto-pipeline | Extract, liveness, blacklist and dealbreaker gates, evaluate, report, PDF, answers at 4.5 or above, tracker | Agent instructions | Unchanged; the new pipeline is a separate command |
| CV generation | `generate-pdf.mjs`, `build-cv-html.mjs`, `generate-latex.mjs`, verifiers, all `cv.md`-based | Software | Unchanged |
| Cover letters | `modes/cover.md`, `generate-cover-letter.mjs`, draft section in the report | Mixed | Unchanged; the new pipeline adds an evidence-linked letter |
| Tracker | `merge-tracker.mjs`, `set-status.mjs`, `dedup-tracker.mjs`, `verify-pipeline.mjs`, TSV contract, canonical states | Software | Called, not copied |
| Scanning | `scan.mjs`, `providers/`, `scan-ats-full.mjs`, and more; zero-token | Software | Unchanged |
| Liveness and JD fetch | `check-liveness.mjs`, `fetch-jd.mjs`, `browser-extract.mjs` | Software | Called |
| Dashboard and web | `dashboard/`, `scripts/ui-server.mjs` | Software | Unchanged |
| Interview, follow-up, analytics | `modes/interview/`, `followup-cadence.mjs`, `stats.mjs`, and more | Mixed | Unchanged |
| Data contract | `DATA_CONTRACT.md`; `USER_PATHS` in `update-system.mjs`; `SYSTEM_PATHS` in `lib/update-manifest.mjs` | Software | Respected; fork paths declared through `config/local-paths.txt` |
| Updates | `update-system.mjs` check, apply, rollback; overlays system paths from the canonical repo | Software | Tested with this repository's additions |
| Tests | `test-all.mjs`, plus 843 discovered suites; 17,359 checks at baseline | Software | Must stay green |
| Dependencies | Node, Playwright, YAML; optional Go dashboard, LaTeX | | Adds tectonic and poppler for this feature |
| License | MIT | | Preserved |

## hiring-panel-skill

| Area | What exists | Kind | Status here |
|---|---|---|---|
| Skill | `/hiring-panel`, one `SKILL.md` | Agent instructions | Verbatim, available unchanged |
| Reviewers | Automated screen, hiring manager, five independent readers, as Claude subagents | Agent instructions | Same roles, also available as software with recorded implementations |
| Outputs | `.hiring-panel/<date>-<name>/PANEL.md`, `RESUME-IMPROVED.md`, attribution line | Agent instructions | Same files and line |
| Merge, rebuild, re-screen | Ranked issue list, `[ADD: ...]` placeholders, before and after verdict | Agent instructions | Same steps |
| "Touch no other files" | Applies to the skill | | Holds for the panel phase; later revision is a separate stage |
| Tests | `tests/test_skill.py`, text assertions | Software | Vendored; `tests/pipeline/panel.test.mjs` adds wording parity |
| License | MIT | | Preserved |

## Your local checkout, beyond upstream

| Item | Where | Handling |
|---|---|---|
| `cv.template_path` support | Uncommitted change to `cv-templates.mjs` and its test | Own commit here; source left uncommitted and untouched |
| Approved resume format and builder | `data/resume-template/`, user layer, not in git | Copied to the new data layer. `build-approved.mjs` still works, and its checks are generalised and extended in `pipeline/lib/` |
| Evidence database | Outside the repository, named by `career-database.path` | Stays where it is. Each run pins a private copy under `data/` |
| Verified WAM and completion date | `verified-overrides.json` | Applied as a top-priority source |
| Standing workflow rules | `modes/_custom.md` | Copied; the engine now enforces what it can of them |

## What the existing builder checked, and what was added

Kept: evidence IDs, parent ownership, claim clearance, bullet length, numeric provenance, compile, one-page A4.

Added: whole-number matching (the old check accepted "5" because "95" contains it), percentages needing a percentage, dates and titles against the parent, summary evidence and numbers, skill support, placeholder and stale-value refusal, duplicate claims, font, margin and section-order comparison with the reference, stranded headings, and letter consistency against the final resume.
