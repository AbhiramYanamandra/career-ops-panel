#!/usr/bin/env node
// Command line for the application pipeline and the standalone hiring panel.
// Ordinary career-ops commands are untouched and keep working on their own.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { listTree } from '../lib/walk-tree.mjs';
import { USER_PATHS } from '../update-system.mjs';
import { REPO_ROOT, dataRoot, loadConfig, runsDir } from './lib/config.mjs';
import { advance, createRun, listRuns, loadManifest, recordAnswer } from './lib/engine.mjs';
import { PanelNeedsHost, runPanel } from './lib/panel.mjs';
import { createProvider } from './lib/providers.mjs';
import { hasCommand, run, slugify, todayLocal } from './lib/util.mjs';

const USAGE = `career-ops application pipeline

Integrated workflow:
  node pipeline/cli.mjs start --jd-file <file> [--url <url>] [--provider claude|codex|host] [--panel-provider claude|codex|host] [--model <id>] [--effort <level>]
  node pipeline/cli.mjs start --url <url> [...]
  node pipeline/cli.mjs resume <run> [--provider ...] [--panel-provider ...]
  node pipeline/cli.mjs status [run]
  node pipeline/cli.mjs next <run>                     show what a host agent must do next
  node pipeline/cli.mjs answer <run> "<text>"          record your answer to a question
  node pipeline/cli.mjs answer <run> --jd-file <file>  supply a job description that could not be read

Standalone hiring panel (any resume, with or without a job):
  node pipeline/cli.mjs panel --resume <pdf|md|txt> [--job <file> | --role "<role>"] [--provider claude|codex|host] [--name <name>] [--out <dir>]

Setup:
  node pipeline/cli.mjs setup                          declare fork paths for the updater and check tools
  node pipeline/cli.mjs setup --from <career-ops dir>  also copy your user layer from another checkout (never overwrites)
  node pipeline/cli.mjs setup --example                install the fictional sample template and database

Nothing here submits an application, fills a form or sends a message.
`;

