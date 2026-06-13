---
id: 0045
title: kampus Client CLI — One Authenticated Surface for Humans and Agents
status: proposed
date: 2026-06-13
tags: [cli, auth, tooling, agents]
---

# 0045 — kampus Client CLI — One Authenticated Surface for Humans and Agents

## Context

ADR [0044](0044-imge-media-architecture.md) (imge) settled that non-browser agents
authenticate via better-auth's `apiKey` plugin against the pasaport user — a durable,
revocable credential, unlike the ~7-day browser session bearer. What 0044 deliberately
**did not** answer is *how an agent obtains and presents that credential* (its Decision 3
keys the object to "whatever better-auth resolves" and stops there). Without an answer,
every product that wants agent or human access from a terminal re-invents login,
credential storage, and request signing — the brittle-by-hand failure ADR
[0035](0035-cli-conventions.md) was written to kill, just on the client side instead of
the repo side.

There is also a category gap. ADR [0035](0035-cli-conventions.md) governs **repo/dev
tooling**: independent maintainer tools (the migration runner, the `phoenix-fate`
scaffolder) that share nothing, so a catch-all `cli` package would become a graveyard. Its
ban on a mega-`cli` is correct *for that category*. But it never contemplated **client
tooling** — a tool a human or agent runs to hit the authenticated, deployed kamp.us API.
Client tooling has the opposite property from 0035's dev tools: every subcommand shares
**one identity and one credential**, and that shared core is the whole reason to unify
rather than fragment. Read literally, 0035 could be cited to forbid a unified client CLI;
that would be a misreading, and this ADR draws the boundary so no future agent makes it.

Constraints and prior art on `main`:

- **pasaport is the identity.** better-auth runs in `worker/features/pasaport/` with the
  `bearer` plugin today; the `apiKey` table is migrated but the plugin is **not yet
  enabled** — ADR [0044](0044-imge-media-architecture.md) Decision 3 is what turns it on.
  This CLI is a **consumer** of that decision, not a precondition for it.
