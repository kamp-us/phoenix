---
id: 0142
title: "kampus-pipeline bot-credential resolution: org-derived config paths, per-operator App keys, and the three-rung upgrade ladder (local path → secret-manager content → CF token-broker)"
status: superseded by [0143](0143-reject-phoenix-bot-authorship.md)
date: 2026-07-03
tags: [pipeline, pipeline-cli, github-app, credentials, security, control-plane, multi-org, epic-1934]
---

# 0142 — kampus-pipeline bot-credential resolution: org-derived paths, per-operator keys, upgrade ladder

> **Superseded by [0143](0143-reject-phoenix-bot-authorship.md).** This bot-credential convention served the phoenix[bot] authorship direction, which is rejected as a zero-human §CP self-merge hole.

## Context

The kampus-pipeline plugin is repo-agnostic and serves **N orgs** (kamp-us, binclusive, …) — ADR 0062. The phoenix[bot] provisioning epic (#1934, decided by ADR [0140](0140-phoenix-bot-authors-pipeline-prs-team-cp.md)) introduces a per-org GitHub App whose installation token the pipeline mints on demand via the #1938 helper (`pipeline-cli bot-token`: App-private-key → RS256 JWT → installation access token). That raises a resolution question the epic must settle **once, as a convention**, before the helper and its consumers (PR-open, ship-it enqueue) are wired: *given a repo, where does an operator's machine find the right org's App credentials — and how does that scale across many orgs, many operators, and many machines without hardcoding one org or sprawling long-lived private keys?*

This ADR records that convention. It is deliberately a **sibling** to the #1938 helper code (not bundled): the resolution rule is a standing convention that outlives any one helper implementation.

## Decision

### 1. Credential resolution is ORG-DERIVED, never hardcoded

The target org is derived from the **repo owner** (the `owner` of `owner/repo`, the same resolution the plugin already uses for `$CLAUDE_PIPELINE_REPO`). Credentials are then looked up in a **per-org config directory that lives outside every repository** — never inside a checkout, never committed, never a hardcoded single-org path.

### 2. The path convention

Per-org credentials live under the operator's XDG config dir:

```
$XDG_CONFIG_HOME/kampus-pipeline/<org>/     (default $HOME/.config/kampus-pipeline/<org>/)
├── config.json        # App ID, installation ID, and non-secret resolution metadata
└── private-key.pem     # the operator's own App private key (mode 600)
```

`<org>` is the repo owner (e.g. `kamp-us`, `binclusive`). The directory is outside every repo and git-ignored by construction (it is not under any repo root); `private-key.pem` is `chmod 600`. The helper resolves `<org>` from the repo, reads `config.json` for the non-secret App/installation identifiers, and reads the key per §4.

### 3. Per-org App, PER-OPERATOR key — no pem ever transferred

One GitHub App per org, installed on that org's repos. Each **operator mints their OWN private key**: GitHub Apps support multiple simultaneous private keys, so every operator/machine generates a distinct key for the same App. Consequences:

- **No pem is ever transferred** between operators or machines — nothing to copy, intercept, or leak in transit.
- **Keys are independently revocable.** A compromised or retired operator's key is deleted at GitHub without touching any other operator; blast radius is one operator, not the org.
- The App identity (and thus the bot authorship + team-approval semantics of ADR 0140) is shared; only the *signing key* is per-operator.

### 4. The three-rung upgrade ladder — the #1938 helper rides all three non-breakingly

The #1938 helper accepts the private key as **either a path or inline content** (`--private-key` taking a file path OR the key material on stdin/flag). That one input contract lets the credential source climb a ladder without any change to the helper or its consumers:

- **Rung 1 — per-machine local path (current).** The helper reads `private-key.pem` from the org-derived config dir (§2). Simplest; the standing default. The key sits on the operator's disk at mode 600.
- **Rung 2 — shared secret manager (content input).** The key is held in a secret manager (1Password, Vault, CF secret store, …) and piped to the helper as **content** via `--private-key`, so no pem is written to disk on the machine. Same helper, different source.
- **Rung 3 — CF token-broker Worker per org (target for CF-hosted orgs).** A per-org Cloudflare Worker holds the pem as a **CF secret**; an Access-gated endpoint mints short-lived GitHub installation tokens; the CLI pulls an **ephemeral token, never the pem**. Zero pem on any operator machine. This is the target posture for both CF-hosted orgs (kamp-us + binclusive) and is filed as a scoped design follow-up. The helper reaches rung 3 unchanged: it already accepts a ready install token, or content — the broker just replaces the local mint step.

Each rung strictly reduces standing secret exposure (pem on disk → pem in a manager → no pem anywhere on a machine). Because the helper's input contract is stable across all three, an org can climb the ladder at its own pace with **no breaking change** to the pipeline.

## Consequences

- **This convention gates the #1938 helper and its consumers** (PR-open cutover, ship-it enqueue) in epic #1934: they resolve credentials by this rule, not by any hardcoded path. It composes with ADR 0140 — the App identity is what makes bot-authorship + team-based §CP approval work; this ADR only settles where each operator's *key* for that App lives.
- **Rung 3 (the CF token-broker) is a separate scoped design follow-up**, filed for triage — not built here. Rungs 1–2 are reachable with the #1938 helper as specified; rung 3 is the security target for the CF-hosted orgs.
- **Security posture:** least standing secret (a per-operator key at mode 600 today, trending to no on-machine pem), org-scoped isolation (a key compromise is one operator in one org), and per-operator revocation independent of every other operator. No shared long-lived secret, no pem in any repo, no single-org hardcoding.
- **Portability:** the org-derived rule keeps the plugin genuinely N-org (ADR 0062) — adding an org is a new `<org>` config dir + its App, no code change.