const OPTIONS = {
  'jd-file': { type: 'string' },
  url: { type: 'string' },
  provider: { type: 'string' },
  'panel-provider': { type: 'string' },
  implementation: { type: 'string' },
  model: { type: 'string' },
  'panel-model': { type: 'string' },
  effort: { type: 'string' },
  'panel-effort': { type: 'string' },
  resume: { type: 'string' },
  job: { type: 'string' },
  role: { type: 'string' },
  name: { type: 'string' },
  out: { type: 'string' },
  from: { type: 'string' },
  example: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function resolveRun(arg) {
  if (!arg) throw new Error('Name a run. List them with: node pipeline/cli.mjs status');
  const direct = resolve(arg);
  if (existsSync(join(direct, 'manifest.json'))) return direct;
  const named = join(runsDir(dataRoot()), arg);
  if (existsSync(join(named, 'manifest.json'))) return named;
  throw new Error(`No run named ${arg}`);
}

function providersFrom(values, manifest, cfg) {
  const agentName = values.provider ?? manifest?.providers?.agent ?? cfg.providers.default ?? 'claude';
  const panelName = values['panel-provider'] ?? manifest?.providers?.panel ?? agentName;
  const options = (name, model, effort) => ({
    ...cfg.providers[name],
    forcedModel: model,
    forcedEffort: effort,
    implementation: values.implementation,
  });
  return {
    names: { agent: agentName, panel: panelName },
    provider: createProvider(agentName, options(agentName, values.model, values.effort)),
    panelProvider: createProvider(panelName, options(panelName, values['panel-model'] ?? values.model, values['panel-effort'] ?? values.effort)),
  };
}

function report(manifest, runDir, asJson) {
  if (asJson) { console.log(JSON.stringify(manifest, null, 2)); return; }
  const line = (k, v) => { if (v !== undefined && v !== null && v !== '') console.log(`${k.padEnd(12)} ${v}`); };
  line('Run', manifest.run_id);
  line('Directory', runDir);
  line('Status', manifest.status);
  if (manifest.job?.company) line('Role', `${manifest.job.role}, ${manifest.job.company}`);
  if (manifest.report?.score !== undefined) line('Fit', `${manifest.report.score}/5 (${manifest.report.decision ?? 'see report'})`);
  if (manifest.workflow?.tier) line('Path', manifest.workflow.tier);
  if (manifest.usage?.calls) line('AI calls', manifest.usage.calls.length);
  const finished = Object.entries(manifest.stages).filter(([, s]) => ['done', 'skipped'].includes(s.status)).length;
  line('Stages', `${finished}/${Object.keys(manifest.stages).length} finished`);
  if (manifest.status === 'failed') {
    console.log(`\nFAILED at ${manifest.error.stage}:\n${manifest.error.message}\n\nFix the cause, then: node pipeline/cli.mjs resume ${manifest.run_id}`);
  }
  if (manifest.status === 'stopped') console.log(`\nStopped (${manifest.stop_reason.reason}): ${manifest.stop_reason.message}`);
  if (manifest.status === 'awaiting_user') {
    console.log(`\nNeeds your answer (${manifest.waiting.reason}): ${manifest.waiting.question}\nThen: node pipeline/cli.mjs answer ${manifest.run_id} "<answer>" && node pipeline/cli.mjs resume ${manifest.run_id}`);
  }
  if (manifest.status === 'awaiting_agent') printNext(manifest);
  if (manifest.status === 'complete') {
    console.log(`\nFinal documents:\n  ${manifest.final.resume_pdf}\n  ${manifest.final.letter_pdf}\nSummary: ${join(runDir, 'SUMMARY.md')}\nNothing has been submitted.`);
  }
  if (manifest.warnings?.length) console.log(`\nWarnings:\n${manifest.warnings.map((w) => `- ${w}`).join('\n')}`);
}

function printNext(manifest) {
  const w = manifest.waiting;
  if (!w) { console.log('Nothing is waiting on a host agent.'); return; }
  if (w.panel_tasks?.length) {
    console.log(`\nPanel work for independent agents. Give each agent ONLY its prompt file, never the database or another reviewer's output. Save each raw answer to its output file, then resume.`);
    for (const t of w.panel_tasks) console.log(`- ${t.id}\n    prompt: ${t.prompt_file}\n    output: ${t.output_file}`);
    return;
  }
  if (w.task_file) console.log(`\nNext task: ${w.stage}\n  brief:  ${w.task_file}\n  output: ${w.output_file} (${w.format})\nWrite the output file, then: node pipeline/cli.mjs resume ${manifest.run_id}`);
}

async function cmdStart(values) {
  const root = dataRoot();
  const cfg = loadConfig(root);
  const jobText = values['jd-file'] ? readFileSync(resolve(values['jd-file']), 'utf8') : null;
  if (!jobText && !values.url) throw new Error('start needs --jd-file or --url');
  const { names, provider, panelProvider } = providersFrom(values, null, cfg);
  const created = createRun({ root, cfg, jobText, url: values.url, providers: names });
  if (created.existing) console.log(`Resuming the existing run for this posting: ${created.id}`);
  const manifest = await advance(created.runDir, { root, cfg, provider, panelProvider });
  report(manifest, created.runDir, values.json);
  process.exitCode = manifest.status === 'failed' ? 1 : 0;
}

async function cmdResume(values, args) {
  const root = dataRoot();
  const cfg = loadConfig(root);
  const runDir = resolveRun(args[0]);
  const { provider, panelProvider } = providersFrom(values, loadManifest(runDir), cfg);
  const manifest = await advance(runDir, { root, cfg, provider, panelProvider });
  report(manifest, runDir, values.json);
  process.exitCode = manifest.status === 'failed' ? 1 : 0;
}

function cmdStatus(values, args) {
  if (args[0]) {
    const runDir = resolveRun(args[0]);
    report(loadManifest(runDir), runDir, values.json);
    if (!values.json) {
      for (const [id, s] of Object.entries(loadManifest(runDir).stages)) {
        console.log(`  ${s.status.padEnd(9)} ${id}${s.skip_reason ? ` (${s.skip_reason})` : ''}${s.error ? ` (${s.error.split('\n')[0]})` : ''}`);
      }
    }
    return;
  }
  const runs = listRuns(dataRoot());
  if (values.json) { console.log(JSON.stringify(runs, null, 2)); return; }
  if (!runs.length) { console.log('No runs yet.'); return; }
  for (const r of runs) console.log(`${r.run}  ${r.status.padEnd(14)} ${r.score ?? '-'}/5  ${r.role ?? ''} ${r.company ? `(${r.company})` : ''}`);
}

function cmdAnswer(values, args) {
  const runDir = resolveRun(args[0]);
  const jdText = values['jd-file'] ? readFileSync(resolve(values['jd-file']), 'utf8') : null;
  if (!args[1] && !jdText) throw new Error('answer needs text or --jd-file');
  recordAnswer(runDir, { text: args[1], jdText });
  console.log(`Recorded. Continue with: node pipeline/cli.mjs resume ${basename(runDir)}`);
}

function readResume(path) {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`Resume not found: ${full}`);
  if (full.toLowerCase().endsWith('.pdf')) {
    const res = run('pdftotext', ['-layout', full, '-']);
    if (res.status !== 0) throw new Error(`Could not read the PDF: ${res.stderr}`);
    return res.stdout;
  }
  return readFileSync(full, 'utf8');
}

