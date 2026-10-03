# CLAUDE.md - jev-soc-bench

Local benchmark and dashboard comparing TypeSafe Jev with a generative LLM
(`openai/gpt-4o-mini`) on SOC alert triage, both called through OpenRouter.

The full specification is `plan.md` at the repository root. Read it before starting any
work. Build milestone by milestone (plan.md section 10) and stop at the end of each
milestone to report. `plan.md` is local only and is never committed.

---

## 1. Hard rules

- **JavaScript only.** ES modules, Node.js 22.9 or later. No Python, no TypeScript, no
  build step. Zero runtime dependencies; `@playwright/test` is the only dev dependency.
- **Never commit or push `.env`, `plan.md` or `issue.md`.** They are listed in
  `.gitignore`. Before every commit, run `git status` and
  `git check-ignore -v .env plan.md issue.md`; all three must be reported as ignored and
  none may appear as staged. Stage files by name rather than with `git add -A`.
- **No paid API calls** except the ones a milestone explicitly calls for (M2 smoke test,
  M5 full run, M8 batching experiment), and only when the owner asks for them in the
  current session. Tests never touch the network; providers are tested with an injected
  `fetchImpl`.
- **The OpenRouter key never leaves the server side.** It must not appear in logs, error
  messages, results files, the browser, or committed files.
- **Synthetic data only.** IPs from the RFC 5737 documentation ranges, `example.com` /
  `example.net` domains, invented user names. No real telemetry.
- **No emoji** anywhere: code, comments, commit messages, documentation, UI text,
  terminal output.
- **Do not push** unless the owner asks. Commit locally.

---

## 2. Definition of done - applies to every task, however small

1. Run `npm test` after every change, not only at the end. In your reply, state the
   command you ran and the pass/fail counts.
2. New behaviour comes with tests. A bug fix comes with a test that fails before the fix
   and passes after it.
3. If the change touches the runner, providers, engine, policy or metrics, also run
   `npm run bench:mock` and confirm it completes and writes a valid results file.
4. If the change touches the server or dashboard, run the server tests and start the
   server once (`npm start`) to confirm it serves the page.
5. Run `git status` and confirm no ignored file is staged.

Never report a task as done with failing tests. Never skip, delete or weaken a test to
make it pass: if a test is wrong, say so, log it in `issue.md`, and fix it as its own item.

---

## 3. Engineering principles

**Measure before refactoring.** Before changing working code, record the current numbers
(test count and time, mock-run output, metric values on a fixed results file). After the
change, record them again and report both. A refactor that changes a metric is not a
refactor; it is a behaviour change and must be explained.

**Distrust silent defaults.** No fallback may hide missing data. Examples in this
project:
- A missing `usage.cost` is shown as "unavailable", never as 0.
- A missing `OPENROUTER_API_KEY`, `JEV_MODEL` or `LLM_MODEL` stops the run with a clear
  error; it is not replaced by a hard-coded value.
- A missing answer field is a `schema_error`, not a default value.
Any default that is deliberate must be documented in `plan.md` and recorded in the run
`meta`.

**An output that never varies is a bug, not a feature.** In this project that means:
- if, across a live or mock run, a provider gives the same answer to a question for every
  alert (the same queue for all 40, the same quarantine probability, the same blast-radius
  value), or
- a metric comes out identical for both providers,
treat it as a defect until proven otherwise. The usual cause is normalisation reading the
wrong field, or a fallback filling every record with the same value.
`tests/no_constant_outputs.test.js` enforces this on fixtures, and `metrics.js` adds a
`warnings` entry to the run summary (also printed by the runner) when it happens on real
data.

**Verify claims against the artifacts.** Do not trust a summary, a log line, the README
or `plan.md` over the data. Before stating any number - in a reply, the README or the
dashboard copy - recompute it from the records in `results/*.json`, and check
`rawResponse` when an answer looks wrong. Do not describe a feature as working unless a
test or a run shows it working. Where documentation and code disagree, that is a defect
and goes in `issue.md`.

---

## 4. Issue tracking - `issue.md`

`issue.md` lives at the repository root, is local only, and is the single list of known
defects and planned improvements. Create it with the structure below if it does not
exist.

```
# Issues

## Priority summary

| ID | Severity | Title | Section |
|:--|:--|:--|:--|

## 1. F-n - <title>
## 2. F-n - <title>
...

## Completed improvements

## Appendix A - Fixed defects

| ID | Title | Fixed on | Commit | Covering tests |
|:--|:--|:--|:--|:--|
```

Severities, in this order:

| Severity | Meaning |
|:--|:--|
| Critical | Key or ignored file exposed; unplanned paid calls; published results that are wrong. |
| High | A metric, label comparison or policy decision computed incorrectly. |
| Medium | Wrong behaviour with a workaround, or a missing check from plan.md. |
| Low | Cosmetic, wording, minor inconsistency. |
| Improvement | Planned enhancement, tracked like a defect. |

**Found a bug.** Give it the next free ID (`F-1`, `F-2`, ...; IDs are never reused). Add
a row to the Priority summary, which stays sorted by severity. Write its own section with
`file:line` evidence and the failing case: input, expected result, actual result, and the
command that reproduces it. This applies to anything noticed in passing, not only to what
was asked for.

**Fixed a bug.** Delete its Priority summary row (the summary lists open items only).
Remove its section and renumber the remaining sections and their references in the
summary. Add it to the Appendix A table, and below the table write up the root cause, the
measured before/after, and the tests that now cover it.

**Planned an improvement.** Tracked exactly like a defect: next free `F-n`, a Priority
summary row with severity Improvement, its own section. When done, delete the summary
row, move the section to "Completed improvements" with what was measured before and
after, and renumber.

Never leave a resolved ID in the Priority summary, and never leave a found defect only in
the conversation.

---

## 5. Commands

| Command | What it does | Paid calls |
|:--|:--|:--|
| `npm test` | All tests, no network | 0 |
| `npm run bench:mock` | Full benchmark on mock providers | 0 |
| `npm run smoke` | One live call per provider, prints raw responses | 2 |
| `npm run bench -- --dry-run` | Prints the run plan, no network | 0 |
| `npm run bench` | Full live benchmark (asks for confirmation) | see plan.md |
| `npm start` | Local dashboard on 127.0.0.1 | 0 unless `--allow-live` |

---

## 6. Commits

Small commits, one concern each, imperative message ("Add Jev provider"), no emoji.
Tests pass before every commit. Reference the issue ID when a commit fixes or implements
one ("Fix F-3: ...").
