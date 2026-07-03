---
id: 0133
title: Lever-guard — TTY + interactive confirm hard-refuse on `cf-utils flag set --execute`
status: accepted
date: 2026-07-02
tags: [cf-utils, release, authz, security]
---

# 0133 — Lever-guard: TTY + interactive confirm hard-refuse on `cf-utils flag set --execute`

## Context

This is a conversation-authored decision made by the founder — the ADR [0075](0075-issueless-doc-pr-merge-seam.md) exception — resolving triaged issue [#1763](https://github.com/kamp-us/phoenix/issues/1763).

ADR [0083](0083-agents-deploy-humans-release.md) draws the release boundary: **agents deploy, humans release.** But that boundary is enforced only at the **SKILL** level — the human-only guard lives in `/release`, a skill an agent chooses to run. The **LEVER** (the tool that actually flips the flag, `cf-utils flag set --execute`) has no guard of its own.

That was tolerable only because agents had no ambient Cloudflare credentials to run the lever with. Once ambient keychain Cloudflare creds exist — via the #1730 token-paste path or the #1761 browser-OAuth path — `cf-utils flag set --execute` becomes runnable by **any** shell caller, an autonomous agent included. At that point the skill-level guard is bypassable: an agent that never invokes `/release` can still call the lever directly and flip a flag live, silently defeating the humans-release boundary. This is the #1763 fork.

A grounded finding shapes the fix (from the #1763 framing): a **repo-wide grep found NO agent or pipeline path invokes `cf-utils flag set`.** Agents dark-ship by setting a flag default-off at code/config time (ADR [0083](0083-agents-deploy-humans-release.md) §3), never by running the live-flip lever. So `--execute` is a **single-purpose human-release lever with zero legitimate agent callers** — a hard-refuse of the agent path costs that path nothing.

## Decision

Enforce the humans-release boundary at the **LEVER layer** (option **b**, tool-layer hard-refuse). The convention-only option **a** — trust the skill-level guard and document that agents must not call the lever — was **REJECTED**: a documented convention an ambient-credentialed agent can bypass is not a boundary.

`cf-utils flag set --execute` refuses to run unless **BOTH** hold:

1. **stdin is an interactive TTY** — this structurally refuses TTY-less callers, which is exactly the shape of an autonomous agent or a CI runner. No credential check, no allow-list, no identity assertion: the absence of a terminal is the signal.
2. **an interactive `flip <flag> live? [y/N]` confirmation passes** — a deliberate human keystroke at the moment of release.

This is the **same invariant class and the same refuse-shape** as `ship-it` refusing to self-merge a §CP control-plane PR (ADR [0053](0053-control-plane-boundary.md)): structural enforcement over trusted convention — *make invalid states unrepresentable*, applied to the release boundary. The release lever is not "agents shouldn't"; it is "agents structurally can't."

**Fail-safe direction.** Refusing a TTY-less **human** (recoverable — re-run in a terminal) is strictly safer than silently allowing an **agent** to flip a flag live (not recoverable — users have already seen the feature). The guard fails toward refusal.

**Escape hatch.** The only path through is **TTY presence + interactive confirm.** No `--i-am-human`-style override flag was chosen — a flag is a string an agent can pass, which reduces the guard back to a convention; a TTY is a structural property of the invoking process that an agent does not have.

## Consequences

- **The humans-release boundary holds structurally at the lever, not just by skill-level convention** — an ambient-credentialed agent that skips `/release` and calls the lever directly is still refused.
- **Non-`--execute` (dry-run) paths are unaffected** — reads and dry-runs stay open to any caller; only the live-write branch is guarded.
- **The guard IMPLEMENTATION is a separate follow-up: [#1781](https://github.com/kamp-us/phoenix/issues/1781).** This ADR is the decision record; #1781 builds the TTY + interactive-confirm refuse on the `--execute` write branch in `packages/cf-utils`. That change is `packages/**` → **non-§CP** → auto-ships on `review-code` PASS.
- **Relates to / refines:** ADR [0083](0083-agents-deploy-humans-release.md) (agents deploy, humans release — this pushes its boundary down from the skill to the lever), ADR [0053](0053-control-plane-boundary.md) (the refuse-shape it mirrors). Unblocked by the ambient-creds paths #1730 / #1761, which are the reason the lever becomes agent-runnable.