async function cmdPanel(values) {
  if (!values.resume) throw new Error('panel needs --resume');
  const resumeText = readResume(values.resume);
  const jobText = values.job ? readFileSync(resolve(values.job), 'utf8') : null;
  let role = values.role;
  if (!jobText && !role && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    role = (await rl.question('What job are you applying for? (Enter to review it generally) ')).trim();
    rl.close();
  }
  const name = values.name ?? slugify(basename(values.resume).replace(/\.[^.]+$/, ''));
  const workDir = resolve(values.out ?? join('.hiring-panel', `.work-${todayLocal()}-${slugify(name)}`));
  const providerName = values.provider ?? 'claude';
  const provider = createProvider(providerName, { model: values.model, implementation: values.implementation });
  let result;
  try {
    result = await runPanel({ resumeText, jobText, role, provider, workDir, name });
  } catch (err) {
    if (err instanceof PanelNeedsHost) {
      printNext({ waiting: { panel_tasks: err.tasks } });
      console.log(`\nThen run the same panel command again with --out ${workDir}`);
      return;
    }
    throw err;
  }
  // The skill's own folder layout: PANEL.md and RESUME-IMPROVED.md side by side.
  const finalDir = values.out ? dirname(result.panelFile) : resolve('.hiring-panel', `${todayLocal()}-${slugify(name)}`);
  if (!values.out) {
    mkdirSync(finalDir, { recursive: true });
    copyFileSync(result.panelFile, join(finalDir, 'PANEL.md'));
    copyFileSync(result.improvedFile, join(finalDir, 'RESUME-IMPROVED.md'));
  }
  if (values.json) { console.log(JSON.stringify({ reviewers: result.reviewerSummary, implementations: result.implementations, dir: finalDir }, null, 2)); return; }
  console.log(result.reviewerSummary.join('\n'));
  console.log('\nFive worst mistakes:');
  for (const i of result.merged.issues.slice(0, 5)) console.log(`${i.id}. "${i.quote ?? ''}": ${i.why}`);
  console.log(`\nAutomated screen: ${result.verdicts['automated-screen'].verdict} before, ${result.rescreen.verdict} after the rewrite`);
  console.log(`Reviewer implementation: ${[...new Set(Object.values(result.implementations).map((i) => i.runtime))].join('; ')}`);
  console.log(`Files: ${finalDir}`);
}

