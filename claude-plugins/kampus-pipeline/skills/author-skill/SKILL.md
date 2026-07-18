---
name: author-skill
description: The authoring-side guide for writing a new kampus skill in the house idiom — the complement to the review-skill gate. Read it before you write a `skills/**/SKILL.md`. It covers the SKILL.md shape (frontmatter name/description contract, prose-first body), the house rules imported from the writing-craft manifest (no Python, no `sources/` tree, no second validator — review-skill already gates), how to author toward review-skill's four rigor checks so the gate passes on the first pass, the gate-skill house-style exemption, and the §CP destination re-check. Trigger on "author a new skill", "write a kampus skill", "how do I add a skill", "what shape should this SKILL.md be", "run author-skill", or whenever you are about to create or substantially rewrite a `skills/**` skill and need the house conventions. This is a reference guide, not a pipeline stage: it never picks issues, opens PRs, or merges — write-code does the building, review-skill does the gating, this tells you how to write the artifact in between.
---

# author-skill

You are about to write a **kampus skill** — a `SKILL.md` under `skills/**` that an agent
loads and follows as a procedure. This guide is the authoring-side complement to
[`review-skill`](../review-skill/SKILL.md): review-skill *gates* a skill PR against its
issue's acceptance criteria plus four rigor checks; this tells you how to write the skill so
it passes that gate on the first pass, in the house idiom. Read it before you create or
substantially rewrite a `SKILL.md`.

This is a **guide, not a pipeline stage**. It picks no issues, opens no PRs, merges nothing —
`write-code` builds, `review-skill` gates, and this is the shape you write in between.

## What a kampus skill is

A skill is a single `skills/<name>/SKILL.md` file: **YAML frontmatter** (`name` +
`description`) followed by a **prose body** the agent follows as instructions. That is the
whole artifact. There is no manifest to register it in, no code scaffold, no build step —
the harness discovers skills by scanning `skills/*/SKILL.md` and routes on the frontmatter
`description`.

A skill is neither product code nor prose (ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md)): it
is a **behavioral artifact**, the executable instruction an agent runs. Write it as
instructions to that future agent — imperative, specific, and self-contained — not as an
essay describing what the skill would do.

## The house rules (from the writing-craft manifest)

