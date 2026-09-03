---
id: 0345
title: Tuval lives at `apps/tuval` as a runnable local app, never as a shared package or a second repo
status: accepted
date: 2026-09-03
tags: [repo-shape, tuval, apps]
---

# 0345 — Tuval lives at `apps/tuval` as a runnable local app, never as a shared package or a second repo

**What this decides:** the rebuilt Tuval (kernel, shell and the box programs) is a directory under `apps/`, and `apps/` now means one runnable app per directory, where a local app has no alchemy stack and never deploys.

## Context

Wayfinding map [#7364](https://github.com/kamp-us/phoenix/issues/7364) cleared on 2026-09-02 and graduated into five specs on milestone #52 (kernel #7496, Pi session #7497, Claude SDK session #7498, shell #7499, engine view #7500). The migration ruling on grilling #7495 is "replace beside itself": a fresh Tuval built to the program/process contract, importing nothing from the frozen POC on PR #7190. Five planners were about to decompose those specs, and nothing in the corpus said where the new code lives. The POC branch used `packages/tuval`; the kernel spec repeated that out of habit.

Neither existing shape fits. `packages/` is shared internal libraries that `apps/web` and the CLIs import; Tuval is a thing you run, not a thing anything imports. [ADR 0057](0057-multi-app-multi-worker-repo.md) defines `apps/` as one Cloudflare Worker per app, each owning an `alchemy.run.ts` stack and a per-app stage; Tuval is a local Node server plus a browser page, the founder's "Neovim plus tmux for processes, in a browser", and it never deploys to Cloudflare. A second repository, the way `kamp-us/demlik` is one, is the plausible end state for a tool that is not a kamp.us product, but the spikes, rulings, pipeline and campaign all live here, and splitting now would split the lanes.

The founder ruled on 2026-09-02: "i think it can go apps/tuval yeah."

## Decision

**Tuval lives at `apps/tuval`, and `apps/` is widened to mean one runnable app per directory.**

- A directory under `apps/` is an app because a person runs it, not because Cloudflare hosts it. A deployed app carries its own `alchemy.run.ts` and per-app stage exactly as 0057 says; a local app carries neither, and its absence is the marker that the app never deploys.
- `apps/tuval` holds the kernel, the shell, and the programs that ship in the box (Pi session, Claude SDK session, engine view) as plugin directories inside it. They are plugins through the same registry row as any third-party program; living inside the app directory says only that they are in the box.
- Nothing under `packages/` is Tuval. Tuval may depend on workspace packages the way `apps/web` does; no workspace package depends on `apps/tuval`.
- The POC on branch `epic/7140` keeps its `packages/tuval` path untouched. It is a frozen oracle, and citations to it in the five specs point at the branch, never at main.

**Binding constraints.**

- Deploy fans out over the apps declared in `.github/app-roster.json`, not over directories. A local app is never added to the roster, so `deploy.yml` never sees it; no "skip if no stack" branch is needed.
- `README`/`DEVELOPMENT.md` describe `apps/` as "one runnable app per directory; deployed apps own an alchemy stack, local apps do not." The "one worker per app" sentence in `CLAUDE.md` is amended to match when `apps/tuval` first lands.
- Moving Tuval to its own repository is a later ADR, taken when the first slice ships and the tool has users outside this repo. It is not taken by a planner.

## Consequences

- Five epics plan against one path. `plan-epic` on #7496 through #7500 writes children under `apps/tuval/...` with no invented location.
- 0057's principle stands; only its definition of "app" widens. Its stack, stage and secret rules apply to every app that deploys and to none that does not.
- Only `catalog-guard` covers `apps/tuval` from its first commit (it scans every workspace member). `readme-guard` scans `packages/*` alone and `fanout-guard` is wired to `apps/web/worker/features`, so neither applies. Widening `readme-guard` to `apps/*` is filed as [#7504](https://github.com/kamp-us/phoenix/issues/7504) and is not assumed by this ADR; until it lands, `apps/tuval`'s README is a review obligation, not a guard.

## Records

no vocabulary impact
