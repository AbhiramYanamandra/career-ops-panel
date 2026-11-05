// Rendering and rendered-document checks for the resume and cover letter.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fillOverride } from './config.mjs';
import { evidenceText, isCleared, numberIsIn, numbersIn, plain } from './evidence.mjs';
import { ensureDir, formatLetterDate, run, squash, writeJson } from './util.mjs';

export function texEscape(s) {
  return String(s)
    .replace(/\\/g, '\u0000')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\u0000/g, '\\textbackslash{}')
    .replace(/–|—/g, '--')
    .replace(/×/g, '$\\times$')
    .replace(/σ/g, '$\\sigma$')
    .replace(/≈/g, '$\\approx$')
    .replace(/→/g, '$\\rightarrow$')
    .replace(/[‘’]/g, "'")
    .replace(/“/g, '``')
    .replace(/”/g, "''");
}

const rich = (s) => String(s)
  .split(/(\*\*[^*]+\*\*)/g)
  .map((p) => (p.startsWith('**') && p.endsWith('**') ? `\\textbf{${texEscape(p.slice(2, -2))}}` : texEscape(p)))
  .join('');

/** Template text up to the body, with the tagline and verified overrides applied. */
export function templatePrefix(cfg, titleOverride) {
  const master = readFileSync(cfg.templatePath, 'utf8');
  if (master.split(cfg.bodyMarker).length !== 2) {
    throw new Error(`Template must contain ${cfg.bodyMarker} exactly once`);
  }
  let prefix = master.slice(0, master.indexOf(cfg.bodyMarker));
  if (!prefix.includes(cfg.titleAnchor)) throw new Error(`Template tagline anchor is missing: ${cfg.titleAnchor}`);
  if (titleOverride) prefix = prefix.replace(cfg.titleAnchor, () => texEscape(titleOverride));
  for (const rule of cfg.replacements) {
    const value = fillOverride(rule.with, cfg.overrides);
    if (!prefix.includes(rule.find)) throw new Error(`Template override anchor is missing: ${rule.find}`);
    prefix = prefix.replace(rule.find, () => texEscape(value));
  }
  return prefix;
}

export function renderResumeTex(payload, cfg) {
  const lines = [templatePrefix(cfg, payload.candidate?.title).trimEnd(), cfg.bodyMarker, `\\plainline{${rich(payload.summary)}}`, '\\sectionline{\\textbf{SKILLS}}'];
  for (const s of payload.skills) lines.push(`\\bulletline{\\textbf{${texEscape(s.category)}:} ${rich(s.items)}}`);
  lines.push('\\sectionline{\\textbf{EXPERIENCE}}');
  for (const e of payload.experience) {
    lines.push(`\\titleline{\\textbf{${texEscape(e.role)}}, ${texEscape(e.company)}, ${texEscape(e.location)}\\hfill \\textit{\\textbf{${texEscape(e.dates)}}}}`);
    for (const b of e.bullets) lines.push(`\\bulletline{${rich(b)}}\\vspace{1pt}`);
  }
  lines.push('\\sectionline{\\textbf{PROJECTS}}');
  for (const p of payload.projects) {
    lines.push(`\\titleline{\\textbf{${texEscape(p.name)}}}`);
    for (const b of p.bullets) lines.push(`\\bulletline{${rich(b)}}`);
  }
  lines.push('\\end{document}', '');
  return lines.join('\n');
}

export function compilePdf(stem) {
  const res = run('tectonic', ['--outdir', dirname(stem), `${stem}.tex`]);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout).split('\n').filter((l) => /error|command not found/i.test(l)).slice(0, 8).join('\n');
    return { ok: false, error: `LaTeX compilation failed for ${basename(stem)}.tex:\n${detail || res.stderr}` };
  }
  const text = run('pdftotext', ['-layout', `${stem}.pdf`, `${stem}.txt`]);
  if (text.status !== 0) return { ok: false, error: `pdftotext failed: ${text.stderr}` };
  const png = run('pdftoppm', ['-r', '110', '-png', '-singlefile', `${stem}.pdf`, `${stem}`]);
  if (png.status !== 0) return { ok: false, error: `pdftoppm failed: ${png.stderr}` };
  return { ok: true };
}

