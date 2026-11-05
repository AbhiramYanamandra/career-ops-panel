# The hiring panel skill

You apply to dozens of jobs and never find out why companies say no. This skill tells you first: seven Claudes try to
reject your resume, then it rebuilds your resume with every mistake fixed. Free, MIT, no signup, no API key.

Made by **Alex Chen** ([@nocodealex](https://instagram.com/nocodealex)), an AI creator who builds free Claude Code skills. Full guide: [chen.media](https://chen.media/guides/run-your-resume-past-7-claudes-that-try-to-reject-it-set-up-the-free-hiring-panel-skill).

## The panel

1. **The automated screen** decides if a human even sees your resume: can it be read, are titles and dates clear,
   which of the job's key terms are missing. PASS or REJECT, with the lines it's about.
2. **The hiring manager** decides if you get the interview, and says what decided it in the first ten seconds.
3. **Five readers, alone.** Nobody sees anybody else's notes: the hiring manager (can you do the job on day one?),
   another applicant (where is your resume weaker than mine?), the CEO (what did you change, and by how much?), the
   recruiter (30 seconds, top third only) and a teammate (how do you work with others?). HIRE, MAYBE or PASS each.

Then it merges everything into one list of mistakes, worst first, **rebuilds your resume with every one fixed**
(same facts, nothing invented), and runs the automated screen again to show the before and after verdict.

Everything goes in `.hiring-panel/` where you run it: `PANEL.md` and `RESUME-IMPROVED.md`.

## Install

Paste this into Claude Code:

```
https://github.com/alexyc9381/hiring-panel-skill
Install this skill, then confirm /hiring-panel works.
```

Or as a plugin:

```
/plugin marketplace add alexyc9381/hiring-panel-skill
/plugin install hiring-panel-skill@hiring-panel-skill
```

Or copy `skills/hiring-panel` into `~/.claude/skills/`. Open a new Claude Code session afterwards.

## Use

```
/hiring-panel ~/Documents/resume.pdf  Senior product designer at a fintech startup
```

Paste the job posting after your resume for the sharpest read. One run is eight sub-agent calls and counts toward
your Claude plan's usage.

## Good to know

- It never invents employers, titles, dates or numbers. Where a fix needs a fact it doesn't have, it leaves
  `[ADD: ...]` and asks you.
- It's a structured second opinion made by language models. It doesn't guarantee an interview.
- It is not made by Anthropic.

Run the tests with `python3 -m unittest discover -s tests`.

## Making a video or post about this?

Go ahead. Credit it like this, in your caption or description:

```text
/hiring-panel skill by Alex Chen (@nocodealex): github.com/alexyc9381/hiring-panel-skill
```

Tag [@nocodealex](https://instagram.com/nocodealex) so I can see it. Every file the skill writes already ends with
the same credit, so leave it in the shot.

Writing about it or citing it in a paper? Use **Cite this repository** in the sidebar on GitHub.