The `skill-authoring` idea was imported from
[joshuadavidthomas/agent-skills](https://github.com/joshuadavidthomas/agent-skills) and
adapted to the kampus idiom (map #3370, manifest #3370). The adaptation strips the upstream
tooling, so a kampus skill carries **none** of these:

- **No Python.** Mechanical tooling in this repo is a Node/Effect CLI under `packages/`
  (the `pipeline-cli` idiom), never a `.py` — see the CLAUDE.md "Node over Python" rule. A
  skill that needs a deterministic check calls an existing `pipeline-cli` subcommand or a
  committed `skills/**/*.sh`; it does not ship a Python script.
- **No `sources/` tree.** The upstream skill vendored a reference corpus under `sources/`.
  Kampus skills don't — a skill is one `SKILL.md`. If you need supporting material, link out
  to the authoritative in-repo doc (an ADR, a `.patterns/` file) rather than vendoring a copy.
- **No second validator.** Do not re-implement what `review-skill` already gates. The gate
  reads your diff and checks behavioral correctness, trigger quality, cross-skill shadowing,
  and gate-invariant preservation (below). Authoring a parallel skill-linting validator
  duplicates that gate and drifts from it; the frontmatter floor is already enforced by
  [`validate-skills.sh`](../validate-skills.sh) in CI.

Lean by default: a skill states what it is and the one non-obvious thing, and instructs the
agent — it does not re-derive an ADR's rationale it can point to. The exception is below.

## The frontmatter contract (CI-enforced)

[`validate-skills.sh`](../validate-skills.sh) fails the build unless every
`skills/*/SKILL.md`:

1. Opens with a `---` frontmatter fence on **line 1**.
2. Carries a non-empty `name` that **matches the directory** (`skills/author-skill/` →
   `name: author-skill`).
3. Carries a non-empty `description`.

The `description` is not a summary — **it is the routing surface the harness fires on**. A
malformed or vague one makes the skill silently unroutable. Write it as concrete trigger
conditions: what the skill is, then the phrases and situations it should fire on. This is
also rigor check #2 (below), so getting it right here is getting it right for the gate.

## Author toward review-skill's four rigor checks

review-skill verifies your PR against its issue's acceptance criteria **and** four rigor
checks, conjunctively — any one failing fails the gate. Write to satisfy all four up front:

1. **Behavioral correctness.** Does the instruction *produce the intended behavior* when an
   agent follows it literally? Write concrete, ordered steps a fresh agent can execute
   without inferring your intent. Ambiguity that "obviously" means one thing to you is where
   this check fails.
2. **Trigger / `description` quality.** The skill must fire when it should and **not**
   otherwise. Too broad and it shadows a sibling (fires on prompts meant for another lane);
   too narrow and it never triggers. State the specific situations, and confirm the trigger
   surface doesn't overlap an existing skill's `description`.
3. **Cross-skill conflict / shadowing.** Read the sibling skills before you write. Your skill
   must not collide with or mask another's lane, duplicate its job under a new name, or
   instruct an action that contradicts an adjacent skill. A new skill earns its own lane or
   extends an existing one — it does not overlap.
4. **Gate-invariant preservation.** If your edit touches a gate skill (a review-*, ship-it,
   write-code, plan-epic, triage, or release skill), it must not *quietly weaken a gate* —
   drop a SHA binding, remove a fail-closed assertion, loosen a denylist. This is the most
   serious verdict the gate lands; if you are editing a gate skill, name the invariant you
   are preserving and prove the edit keeps it.

## The gate-skill house-style exemption

The lean/Strunk prose doctrine and the "comments earn their place" austerity **do not apply
to the gate skills** (the review-* / ship-it / write-code / plan-epic / triage / release
skills). Those are long, incident-hardened instruction surfaces: they carry embedded ADR
rationale, incident-number pointers, and fail-closed ceremony *on purpose*, because a dropped
invariant there is a security or correctness hole (the trust-inversion and false-PASS classes
those skills were hardened against). Their prose weight is load-bearing.

So: when you author a **new, non-gate** skill, keep it lean. When you edit a **gate** skill,
match its existing register — do not "deslop" its invariant prose, do not compress a
fail-closed rationale to a one-liner, do not trim an incident pointer that anchors a guard.
The rigor check #4 above is the enforcement; this exemption is why the prose looks heavy.

## Destination and §CP — re-check before you open the PR

Where a skill lives decides whether its PR is control-plane (§CP, human-merge) or
auto-shippable. **Re-check the final path** against the live control-plane regex before
opening the PR:

```bash
pipeline-cli control-plane-paths
```

A skill flips to §CP (human-merge, never auto-shipped) when its path falls under a gate skill
directory, is any `skills/**/*.sh`, or touches `.claude/**`, `.github/**`, `biome.jsonc`,
`packages/ci-required/`, `packages/pipeline-cli/`, or `gh-issue-intake-formats.md`. A new,
non-gate `SKILL.md` with no `.sh` sibling is **not** control-plane — it auto-ships on a green
review-skill PASS. Confirm your destination against the live regex; don't assume from this
list, which can drift.

## When you're done

Confirm `validate-skills.sh` passes locally. If your skill is a **pipeline stage** (a named
step in the report → triage → … → ship-it flow), add a one-line row to the skills table in
the plugin [`README.md`](../../README.md); an **ambient** skill (a guide or standalone tool,
like this one) is discovered by the harness's `skills/*/SKILL.md` scan and needs no README
row. Then hand the PR to `review-skill` — it gates the four rigor checks above; you do not
review your own skill.
