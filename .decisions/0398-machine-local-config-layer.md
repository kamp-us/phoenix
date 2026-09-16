---
id: 0398
title: A machine-local config layer overrides allow-listed keys only, never a guard's scope or authority
status: accepted
date: 2026-09-16
tags: [fabrika, config, lane, security, pipeline-hardening]
---

# 0398 — A machine-local config layer overrides allow-listed keys only, never a guard's scope or authority

**What this decides:** fabrika reads a second, gitignored config file — `.fabrika.local.jsonc` beside
the tracked `.fabrika.jsonc` — so a value that belongs to one machine stops living in a tracked file.
It may carry `laneConcurrencyCap` and nothing else; every other key is a load refusal, so no local
file can widen a gate's scope or name who may act.

## Context

`laneConcurrencyCap` is a property of the laptop, not of the repository. The founder's cap on this
machine is 10 and the repo declares 2, and until now the only surface carrying the number was the
tracked `.fabrika.jsonc` — its own comment states the absence as design: "there is no override flag,
so raising this line is the only way past."

So honouring a machine cap meant hand-editing a tracked file in every driving worktree and
remembering never to stage it ([#9020](https://github.com/kamp-us/phoenix/issues/9020)). Two costs
followed. `lane integrate` refuses a seat holding modified tracked files at exit `45`, so on an epic
lane the cap edit and that guard cannot both hold. And nothing enforced the never-commit half: one
blanket stage-all in a driver worktree lands one laptop's cap on the default branch for every other
machine.

The code has no other door. `packages/fabrika-cli/src/config/read-key.ts` resolves every key through
four arms — `Declared`, `Default`, `Malformed`, `Unknown` — and
`packages/fabrika-cli/src/config/source.ts` opens exactly one path, `<root>/.fabrika.jsonc`. There is
no env read and no overlay.

The founder ruled the shape on 2026-09-10 PT
([the ruling comment](https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600)),
verbatim: *"no, we probably need a .fabrika.config.local.json type of thing similar to how claude
does it."* A per-key environment variable — the cheap alternative the issue named — is rejected by
that ruling. The filename and the merge rules were left to this record.

What the ruling does not settle is the part worth writing down: an overlay that can override any key
is also a surface that can locally weaken a guard. `.fabrika.jsonc` carries `codeValidators`,
`workflowValidators`, `docLeakExempt`, `governedRoots`, `capClearAuthors`, `campaignAuthors` and
`controlPlane`, and `build check` reads the first three straight out of the working tree. A local
layer over those keys is a local, invisible, untracked way to shrink what a gate looks at.

ADR [0294](0294-config-narrows-the-acl-never-replaces-it.md) already rules that a config authority
set only ever narrows a live ACL. ADR [0286](0286-standing-lanes-come-from-config.md) rules that a
repo-specific set belongs in config rather than in CLI source. Neither contemplated a second file
that no reviewer ever sees, and that is the gap this record closes.

**Relationship to ADR [0390](0390-a-capped-lane-boot-is-read-before-claim.md) — this record amends it
in part.** 0390 §4 keeps `concurrency.ts` unchanged with "no new flag, no environment escape", and
its context quotes the premise that raising the tracked line is the only way past. The cap stays hard
here: there is still no override flag, no environment variable, and no way for a booting lane to
argue past the number it reads. What changes is only where the number may be *declared*. 0390's
`LANE-WAITING` route, its exit `51` refusal and its seat accounting are untouched.

## Decision

**A machine-local `.fabrika.local.jsonc` layers over the tracked `.fabrika.jsonc` for allow-listed
keys only, and a key it may not carry refuses the whole load.**

1. **The file.** `.fabrika.local.jsonc`, at the repository root beside `.fabrika.jsonc`, named in
   `.gitignore`, read by the same comment-stripping parser. Same extension because it is the same
   format read by the same code; a different one would imply a second grammar that does not exist.

2. **Precedence, per key: local, then tracked, then shipped default.** A key declared in the local
   file wins. A key absent from it falls to the tracked file, and a key absent from both falls to its
   shipped default. Precedence is decided key by key, and the winning value replaces the losing one
   **whole** — no deep merge of an object, no concatenation of an array. Every key's decoder refuses
   a whole value rather than skipping a bad entry, and a merged value is one no author ever wrote and
   no decoder ever saw as written. Array concatenation is also exactly how a local file would widen a
   validator list or an exemption list without replacing anything.

3. **Only an allow-listed key may be declared locally, and the allow-list lives in code.** A key
   group declares its own eligibility beside its default and its decoder, so a new machine-local key
   is one registry-visible change with a test, not a convention. The allow-list opens with
   `laneConcurrencyCap` and carries nothing else.

4. **A local file naming an ineligible key refuses the load, in the fail-closed shape
   `refuseLoad` already has.** It is not ignored and not dropped. An operator who writes
   `codeValidators` into their local file must be told the file is refused, not left believing a
   value is in force that is not — the same reason `laneConcurrencyCap` refuses a fraction rather
   than rounding it.

5. **A local value may never weaken a guard, and two rules hold that.** A key that names *who may
   act* (ADR 0294's authority keys: `capClearAuthors`, `campaignAuthors`, `controlPlane`) or that
   names a gate's scope, exemptions or validator commands (`governedRoots`, `codeValidators`,
   `workflowValidators`, `docLeakExempt`, `auditCatalogs`, `ci`, `paths`) is **permanently
   ineligible** — no later ADR admits one by adding a flag, because admitting one is the thing being
   banned. Every other key is ineligible by default and becomes machine-local only through a record
   like this one.

6. **The local layer is read from the working tree only, never at a ref.** `build clearances` reads
   `.fabrika.jsonc` at a pull request's base ref through `readFileAtRef`; that read, and every other
   ref-based read, sees the tracked file alone. A local file does not exist in CI and cannot be
   fetched at a ref, so no gate's verdict is reachable from one even if rule 5 were someday wrong.

7. **An unreadable local file is UNKNOWN, never a fall-through.** An absent local file is a machine
   that declared nothing and every key falls to the tracked layer. A local file that exists and
   cannot be read, or that does not parse as a JSON object, resolves every key `Unknown` exactly as
   the tracked file does, and each caller refuses in its own words. Falling through to the tracked
   value on an unreadable local file is how a typo silently restores the repo default on a machine
   that declared something else.

8. **Provenance is printed, per key.** `readKey`'s `note` names the layer a value came from, so a
   verb says `.fabrika.local.jsonc` when that is where the number was, and `status settings` reports
   the layer per key. A value whose source is invisible is one an operator debugs blind, which is the
   cost the old hand-edit at least made visible in `git status`.

9. **`config schema` covers the local file** against the same assembled document, narrowed to the
   machine-local key set — an editor should red an ineligible key where it is typed, not at the next
   verb run.

**Banned.**

- An environment variable for any of this, per the ruling.
- A local override of an authority key or a gate-scope key, by any mechanism.
- A deep merge, an array append, or any rule under which the effective value is a value no file
  states.
- Reading the local layer at a base ref, or shipping it into a container, a CI job or a release
  artifact.
- Ignoring an ineligible key instead of refusing the load.

## Consequences

- A driving worktree stops carrying a modified tracked file for a whole run, so `lane integrate`'s
  exit `45` dirty-seat guard and a machine cap can both hold on one epic lane.
- The accidental-commit path closes: the value lives in an ignored file, so a blanket stage-all in a
  driver worktree cannot land one laptop's cap on `main`.
- An operator spawn no longer carries a hand-edit instruction in its prompt, which was a step a
  driver could forget or get wrong.
- The cost is a second file to reason about, and one new failure shape: a stale local file is
  invisible in `git status` and will keep applying until someone deletes it. Rule 8's per-key
  provenance is the whole mitigation, so it is not optional dressing.
- `.fabrika.jsonc`'s `laneConcurrencyCap` comment, which states "raising this line is the only way
  past", stops being true and is rewritten by the change that implements this.
- A repo that never writes the file is unaffected: absent is a machine that declared nothing.

## Records

no vocabulary impact
