// Configuration and the source-of-truth order for candidate facts.
//
// Order (highest first), recorded in every run manifest:
//   1. verified overrides  - facts the user confirmed over the database
//   2. approved template   - fixed identity and education text only
//   3. evidence database   - every tailored resume claim and letter claim
// Job postings, earlier resumes, panel opinions and model output are never sources.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { readJson } from './util.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const VENDORED_SKILL = join(REPO_ROOT, 'vendor/hiring-panel-skill/skills/hiring-panel/SKILL.md');
export const SKILL_ATTRIBUTION = 'Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media';

export const dataRoot = () => getCareerOpsRoot();
export const runsDir = (root = dataRoot()) => join(root, 'data', 'application-runs');

const DEFAULTS = {
  questions_threshold: 3.0,
  recommend_against_below: 4.0,
  min_bullet_chars: 110,
  max_stage_attempts: 1,
  max_final_revisions: 1,
  min_page_fill: 0.8,
};

export class ConfigError extends Error {}

/**
 * Load `data/resume-template/pipeline.json` (or PIPELINE_CONFIG). All personal
 * values live in that user-layer file; product code holds no machine paths.
 */
export function loadConfig(root = dataRoot()) {
  const configPath = process.env.PIPELINE_CONFIG
    ? resolve(root, process.env.PIPELINE_CONFIG)
    : join(root, 'data', 'resume-template', 'pipeline.json');
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Pipeline config not found at ${configPath}. Run: node pipeline/cli.mjs setup --example, or copy pipeline/examples/resume-template/ and edit it.`,
    );
  }
  const raw = readJson(configPath);
  const letterDateFormat = raw.letter?.date_format ?? 'iso';
  if (!['iso', 'day-month-year'].includes(letterDateFormat)) {
    throw new ConfigError(`${configPath}: letter.date_format must be "iso" or "day-month-year"`);
  }
  const base = dirname(configPath);
  const local = (p) => (isAbsolute(p) ? p : join(base, p));

  const template = raw.template ?? {};
  for (const key of ['tex', 'reference_pdf', 'body_marker', 'identity_end_marker', 'title_anchor']) {
    if (!template[key]) throw new ConfigError(`${configPath}: template.${key} is required`);
  }

  let databasePath = process.env.CAREER_OPS_EVIDENCE_DB;
  if (!databasePath) {
    const pathFile = local(raw.database?.path_file ?? 'career-database.path');
    if (raw.database?.path) databasePath = local(raw.database.path);
    else if (existsSync(pathFile)) databasePath = readFileSync(pathFile, 'utf8').trim();
    else throw new ConfigError(`${configPath}: no evidence database (set database.path, ${pathFile}, or CAREER_OPS_EVIDENCE_DB)`);
    if (!isAbsolute(databasePath)) databasePath = resolve(base, databasePath);
  }
  if (!existsSync(databasePath)) throw new ConfigError(`Evidence database not found: ${databasePath}`);

  const overridesFile = raw.overrides?.file ? local(raw.overrides.file) : null;
  const overrides = overridesFile && existsSync(overridesFile) ? readJson(overridesFile) : {};

  const templatePath = local(template.tex);
  const referencePdf = local(template.reference_pdf);
  for (const p of [templatePath, referencePdf]) {
    if (!existsSync(p)) throw new ConfigError(`Template file not found: ${p}`);
  }

  return {
    ...DEFAULTS,
    ...(raw.limits ?? {}),
    configPath,
    root,
    templatePath,
    referencePdf,
    bodyMarker: template.body_marker,
    identityEndMarker: template.identity_end_marker,
    titleAnchor: template.title_anchor,
    sections: template.sections ?? ['SUMMARY', 'SKILLS', 'EXPERIENCE', 'PROJECTS'],
    databasePath,
    overridesFile,
    overrides,
    replacements: raw.overrides?.replacements ?? [],
    forbiddenOutput: raw.overrides?.forbidden_output ?? [],
    candidateName: raw.candidate?.name ?? null,
    letterDateFormat,
    providers: raw.providers ?? {},
  };
}

/** Apply `{key}` placeholders from verified overrides into a replacement string. */
export function fillOverride(text, overrides) {
  return text.replace(/\{([a-z0-9_]+)\}/gi, (whole, key) => {
    if (overrides[key] === undefined) throw new ConfigError(`Override "${key}" is not defined`);
    return String(overrides[key]);
  });
}