export function pdfInfo(pdf) {
  const out = run('pdfinfo', [pdf]).stdout;
  const size = out.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts(?: \((.+)\))?/m);
  return {
    pages: Number(out.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0),
    width: Number(size?.[1] ?? 0),
    height: Number(size?.[2] ?? 0),
    a4: Boolean(size && Math.abs(Number(size[1]) - 595.28) < 1.5 && Math.abs(Number(size[2]) - 841.89) < 1.5),
  };
}

const pdfFonts = (pdf) => [...new Set(run('pdffonts', [pdf]).stdout.split('\n').slice(2)
  .map((l) => l.trim().split(/\s+/)[0]?.replace(/^[A-Z]{6}\+/, ''))
  .filter(Boolean))];

function textBounds(pdf) {
  const html = run('pdftotext', ['-bbox', pdf, '-']).stdout;
  const words = [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map((m) => ({ xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: m[5] }));
  if (!words.length) return null;
  return {
    xMin: Math.min(...words.map((w) => w.xMin)),
    xMax: Math.max(...words.map((w) => w.xMax)),
    yMax: Math.max(...words.map((w) => w.yMax)),
    words,
  };
}

/**
 * Compare a rendered resume with the approved reference. This catches overflow
 * and drift in fonts, margins and section order. A person or agent still has to
 * look at the image for wraps and overall appearance.
 */
export function inspectResumePdf(pdf, cfg) {
  const errors = [];
  const warnings = [];
  const info = pdfInfo(pdf);
  if (info.pages !== 1) errors.push(`Resume is ${info.pages} pages; it must be one page. Remove the least relevant complete item, and do not shrink type or margins.`);
  if (!info.a4) errors.push(`Resume is not A4 (${info.width} x ${info.height} pts)`);

  const fonts = pdfFonts(pdf);
  const refFonts = pdfFonts(cfg.referencePdf);
  const extraFonts = fonts.filter((f) => !refFonts.includes(f));
  if (extraFonts.length) warnings.push(`Fonts not in the approved reference: ${extraFonts.join(', ')}`);

  const bounds = textBounds(pdf);
  const refBounds = textBounds(cfg.referencePdf);
  let fill = 0;
  if (bounds && refBounds) {
    if (bounds.xMin < refBounds.xMin - 3) errors.push(`Left edge ${bounds.xMin.toFixed(1)}pt is outside the approved margin (${refBounds.xMin.toFixed(1)}pt)`);
    if (bounds.xMax > info.width - refBounds.xMin + 3) errors.push(`Right edge ${bounds.xMax.toFixed(1)}pt overruns the approved margin`);
    if (bounds.yMax > info.height - 2) errors.push('Text runs off the bottom of the page');
    fill = bounds.yMax / info.height;
    if (fill < cfg.min_page_fill) warnings.push(`Page is only ${(fill * 100).toFixed(0)}% full; the approved format is dense`);
  } else errors.push('No extractable text found in the PDF');

  const text = run('pdftotext', ['-layout', pdf, '-']).stdout;
  let cursor = -1;
  for (const section of cfg.sections) {
    const at = text.indexOf(section);
    if (at === -1) errors.push(`Section ${section} is missing from the rendered text`);
    else if (at < cursor) errors.push(`Section ${section} is out of order`);
    else cursor = at;
  }
  const lastLine = text.trim().split('\n').pop().trim();
  if (cfg.sections.includes(lastLine)) errors.push(`Heading ${lastLine} is stranded at the bottom of the page`);
  if (/\[ADD:/.test(text)) errors.push('Rendered resume contains an [ADD: ...] placeholder');
  return { errors, warnings, info, fonts, reference_fonts: refFonts, page_fill: Number(fill.toFixed(3)) };
}

// ---------------------------------------------------------------- cover letter

export function validateLetter(letter, db, cfg, jobText, job = {}) {
  const errors = [];
  if (!Array.isArray(letter?.paragraphs) || letter.paragraphs.length < 3) {
    return ['A full letter needs at least three paragraphs'];
  }
  if (!letter.salutation || !letter.closing) errors.push('Letter needs a salutation and a closing');
  const jobKey = squash(jobText);
  const all = letter.paragraphs.map((p) => plain(p.text)).join(' ');
  if (/\b(?:at|for)\s+\?(?=[\s.,;!?]|$)/i.test(all)) errors.push('Letter uses ? as the employer name');
  const wordCount = all.split(/\s+/).filter(Boolean).length;
  if (wordCount < 180) errors.push(`Letter is ${wordCount} words; a complete role-specific letter needs at least 180`);
  if (wordCount > 480) errors.push(`Letter is ${wordCount} words; keep it under 480`);
  for (const [label, value] of [['company', job.company ?? letter.company], ['role', job.role ?? letter.role]]) {
    if (label === 'company' && value === '?') continue;
    if (value && !squash(all).includes(squash(value)) && !squash(letter.subject ?? '').includes(squash(value))) {
      errors.push(`Letter never names the ${label} "${value}"`);
    }
  }
  letter.paragraphs.forEach((p, i) => {
    const where = `Letter paragraph ${i + 1}`;
    const text = plain(p.text);
    if (/\[ADD:|\{\{|TBD\b/i.test(text)) errors.push(`${where}: contains a placeholder`);
    for (const bad of cfg.forbiddenOutput) if (text.includes(bad)) errors.push(`${where}: contains "${bad}", which the verified overrides replace`);
    const ids = p.evidence_ids ?? [];
    const quotes = p.employer_quotes ?? [];
    if (!ids.length && !quotes.length && p.kind !== 'closing') {
      errors.push(`${where}: cite evidence_ids for candidate claims or employer_quotes for company claims (kind "closing" is exempt)`);
    }
    const records = [];
    for (const id of ids) {
      const record = db.evidenceById.get(id);
      if (!record) errors.push(`${where}: unknown evidence ID ${id}`);
      else if (!isCleared(record)) errors.push(`${where}: ${id} is not cleared for use`);
      else records.push(record);
    }
    for (const quote of quotes) {
      if (!jobKey.includes(squash(quote))) errors.push(`${where}: employer quote is not in the job description: "${quote}"`);
    }
    const source = [...records.map(evidenceText), ...quotes].join(' ');
    for (const number of numbersIn(text)) {
      if (!numberIsIn(number, source)) errors.push(`${where}: number ${number} does not trace to its cited sources`);
    }
  });
  return errors;
}

/** The final letter must tell the same story as the final resume. */
export function checkLetterConsistency(letter, resumeText, payload, db) {
  const errors = [];
  const warnings = [];
  const resume = plain(resumeText).toLowerCase();
  const payloadIds = new Set([...(payload.experience ?? []), ...(payload.projects ?? [])].flatMap((e) => (e.evidence_ids ?? []).flat()));
  const vocab = new Set();
  for (const s of db.raw.skills) vocab.add(s.skill);
  for (const p of [...db.raw.experiences, ...db.raw.projects]) {
    for (const t of String(p.technologies ?? '').split(';')) if (t.trim()) vocab.add(t.trim());
  }
  const contains = (hay, term) => new RegExp(`(?<![a-z0-9+#])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9+#])`).test(hay);

  letter.paragraphs.forEach((p, i) => {
    const where = `Letter paragraph ${i + 1}`;
    const text = plain(p.text);
    const lower = text.toLowerCase();
    const cited = (p.evidence_ids ?? []).map((id) => db.evidenceById.get(id)).filter(Boolean);
    const citedText = cited.map(evidenceText).join(' ').toLowerCase();
    const quotes = (p.employer_quotes ?? []).join(' ').toLowerCase();
    for (const id of p.evidence_ids ?? []) {
      if (!payloadIds.has(id)) warnings.push(`${where}: ${id} supports the letter but is not on the final resume`);
    }
    for (const term of vocab) {
      if (term.length < 2 || !contains(lower, term)) continue;
      if (contains(resume, term) || contains(citedText, term) || contains(quotes, term)) continue;
      errors.push(`${where}: names "${term}", which is on neither the final resume nor the cited evidence`);
    }
    for (const number of numbersIn(text)) {
      if (!numberIsIn(number, resume) && !numberIsIn(number, citedText) && !numberIsIn(number, quotes)) {
        errors.push(`${where}: number ${number} is on neither the final resume nor the cited sources`);
      }
    }
    for (const m of text.matchAll(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/g)) {
      if (!resume.includes(m[0].toLowerCase())) errors.push(`${where}: date "${m[0]}" is not on the final resume`);
    }
    for (const exp of db.raw.experiences) {
      if (!contains(lower, exp.organisation) && !contains(lower, exp.organisation.split(' ').slice(-2).join(' '))) continue;
      if (!contains(resume, exp.organisation)) errors.push(`${where}: discusses ${exp.organisation}, which is not on the final resume`);
    }
  });
  return { errors, warnings };
}

export function letterMarkdown(letter, cfg) {
  const date = letter.date ? `${formatLetterDate(letter.date, cfg.letterDateFormat)}\n\n` : '';
  const head = letter.subject ? `**${letter.subject}**\n\n` : '';
  const body = letter.paragraphs.map((p) => plain(p.text)).join('\n\n');
  return `${date}${head}${letter.salutation}\n\n${body}\n\n${letter.closing}\n${letter.signature ?? ''}\n`;
}

/** The letter's header carries the same tagline as the resume it accompanies. */
export function renderLetterTex(letter, cfg, title) {
  if (!title) throw new Error('A letter needs the tagline of its resume');
  const master = templatePrefix(cfg, title);
  if (!master.includes(cfg.identityEndMarker)) throw new Error(`Template lacks ${cfg.identityEndMarker}`);
  const identity = master.slice(0, master.indexOf(cfg.identityEndMarker)).trimEnd();
  const lines = [
    identity,
    '\\vspace{14pt}\\rule{\\linewidth}{0.7pt}\\vspace{10pt}',
    '\\fontsize{10.5}{14}\\selectfont\\setlength{\\parskip}{8pt}',
  ];
  if (letter.date) lines.push(`\\par ${texEscape(formatLetterDate(letter.date, cfg.letterDateFormat))}`);
  if (letter.subject) lines.push(`\\par\\textbf{${texEscape(letter.subject)}}`);
  lines.push(`\\par ${texEscape(letter.salutation)}`);
  for (const p of letter.paragraphs) lines.push(`\\par ${rich(p.text)}`);
  lines.push(`\\par ${texEscape(letter.closing)}`);
  if (letter.signature) lines.push(`\\par ${texEscape(letter.signature)}`);
  lines.push('\\end{document}', '');
  // A letter needs wider margins than the dense resume; the resume stays untouched.
  return lines.join('\n').replace('\\begin{document}', '\\begin{document}\\newgeometry{top=36pt,bottom=36pt,left=64pt,right=64pt}');
}

/** Render the resume payload: gate, write, compile, inspect. Never hides a failure. */
export function buildResume(payload, stem, ctx, validate) {
  ensureDir(dirname(stem));
  const { errors, warnings, audit } = validate(payload, ctx.db, ctx.cfg);
  writeJson(`${stem}.evidence-audit.json`, {
    database_sha256: ctx.db.sha256,
    limits: 'Automated checks cover IDs, parents, numbers, dates, skills and placeholders. They do not prove a paraphrase is fair; see the review artifact.',
    bullets: audit,
    errors,
    warnings,
  });
  if (errors.length) return { ok: false, stage: 'evidence', errors, warnings };
  writeFileSync(`${stem}.tex`, renderResumeTex(payload, ctx.cfg));
  const compiled = compilePdf(stem);
  if (!compiled.ok) return { ok: false, stage: 'compile', errors: [compiled.error], warnings };
  const layout = inspectResumePdf(`${stem}.pdf`, ctx.cfg);
  writeJson(`${stem}.layout.json`, layout);
  if (layout.errors.length) return { ok: false, stage: 'layout', errors: layout.errors, warnings: [...warnings, ...layout.warnings], layout };
  return { ok: true, warnings: [...warnings, ...layout.warnings], layout };
}

export function buildLetter(letter, stem, ctx, title) {
  ensureDir(dirname(stem));
  writeFileSync(`${stem}.md`, letterMarkdown(letter, ctx.cfg));
  writeFileSync(`${stem}.tex`, renderLetterTex(letter, ctx.cfg, title));
  const compiled = compilePdf(stem);
  if (!compiled.ok) return { ok: false, errors: [compiled.error] };
  const info = pdfInfo(`${stem}.pdf`);
  const errors = [];
  if (info.pages !== 1) errors.push(`Cover letter is ${info.pages} pages; it must fit one page`);
  if (!info.a4) errors.push('Cover letter is not A4');
  return { ok: !errors.length, errors, info };
}
