---
name: gh-issue
description: >-
  Interview the user exhaustively, then draft and file GitHub issues with the
  gh CLI. Write a product-level issue (problem, goal, scope, non-goals, and
  acceptance criteria), never implementation detail. Use the app's sequential
  interactive-question cards: ask exactly one decision at a time, with a
  proposed answer. Do not file until every needed decision has an answer or a
  user-approved assumption, the complete playback is confirmed, the draft is
  reviewed, and the no-open-questions gate passes.
---

# GitHub Issue Writer

File GitHub issues that read like a product ask, not a design document, and
leave the reader with nothing to guess. Research the codebase privately,
interview the human thoroughly, and publish something short, plain, and fully
decided. Research and interview inform the issue; neither appears verbatim.

## Standing rules

1. **No open questions.** Do not file until every decision the issue depends on
   has been explicitly asked and answered by the user, or proposed by you and
   accepted by the user. An unresolved question is a blocker.
2. **Product level only.** Never put paths, directories, line numbers,
   function/class/struct/table/migration names, framework or library choices,
   or an implementation plan in the issue.

## Method

1. **Frame the request.** Restate the request and item type (bug, feature,
   chore/task, or spike). If it combines distinct capabilities or defects,
   confirm one issue per capability (the default) or a combined issue.
2. **Confirm the target.** Identify the repo (`git remote -v`, `gh repo view`),
   check `gh auth status`, and inspect issue templates or CONTRIBUTING guidance.
   A repository template wins, and the interview must cover every required field.
3. **Research before interviewing.** Privately investigate related behavior,
   comparable conventions, feasibility, genuine product forks, and duplicate or
   adjacent issues (`gh issue list --search "<keywords>"`). Do not ask what the
   codebase can answer and do not leak implementation in the issue.
4. **Interview to exhaustion.** Use the bank below, skipping only answers known
   from the request or research and stating they are taken as given.
5. **Play back and lock.** Before drafting, restate every decision in a compact,
   numbered list grouped by issue section. Mark delegated decisions `ASSUMED:`.
   Ask for confirmation or corrections; loop until confirmed.
6. **Draft, show, and gate.** Draft with the template, run the gate, and show
   the whole draft before filing unless the user explicitly pre-authorized
   publishing without review.
7. **File via gh.** Write the body to a temporary file and use `gh issue create
   --body-file <file>` (or `gh issue edit <n> --body-file <file>`). Apply the
   confirmed title, labels, assignee, and milestone in the same call. For edits,
   fetch the existing body first.
8. **Report concisely.** Give the issue number/URL, a one-line summary, and any
   user-approved assumptions.

## Sequential interactive interview

Use this Web app's interactive-question capability for every interview and
confirmation decision. **Ask exactly one card at a time; wait for its persisted
answer before asking the next card.** Never send a batch or multi-question card.

- Give every card one single-barreled question and a proposed answer from
  research. Prefer closed choices where the space is enumerable.
- Mark a decision `[blocking]` when it changes issue shape and `[refining]`
  when it changes wording. Blocking decisions require an answer; refiners may
  use the proposed answer only after the user approves it.
- Ask in the user's language and keep questions non-technical. Do not leak
  implementation while asking.
- If an answer is already known, record it as taken-as-given rather than asking.
  If the user says “you decide,” record an `ASSUMED:` playback item and require
  playback sign-off. Re-ask an unanswered required decision before progressing.
- The same sequential-card rule applies to framing confirmation, playback,
  draft review, authorization, and the no-open-questions gate.

## Question bank

Draw from every applicable group. Skip only what is already answered, and say
so. Propose the best answer you can from research for each decision.

### A. Framing — always

1. Repository and item type? 2. Proposed plain-language title? 3. Who feels it?
4. Why now? 5. What happens today? 6. Cost of doing nothing? 7. Frequency and
affected population? 8. Existing workaround and whether it is tolerable?

