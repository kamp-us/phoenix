---
id: 0470
title: Screen review is one repo setting with three values, and a repo that has said nothing starts at skip
status: accepted
date: 2026-10-04
tags: [fabrika, review-ui, config, onboarding]
---

# 0470 — Screen review is one repo setting with three values, and a repo that has said nothing starts at skip

**What this decides:** a repo answers how its screens are reviewed with one setting: by a hosted
preview, by an owner's hand-check, or not at all because screen review is not set up. A new repo
starts at the third, and a run that skips the screen check says so.

Founder ruling, 2026-10-04, on
[#10520](https://github.com/kamp-us/phoenix/issues/10520):
[the ruling comment](https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868).
This record transcribes it; the choice is not the author's.

## Context

An earlier founder ruling on
[#10362](https://github.com/kamp-us/phoenix/issues/10362#issuecomment-5974640994) said "Skipping the
screen check is not an option." Setup therefore wrote a hand-check rule into every new app, and the
guides promised the owner a screenshot ask on every screen change.

That promise did not hold. A rule is read only over files that raise the `ui` class, and a file
raises it only under a declared `uiSurfaces` row. A new repo declares no row, and a row needs a
start command a single `index.html` does not have. So in a new repo the screen check was already
skipped, and nothing said so: an issue labelled `class:ui` was built, reviewed as code and merged
in one run, and nobody was asked to look at the screen.

The ruling on #10520 replaces the one on #10362. No decision record transcribed the #10362 ruling,
so this record supersedes none.
[ADR 0396](0396-head-diff-decides-a-review-rounds-classes.md) stands unchanged: once a pull request
exists its own files decide the classes, and an issue's `class:ui` label does not overrule them.

## Decision

**Screen review is one repo-level setting with three values — preview, hand-check and skip — and a
repo that has said nothing resolves to skip.**

- **Preview.** The reviewer opens a hosted copy of each pull request. A screen change with no
  preview is not reviewed until one exists.
- **Hand-check.** An owner looks at the screen and posts a screenshot on the pull request.
- **Skip.** Screen review is not set up. A screen change gets the text review only, owes no
  rendered verdict, and is never stopped, failed or sent to repair for lack of one.

The setting is `reviewUi.mode` in `.fabrika.jsonc`, with the values `preview`, `hand-check` and
`skip`. The ruling left the key name and spellings to the builder.

**An unset repo.** A repo that declares no `reviewUi.mode`, no `uiSurfaces` row, no
`reviewUi.screens` path and no `reviewUi.whenNoPreview` rule resolves to skip. A repo that declares
any of the last three and no mode keeps what it did before the setting existed: its screens are
reviewed by preview, and its `whenNoPreview` rules still set the mode path by path. This second
sentence is how triage read "a repo that has said nothing"; it keeps an existing adopter from being
moved to skip by an upgrade.

**A skipped screen check is never silent.** A run that ships a screen change at skip ends by saying
the screen check was skipped because screen review is not set up, and names the one step that turns
it on. The sentence is printed by the CLI and relayed by the skill.

**The guides document it.** They say a new repo starts with screen review off, and give the one
step that turns it on.

**Binding constraints.**

- Skip is a value a repo holds, never a per-run choice. No flag skips the screen check on one pull
  request of a repo set to preview or hand-check.
- A pull request cannot loosen its own gate: where its head and its merge base resolve different
  values, the stricter one judges it.
- Turning hand-check on never reports success in a repo where no pull request could trigger it.
- At skip, triage writes no acceptance criterion that only an image can meet.

## Consequences

A newcomer does nothing about screen review and is told plainly when it was skipped. Turning it on
is one command that records where the screens live, with no start command.

Skip and a `whenNoPreview` rule cannot both be declared: one says no screen review is owed, the
other says what one path owes. The config refuses the pair.

A repo that ran the old setup step and declares no `uiSurfaces` row holds a hand-check rule no pull
request can trigger. It is not at skip, so no run tells it so; re-running the step names what to
add. Stopping for the owner before review in a hand-check repo stays with
[#10502](https://github.com/kamp-us/phoenix/issues/10502).