- **künye does not exist.** Agents-as-first-class-registered-identities with their own
  keys live in the unbuilt künye epic ([#41](https://github.com/kamp-us/phoenix/issues/41)).
  Until it lands, an agent has no identity of its own — it borrows a human's. This CLI must
  **not** take a hard dependency on künye.
- **The first client CLI.** The monorepo already builds focused *repo* CLIs per
  [0035](0035-cli-conventions.md). `kampus` is the first tool in the *client* category;
  there is no existing client-auth or credential-store code to reuse.

## Decision

phoenix builds a single **`kampus` client CLI** — the one authenticated surface humans and
automated agents use to talk to the deployed kamp.us API. It is a **distinct category** from
ADR [0035](0035-cli-conventions.md)'s repo tools, and 0035's "no catch-all `cli`" ban does
not extend to it.

1. **Git-shaped subcommands, auth built in like `gh`.** Invocation is
   `kampus <product> <verb>` — e.g. `kampus imge upload ./shot.png` — mirroring git's
   product/verb structure. Identity is part of the same binary, not a sibling tool:
   `kampus auth login`, like `gh auth login`. The bin name is `kampus` and the package name
   mirrors the bin per [0035](0035-cli-conventions.md)'s name-mirrors-bin rule (the one 0035
   convention that *does* carry across the category boundary).

2. **Auth is a shared core, established once; subcommands never re-implement it.**
   `kampus auth login` authenticates against pasaport (the app's better-auth instance) and
   persists the resulting credential under `~/.config/kampus/`. Every product subcommand
   reads that one stored credential and presents it to the API; a subcommand that mints or
   stores its own credential is **banned**. This shared-identity core is the reason `kampus`
   is unified rather than fragmented — and the reason 0035's anti-graveyard argument does not
   apply: these subcommands are not independent tools sharing nothing, they share the single
   most load-bearing thing a client has.

3. **The credential is a better-auth `apiKey`; the PAT is the primary headless path.**
   The stored credential is a better-auth `apiKey` (ADR [0044](0044-imge-media-architecture.md)
   Decision 3) — durable and revocable. There are two ways to obtain one:
   - **`kampus auth login`** runs a browser-assisted flow (device-code or magic-link) for an
     interactive human, then stores the resulting `apiKey`.
   - **A profile-settings personal-access-token (PAT)**, copy-pasted (`kampus auth token`,
     or `KAMPUS_TOKEN` env), for headless/agent use.

   For an **unattended agent the PAT is the primary flow**, not a fallback: `auth login`
   assumes a browser an unattended agent does not have (see open questions). The CLI reads
   the credential from, in order: an explicit flag, `KAMPUS_TOKEN`, then the stored
   `~/.config/kampus/` credential.

4. **`kampus auth` answers 0044's open "how does an agent get a credential" question.**
   The split is: `kampus auth` issues/stores the `apiKey`; `kampus imge upload` consumes it.
   That closes the loop 0044 Decision 3 left open without imge — or any future product —
   owning auth.

5. **Agent-owned identity defers to künye / [#41](https://github.com/kamp-us/phoenix/issues/41).**
   In v1 an agent borrows a human's login or PAT; uploads and writes are attributed to that
   human's pasaport user. When künye lands it can issue agents their own registered keys, at
   which point `kampus auth` gains an agent-registration path. v1 takes **no** dependency on
   künye.

6. **Subcommands are statically compiled in for v1; no plugin model yet.** Products are added
   to `kampus` by extending the binary, the same way a new verb is added to `phoenix-fate`
   under [0035](0035-cli-conventions.md). A dynamic third-party plugin model is **deferred and
   explicitly out of scope** — see open questions; it is the one place 0035's graveyard risk
   could re-enter, and v1 does not open that door.

## Consequences

- **Easier:** one place a human or agent logs in and one credential every product reuses; the
  imge agent-upload story from [0044](0044-imge-media-architecture.md) becomes runnable
  (`kampus auth token` once, `kampus imge upload` thereafter); new products get terminal access
  for free by adding a subcommand, with auth already solved; the `report`/`triage` skills can
  shell out to `kampus imge upload` instead of carrying bespoke upload code.
- **Harder / new cost:** the first client-side credential store (file layout, refresh, logout,
  multi-account); a browser-assisted device/magic-link flow that does not exist yet; keeping
  the CLI's API contract in step with the worker as products evolve; deciding monorepo-vs-own-
  package distribution (see open questions).
- **Banned:** a per-product auth implementation; a subcommand that stores its own credential; a
  catch-all *repo* `cli` (0035 still holds for dev tooling — `kampus` is a client tool, not a
  loophole to fold migration/scaffolder verbs into); a hard v1 dependency on künye; a dynamic
  plugin/extension system in v1.
- **Relationship to [0035](0035-cli-conventions.md):** `kampus` does **not** violate 0035 — it
  is a different category (client vs repo tooling) 0035 never covered. 0035 is **amended in part
  by 0045** to record that its no-catch-all ban is scoped to repo/dev tooling and that client
  tooling unifies around shared identity. (See "On annotating 0035" — the amendment is a scope
  clarification, the decision text of 0035 is unchanged.)
- **Deferred:** künye-based agent registration and agent-owned keys (pending
  [#41](https://github.com/kamp-us/phoenix/issues/41)); a dynamic subcommand/plugin model;
  non-pasaport identity providers.

### Open questions (resolve before / during build, not blocking ratification)

- **Headless auth is the weak seam.** `kampus auth login` via device-code/magic-link assumes a
  browser; an unattended agent has neither browser nor inbox. If the PAT is genuinely the
  primary agent flow (Decision 3 says it is), then `auth login` is mostly a *human* convenience,
  and the device/magic-link flow should be scoped accordingly — possibly deferred behind the PAT
  path for v1 rather than built first. Decide which flow ships in v1.
- **Credential storage security.** A plaintext `apiKey`/PAT under `~/.config/kampus/` is the
  simplest store and matches agent ergonomics (an agent can read a file; it cannot unlock a
  keychain non-interactively). But plaintext-at-rest is a real exposure (backups, dotfile sync,
  shoulder-surfing). OS-keychain storage is safer for humans but hostile to headless agents.
  Likely answer: file store with `0600` perms as the baseline, keychain as an opt-in for human
  installs — but confirm, and state the threat model explicitly.
- **Distribution / naming.** Monorepo workspace package vs an independently published npm package
  — the client CLI is consumed *outside* the repo (by agents and humans on their own machines),
  which pulls toward a published package, unlike 0035's repo-internal tools. Settle the
  `kampus` package/bin coordinates and the release path.
- **Extensibility = the graveyard risk, deferred not solved.** Static compile-in (Decision 6) is
  the safe v1 choice, but as products multiply the binary grows; revisit whether a plugin model
  is warranted before it becomes a forced migration, and define what "a product is in `kampus`"
  requires so the bar is explicit rather than accretive.
- **Credential ↔ user lifecycle.** What happens to a stored `apiKey` when the pasaport user is
  deleted, or the key is revoked server-side — does the CLI detect a dead credential and prompt
  re-login, or fail opaque? (Ties into 0044's still-to-specify deletion/GC semantics.)