### B. Bug reports — additionally

9. Plain-language reproduction steps? 10. Expected versus actual result?
11. Did it ever work? 12. Affected platform/version/account/configuration?
13. Frequency and triggering conditions? 14. Damage and recovery? 15. Urgency?
16. User-visible error, screenshot, or recording? Keep logs and stacks out of
the product statement.

### C. Feature requests — additionally

17. What becomes true after shipping? 18. Ideal start-to-finish user story?
19. Starting product surface? 20. Inputs and outputs? 21. Zero-config default?
22. Configuration and who controls it? 23. Visibility and access? 24. Behavior
in empty, first-run, high-volume, offline/failure, and concurrent states?
25. Undo/cancel/retry? 26. Error experience? 27. Success confirmation?
28. Stored result, retention, and deletion? 29. User-visible limits?
30. Day-one effect on existing users/data? 31. Required surfaces?
32. Accessibility, localization, offline expectations? 33. Usage visibility?

### D. Scope and boundaries — always

34. Included work? 35. Explicit non-goals (name adjacent asks)? 36. One issue
or several? 37. Smaller first version? 38. Dependencies or blockers? 39. Date,
milestone, or event?

### E. Acceptance — always

40. Exact completion check? 41. Convincing demo? 42. Required metric?
43. Sign-off owner? 44. Documentation, changelog, or support notes?

### F. Safety, privacy, and risk — screen always

45. Personal/sensitive/regulated data? 46. Destructive or irreversible action?
47. Access change? 48. Third party or data leaving the product?
49. Legal, contractual, or compliance constraint?

### G. Filing logistics — always

50. Approve/rewrite proposed title? 51. Labels, assignee, milestone, board?
52. Related issues, PRs, or discussions? 53. File now or review a draft?
54. Public/private information to exclude? 55. House style, template, tone, or
language?

## No-open-questions gate

Before calling `gh`, verify every item. Any failure returns to the interview.

- [ ] Every included template section is fully populated; omissions are deliberate and known.
- [ ] Every acceptance criterion is plain-language, checkable, and unambiguous.
- [ ] No TBD/TODO/maybe/undecided language, hedging, or trailing questions remains.
- [ ] Every surfaced edge case has defined behavior or a named non-goal.
- [ ] Non-goals name specific rejected adjacent asks.
- [ ] No implementation detail appears anywhere.
- [ ] Title, labels, assignee, milestone, playback, and assumptions are confirmed.
- [ ] The user reviewed the full draft, unless they explicitly pre-authorized filing without review.

## Issue template

Use these headings in this order, adapting to the item. If the repository has a
template, follow it and map these ideas onto its fields:

- `## Problem / Motivation` — plain-language impact, audience, frequency.
- `## Current Behavior` *(bugs)* — current behavior and user-level steps.
- `## Goal` — one or two sentences describing success.
- `## Scope` — included behavior and settled edge cases.
- `## Non-goals` — specific rejected adjacent asks.
- `## Security / Safety Considerations` — only real implications, no mechanism.
- `## Acceptance Criteria` — checkable plain-language checklist.
- `## Suggested Phasing` — only for large features.
- `## Deferred Decisions` — rare; only deliberate deferrals with owner and date.

Never add an Open Questions section; if one is needed, the interview is not done.

## Fast path and authorization

If the user says “don't ask me, just file it,” research and decide the whole
bank, then use sequential cards to confirm each assumption, playback, and draft
review before filing. If the user pre-authorizes filing without review, file
only after the gate and report the assumptions afterward.

Creating or editing an issue is a visible shared-system action. Treat an
explicit request to create/file/open an issue as authorization only after the
gate passes. If the request is exploratory or it is unclear whether to file or
draft, ask before `gh issue create`.

## Not for

- PR descriptions, commit messages, code comments, or internal design docs.
- Triage or labeling existing issues; use a dedicated triage workflow.
