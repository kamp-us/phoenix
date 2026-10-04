---
id: 0383
title: Containment on a squash trunk is patch identity, not ancestry
status: accepted
date: 2026-09-10
---

# Containment on a squash trunk is patch identity, not ancestry

## Context

ADR-less until now, the rule that opens `lane assembly`'s re-cut arm was written as ancestry: PR
#9016 shipped [#7950](https://github.com/kamp-us/phoenix/issues/7950)'s containment guard as
`git merge-base --is-ancestor <branch> origin/HEAD`, and re-cut the assembly branch only when that
exited zero.

It cannot fire here. Every PR in this repository lands as a squash, so a landed branch's own commits
never enter `main` and its head is never an ancestor of the trunk. Verified at `origin/main` on
2026-09-10: `git log --merges --oneline -5 origin/main` prints nothing, and
`git merge-base --is-ancestor e6868e0762 origin/main` exits `1` — that SHA being the head of the
already-squash-merged PR #7773, the branch whose resume produced #7950's incident. The guard answered
"not contained" for exactly the branch that motivated it
([#9015](https://github.com/kamp-us/phoenix/issues/9015)).

The failure direction was safe — an unfired guard resumes as before — but the cost #7950 exists to
remove was still live: a driver resuming a part-shipped epic gets a branch that is both the
sanctioned base for every remaining child and guaranteed to conflict with the trunk, and the recovery
is five hand steps including a derivation ADR [0228](0228-scripts-relay-never-derive.md) puts outside
a driver's job.

#7950's no-gos left no room to fix it in place: never re-cut on anything weaker than provable
containment, and never read the board. Three routes were open — tree-object equality, a distinct
refusal exit that hands the branch to a human, or a board read of whether the tail PR merged.

## Decision

**Refs-only, squash-aware containment by cumulative patch id, with ancestry kept as the fast path.**
Ruled by the EA under [#8807 R4.1](https://github.com/kamp-us/phoenix/issues/8807) — engine
machinery is the driver's call — and recorded at
[this comment](https://github.com/kamp-us/phoenix/issues/9015#issuecomment-5619503510).

When ancestry says "not an ancestor", the branch's cumulative patch (`git diff <merge-base>...<branch>`
piped to `git patch-id --stable`) is compared against the patch ids of the commits `origin/HEAD` took
since that merge base, limited to the paths the branch touches. A match means the branch landed as a
squash and is dead: re-cut off the trunk, in the same placement PR #9016 already does. No match means
resume as before. An unreadable range refuses at `11`.

**#7950's "no board read" no-go stands.** Nothing here asks whether the tail PR merged; the whole
answer comes out of refs and objects.

One reader serves both callers. `build reap` already carried this exact read as a private
`landingOf`, measured rather than reasoned about: on
`build/4082-db-schema-readme-diataxis-43cc4b51` the branch's own net patch id and the trunk commit's
path-limited one are both `d18b491a48c861494a35740f571a90a45b596aae`. It now lives in
`packages/fabrika-cli/src/io/containment.ts` as `containmentOf`, and `lane assembly`'s resume arm and
`build reap`'s sweep read the same one — two containment rules wearing one name is how the two seams
come to disagree about a branch one of them is about to destroy.

## Consequences

- **The pathspec is what makes the two patch ids comparable.** Limited to the paths the branch
  touches, a squash commit's diff *is* that branch's net diff, byte for byte. Widen it and nothing
  matches.
- **A squash that carried a conflict resolution does not match, and resumes as before.** That is the
  fail-safe side: the branch is treated as still carrying work, so nothing is destroyed. It is also
  the reason the answer is not a proof of the negative — `Unlanded` means "no proof it landed", never
  "proven unlanded".
- **A branch that adds nothing to the trunk at all counts as contained too.** Its net diff against
  the trunk is empty, so no unlanded content can exist on it whatever the graph says; `build reap`
  already licensed a removal on that same reading.
- **The trunk scan is bounded at 200 commits.** Past it the answer is `Unlanded` — again the
  fail-safe direction, and the only reason a bound is allowed to exist.
- **The claim is proven against real git, not a fixture.** `src/io/containment.git.test.ts` builds a
  throwaway repository, lands a branch with `git merge --squash`, asserts that ancestry still exits
  non-zero there, and asserts the reader answers `Squashed` naming that commit. A merge-commit
  fixture would have proven nothing: ancestry already answers those, and it is the squash shape it
  cannot answer.
- **`isAncestor` moved from `build/git.ts` to `io/git.ts`.** The shared reader sits under `io/`, and
  an `io/` module reaching up into `build/` for a primitive would invert the layering; `lane push`
  was already reaching across for it.

## Amendment (2026-10-04, #9040) — the positive verdict is byte-exact

The Decision above names `git patch-id --stable` and says nothing about how strict a match is. That
mode strips whitespace before it hashes: git-patch-id(1) says of `--stable` that "all whitespace
within the patch is ignored and does not affect the id". So a branch that differed from its own
landed squash by whitespace alone read as `Squashed`, and the record gave a reader no reason to
expect that.

Ruling, 2026-09-10 PT, made by the founder:
[the ruling comment on issue 9040](https://github.com/kamp-us/phoenix/issues/9040#issuecomment-5625300412).
Asked whether the landed check should compare byte for byte, so that a whitespace-only difference no
longer counts as already landed, the answer was yes.

**Both sides of the comparison are read with `git patch-id --verbatim`.** That mode does not strip
whitespace, and it implies `--stable`, so the hunk-order stability the Decision relies on is kept.
`Squashed` now means the trunk carries the branch's net diff byte for byte. The mode is the only
thing that changes: the pathspec, the 200-commit bound and the ancestry fast path stand as written.

**The stricter direction is the fail-safe one because one caller moves a ref.** The two errors cost
different things. A match lost to whitespace answers `Unlanded`, and both callers then keep the
branch: `lane assembly` resumes it and `build reap` leaves its worktree. A match gained from
whitespace answers `Squashed`, and `lane assembly`'s resume arm re-cuts the branch off the trunk
with `git worktree add --no-track -B`. That moves the ref, so the commits holding the
whitespace-only work are discarded, and the verb's output reads the same as it does for a true
squash match. A wrong `Unlanded` costs a resume a driver can see. A wrong `Squashed` costs committed
work without a signal.

**What it gives up.** Where the landing side normalized whitespace, such as a formatter that ran on
the merge and not on the branch, a branch that did land now answers `Unlanded` and resumes as it did
before this record. That sits beside the conflict-resolution case in Consequences: `Unlanded` is "no
proof it landed", never "proven unlanded".

`packages/fabrika-cli/src/io/containment.git.test.ts` carries the case against real git: it lands a
squash, re-indents the branch copy, shows that `--stable` gives the two patches one id, and asserts
the reader answers `Unlanded`.
