// Deterministic page fitting. Writers return a ranked content bank: entries and
// bullets are ordered strongest first. We render the full bank, then use a
// binary search over complete lowest-ranked removals to find the fullest fit.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildResume } from './documents.mjs';
import { validatePayload } from './evidence.mjs';
import { writeJson } from './util.mjs';

export function removeLowestRanked(payload) {
  for (const section of ['projects', 'experience']) {
    const entries = payload[section];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].bullets.length > 1) {
        const bullet = entries[i].bullets.pop();
        entries[i].evidence_ids.pop();
        return { section, source_id: entries[i].source_id, bullet };
      }
      if (entries.length > 1) {
        const [entry] = entries.splice(i, 1);
        return { section, source_id: entry.source_id, entry: true };
      }
    }
  }
  return null;
}

export function fitResumePayload(payload, ctx, stem) {
  const candidates = [{ payload: structuredClone(payload), removed: [] }];
  while (candidates.length <= 100) {
    const previous = candidates.at(-1);
    const next = structuredClone(previous.payload);
    const item = removeLowestRanked(next);
    if (!item) break;
    candidates.push({ payload: next, removed: [...previous.removed, item] });
  }
  const trialDir = ctx.path(`${stem}-fit`);
  const trialStem = join(trialDir, 'trial');
  try {
    const render = (index) => {
      const built = buildResume(candidates[index].payload, trialStem, ctx, validatePayload);
      if (built.ok) {
        return { fits: true, layout: built.layout };
      }
      if (built.stage === 'layout' && built.layout?.info?.pages > 1) return { fits: false };
      throw new Error(`Resume fitting stopped at ${built.stage}: ${built.errors.join('; ')}`);
    };
    let low = 0;
    let high = candidates.length - 1;
    let chosen = null;
    let chosenLayout = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const result = render(mid);
      if (result.fits) { chosen = mid; chosenLayout = result.layout; high = mid - 1; }
      else low = mid + 1;
    }
    if (chosen === null) throw new Error('Resume still exceeds one page after all lower-ranked complete items were trimmed');
    const fitted = candidates[chosen];
    const output = { payload: fitted.payload, removed: fitted.removed, page_fill: chosenLayout.page_fill,
      below_target: chosenLayout.page_fill < ctx.cfg.min_page_fill };
        writeJson(ctx.path(`${stem}.fit.json`), {
          removed: output.removed, page_fill: output.page_fill, below_target: output.below_target,
          method: 'ranked full bank, binary search over complete lowest-ranked removals; no model calls',
        });
        return output;
  } finally {
    rmSync(trialDir, { recursive: true, force: true });
  }
}
