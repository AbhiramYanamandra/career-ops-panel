# Notices

This repository combines two MIT-licensed projects and adds an application pipeline on top of them. Each keeps its own license and attribution.

| Component | Source | Version used | License |
|---|---|---|---|
| career-ops (everything outside `pipeline/` and `vendor/`) | https://github.com/career-ops-hq/career-ops, by santifer and contributors | v1.38.0, commit `115bc98` | MIT, see `LICENSE` |
| hiring-panel-skill (`vendor/hiring-panel-skill/`, and the verbatim copies in `.claude/skills/hiring-panel/` and `.agents/skills/hiring-panel/`) | https://github.com/alexyc9381/hiring-panel-skill, by Alex Chen (@nocodealex) | See `vendor/hiring-panel-skill/UPSTREAM.txt` | MIT, see `vendor/hiring-panel-skill/LICENSE` |

The reviewer prompts in `pipeline/lib/panel.mjs` are adapted from the hiring-panel skill, mainly to request structured output. Panel reports keep the attribution line the skill requires:

> Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media

The files under `pipeline/`, `PIPELINE.md` and this notice are additions in this repository and are released under the MIT license in `LICENSE`.
