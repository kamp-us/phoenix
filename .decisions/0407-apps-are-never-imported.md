---
id: 0407
title: An app under `apps/` is never imported, so code another package needs ships as a package
status: accepted
date: 2026-09-23
tags: [repo-shape, apps, packages, tuval, sdk, publishing]
---

# 0407 — An app under `apps/` is never imported, so code another package needs ships as a package

**What this decides:** nothing may depend on or import an app. Code that another package, or an
outside author, needs lives in a package under `packages/`. Apps take `@kampus-apps/*` names. For
Tuval this means the program-author API is the Tuval SDK, `@kampus/tuval-sdk`, published to npm,
with the chat UI and each AI harness in their own packages beside it.

## Context

[ADR 0345](0345-tuval-lives-under-apps.md) put Tuval at `apps/tuval` and said "Nothing under
`packages/` is Tuval". That held until Tuval grew an authoring API for third-party programs
([#8943](https://github.com/kamp-us/phoenix/issues/8943)). Then five workspace packages
(tuval-worktree, tuval-cron, tuval-notify, tuval-shell, tuval-boot-proof) depended on the app through
`workspace:` and imported its `./authoring`, `./window`, `./sessions` and `./ai-agent/ports` subpaths.
An app cannot be published, so an outside author had nothing to install. Nothing stopped a package
from reaching deeper into the app either. [ADR 0359](0359-tuval-window-renderer-is-a-module-specifier.md)
had already recorded the gap: "`@kampus/tuval` is private with no entry point to import them from ...
Whether and how an authoring surface is published is a separate decision".

Epic [#9646](https://github.com/kamp-us/phoenix/issues/9646) moved that code out. Grilling session
[#9648](https://github.com/kamp-us/phoenix/issues/9648) holds its rounds. The founder's rulings on the
epic, on #9648 and on two decisions beside it are what this record transcribes:

- Apps are never imported, and apps use `@kampus-apps/*` names from now on
  ([#9646 brief, 2026-09-22](https://github.com/kamp-us/phoenix/issues/9646)).
- The package is the Tuval SDK and ships to npm. Every piece of it answers one question: can an
  outside author install it, write a program and test it without the desk app
  ([ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5786411028)).
- The harness backends leave the SDK, the SDK depends on no harness vendor SDK, each harness is its
  own package, and there is no umbrella package and no optional peer
  ([ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5786512905),
  [ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5786542049); #9648 R1.6).
  Claude's `agent/`, `tools/` and `history/` import the Claude Agent SDK, so they go to the Claude
  package and only `src/ai-agent/` goes to the SDK
  ([ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5786600386); #9648 R2.3).
- The SDK has a public kernel entry, documented unstable, so the desk uses the SDK through public
  exports only ([ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5786558538);
  #9648 R1.7).
- The chat UI and shared agent window go to `@kampus/tuval-ui`, the SDK stays React-free, and
  `@kampus/design` is published as well
  ([ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5786626040); #9648 R2.4).
- The desk supplies the one SDK copy in its process, and a program declares the SDK versions it
  supports ([#9670 ruling](https://github.com/kamp-us/phoenix/issues/9670#issuecomment-5789628069),
  applied to this epic's packages in
  [this note](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5789628328)).
- The SDK's npm name is `@kampus/tuval-sdk`, not `@kampus/tuval`. That name is kept for the desk app
  when it ships to npm ([ruling](https://github.com/kamp-us/phoenix/issues/9646#issuecomment-5789978561)).
- A config author imports `TuvalConfigInput` from a stable `@kampus/tuval-sdk/config` entry, never
  from the kernel entry
  ([#9717 ruling](https://github.com/kamp-us/phoenix/issues/9717#issuecomment-5799169578)).

This record amends 0345 in part. 0345's "Nothing under `packages/` is Tuval" and its "never as a
shared package" title no longer hold: Tuval's generic code is now packages. The rest of 0345 stands.
The desk is still a local app at `apps/tuval`, a local app still has no stack and never deploys, and
moving Tuval to its own repository is still a later decision. This record also answers the
publishing question 0359 left open, and amends it in part for that reason alone.

## Decision

**An app under `apps/` is never imported, and code that anything outside the app needs ships as a
package under `packages/`.**

1. **No package depends on or imports an app.** An app is something a person runs. It may depend
   on packages. No package, test or config outside the app may list it in a dependency field or
   import it. An app exposes no module door: its `exports` map carries only `./package.json`.
2. **Generic code ships as a package.** When a second consumer needs code that lives in an app, the
   code moves into a package. The app then uses that package through its public exports, the way an
   outside project would. It never uses a relative path into the package's source.
3. **An app's package name is `@kampus-apps/<name>`.** The scope marks it as never importable.
   `@kampus/*` names belong to packages.
4. **The Tuval SDK is `@kampus/tuval-sdk`, at `packages/tuval`, published to npm.**
   - It carries the program-author API: `./authoring` (with `testProgram`), `./window` (the window
     renderer contract) and `./ai-agent/ports`. It also carries the shared AI-agent runtime from
     `src/ai-agent/` without its React window, and the kernel the desk runs on.
   - It depends on no React, no `@kampus/design` and no harness vendor SDK. Its runtime dependencies
     are `effect` and `@demlik/tea`.
   - `./config` is a stable entry carrying `TuvalConfigInput`, the type a `tuval.config.ts` default
     export satisfies.
   - `./kernel/*` is public and **unstable**: any kernel module by its path. It exists so the desk
     app uses the SDK through exports alone. A kernel module may move or change in any release, and
     a program should need nothing from it.
5. **The desk chat UI is `@kampus/tuval-ui`.** It holds `shell/chat`, the shared agent window
   (`ai-agent/window`) and the desk, key, page and palette pieces they need. It depends on
   `@kampus/design` and peer-depends on the SDK.
6. **Each AI harness is its own package**: `@kampus/tuval-claude`, `@kampus/tuval-codex`,
   `@kampus/tuval-pi` and `@kampus/tuval-agy`. Each is built only on the public exports of the SDK
   and `@kampus/tuval-ui`. Living in this repository is what makes a harness an official plugin.
   A config takes a session row from the harness package, for example `claudeSession` from
   `@kampus/tuval-claude`. There is no `@kampus/tuval/sessions` and no umbrella AI package.
7. **A plugin package peer-depends on the SDK, never optionally.** `@kampus/tuval-ui` and the harness
   packages list `@kampus/tuval-sdk` under `peerDependencies`. They never bundle it or pin their own
   copy, because the desk supplies the one copy a process holds.

**Binding constraints.**

- The app-boundary guard ([#9660](https://github.com/kamp-us/phoenix/issues/9660),
  `packages/app-boundary-guard`) enforces rule 1 in CI. Weakening it needs a record that supersedes
  this one.
- Program identity strings are durable data, not npm names. A row's `identity.package` stays
  `"@kampus/tuval"` for the programs that ship in the box, and a checkpoint written under it still
  restores.
- `@kampus/tuval` names the desk app on npm once it ships there
  ([#9679](https://github.com/kamp-us/phoenix/issues/9679)). Until then no package takes that name,
  and in the workspace the app is `@kampus-apps/tuval`.
- Each published package follows the [ADR 0332](0332-fabrika-pi-ships-as-npm-package.md) shape:
  built at release time, `dist` only, a README, and a public-surface test over the packed exports
  map. Publishing itself is a step the founder triggers.

**Banned.**

- An `@kampus-apps/*` name in any dependency field outside `apps/`, or an import of one.
- A React, `@kampus/design` or harness vendor SDK dependency on `@kampus/tuval-sdk`.
- A doc or README that teaches a program author an import from `@kampus/tuval-sdk/kernel/*` as the
  way to do something a stable entry already does.

## Consequences

- An outside author can `npm i @kampus/tuval-sdk`, write a program and run its tests with no path
  into phoenix. The packed-tarball proof ([#9654](https://github.com/kamp-us/phoenix/issues/9654),
  `packages/tuval/proof/`) checks this in CI.
- The tuval-* packages import the SDK by `@kampus/tuval-sdk/*` specifiers, and their configs take
  session rows from the harness packages.
- The SDK owes stability on `./authoring`, `./window`, `./ai-agent/ports` and `./config`, and on
  nothing else. Moving the config type later would break every config, which is why it has a
  stable entry.
- `apps/web` is still named `@kampus/web`, and `packages/fts-backfill` and
  `packages/preview-seed` still depend on it. Rules 1 and 3 apply to it too, but the founder ruled
  the web imports out of #9646's scope. Until the app is renamed and
  those imports move, the guard's `@kampus-apps/*` match does not see them.
- The desk app still carries a worked program (`apps/tuval/src/example/pr-review.ts`) and the
  app-side tests of the authoring layer (`apps/tuval/src/sdk-consumer/`). That is the app using
  the SDK, not an SDK home, so neither sits under a directory named `authoring`.

## Records

Vocabulary routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) in this change: the
`@kampus-apps/*` app scope, "Tuval SDK", "Tuval UI package" and "harness package". The `apps/tuval`
row now names `@kampus-apps/tuval`.