/** Paths this repository adds to career-ops, declared so updates leave them alone. */
const FORK_PATHS = ['pipeline/', 'vendor/', 'PIPELINE.md', 'NOTICE.md'];

function declareForkPaths(root) {
  const file = join(root, 'config', 'local-paths.txt');
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '# Fork-owned paths: the career-ops updater never touches these.\n';
  const missing = FORK_PATHS.filter((p) => !current.split('\n').map((l) => l.trim()).includes(p));
  if (missing.length) writeFileSync(file, `${current.trimEnd()}\n${missing.join('\n')}\n`);
  return missing;
}

/** Copy a file or tree, keeping anything already at the destination. */
function copyMissing(from, to, skip, copied) {
  const pairs = statSync(from).isDirectory()
    ? listTree(from, { skip }).map((file) => [file, join(to, relative(from, file))])
    : [[from, to]];
  for (const [source, target] of pairs) {
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(target);
  }
}

function cmdSetup(values) {
  const root = dataRoot();
  const declared = declareForkPaths(REPO_ROOT);
  // Panel output holds a personal resume; keep it out of git even if .gitignore is reset.
  const exclude = join(REPO_ROOT, '.git', 'info', 'exclude');
  if (existsSync(dirname(exclude))) {
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!current.includes('.hiring-panel/')) writeFileSync(exclude, `${current.trimEnd()}\n.hiring-panel/\n`);
  }
  console.log(declared.length ? `Declared fork paths for the updater: ${declared.join(', ')}` : 'Fork paths already declared for the updater.');

  if (values.from) {
    const source = resolve(values.from);
    if (!existsSync(join(source, 'AGENTS.md'))) throw new Error(`${source} does not look like a career-ops checkout`);
    const copied = [];
    const skip = (entry) => entry.isDirectory() && ['node_modules', 'application-runs', '.git'].includes(entry.name);
    for (const entry of [...USER_PATHS, '.env']) {
      if (entry.startsWith('.career-ops-web') || entry.startsWith('.claude/')) continue;
      const from = join(source, entry);
      if (existsSync(from)) copyMissing(from, join(root, entry), skip, copied);
    }
    console.log(`Copied ${copied.length} user-layer file(s) from ${source}. Existing files were kept. The source was only read.`);
  }

  if (values.example) {
    const target = join(root, 'data', 'resume-template');
    if (existsSync(join(target, 'pipeline.json'))) console.log('data/resume-template/pipeline.json already exists; the example was not installed.');
    else {
      cpSync(join(REPO_ROOT, 'pipeline/examples/resume-template'), target, { recursive: true, force: false });
      console.log('Installed the fictional example into data/resume-template/. Replace it with your own template and database.');
    }
  }

  const tools = ['tectonic', 'pdftotext', 'pdftoppm', 'pdfinfo', 'pdffonts'];
  const missing = tools.filter((t) => !hasCommand(t));
  console.log(missing.length ? `Missing tools: ${missing.join(', ')} (install tectonic and poppler)` : 'Document tools found.');
  const reviewers = ['claude', 'codex'].filter(hasCommand);
  console.log(reviewers.length ? `Reviewer runtimes found: ${reviewers.join(', ')}` : 'No reviewer runtime found: install claude or codex, or use --provider host.');
  try {
    const cfg = loadConfig(root);
    console.log(`Config: ${cfg.configPath}\nDatabase: ${cfg.databasePath}\nTemplate: ${cfg.templatePath}`);
  } catch (err) {
    console.log(`Config not ready: ${err.message}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...args] = positionals;
  if (values.help || !command) { console.log(USAGE); return; }
  const commands = {
    start: () => cmdStart(values),
    resume: () => cmdResume(values, args),
    status: () => cmdStatus(values, args),
    next: () => printNext(loadManifest(resolveRun(args[0]))),
    answer: () => cmdAnswer(values, args),
    panel: () => cmdPanel(values),
    setup: () => cmdSetup(values),
  };
  if (!commands[command]) throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  await commands[command]();
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
