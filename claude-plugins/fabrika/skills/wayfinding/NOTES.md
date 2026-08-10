# wayfinding — authoring notes

What the `SKILL.md` and `contract.md` deliberately do not carry: the packaging reasoning, the v1
archaeology behind each rule, and the questions this authoring session could not close.

## Packaging and the invocation axis

`wayfinding` is **model-invocable** (no `disable-model-invocation`), like every landed fabrika
skill. It pays the always-in-context description cost, and it buys two things the user-only axis
cannot: the model can reach it unprompted when a plan turns out to rest on unanswered questions,
and — the load-bearing half — it can be **one link in a stack**. The quintet composes by the model
firing the next Skill tool, so a user-only `wayfinding` could neither be reached from a `grilling`
session that discovered multi-session fog, nor preloaded into a dispatched lane (skill conventions
§3).

**Skills cannot invoke skills.** Where the `SKILL.md` says the model fires `grilling` or
`prototyping`, that is a direction to the model, never a call. This matters here more than in most
skills, because `wayfinding` is defined by the ruling as the wrapper that *invokes* two siblings —
an implementer or a later author reading "invokes" as "calls" would try to build a seam the harness
does not have.

**The routing triangle** (brief amendment, 2026-08-10). A frontier question a subagent can settle by
reading is `research` and stays here. One only running throwaway code can settle is `prototype` and
goes to `prototyping` — one spike, ONE named question, disposable by that skill's charter. A product
or direction choice is `decision` and goes to `grilling`. Both routed kinds come back the same way,
summarized onto the map through `map record`. `map fork` records *where* a question went and admits
`--session` or `--spike` by the ticket's kind, so a mis-sorted question is refused rather than
quietly routed to the wrong sibling. Neither sibling's internals are specified here, and
`prototyping` is standalone-first — this skill is one caller, not its entry point.

**Why eight verbs and not fewer.** The corpus median is five to seven. Three pressures pushed this
one up: the map body is a shared mutable artifact so every write needs its own guarded seat; the
lane lifecycle is two acts (claim, close) that must be separable so lane traffic never touches the
body; and the fork is a distinct write from the resolution because a routed decision has no answer
yet. The one verb this session **removed** was `map assess` — see the contract's *Considered and
deliberately not derived*.

## v1 archaeology — what was read, and what was left behind

Read: `claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md` (579 lines), its three
`scripts/`, `shared/wayfinder-map-issue-shape.md`, and the six `pipeline-cli` tools the brief's
field 4 names. Read for semantics and scars only; nothing is ported and nothing is called (ADR
0238).

**The finding that shaped the whole contract.** Eight of v1's seventeen writes to map state are
read-modify-writes of one issue body with no concurrency control of any kind — no ETag, no
`If-Match`, no signature re-check, no lock. `wayfinder-map/command.ts:56` computes a `mapSignature`
and **nothing consumes it on a write path, because there is no write path**: the tool is "read-only
by construction" (`github.ts:184`) while the skill orders every mutation through it
(`SKILL.md:293`). So the typed, tested half is the read and the unverified prose half is the write —
which is exactly why a map drifts into the malformed states the same tool then reports. The
`--digest` compare-and-set in every writing verb here is the answer to that one finding.

**Scars designed out, each cited in a Grounding block rather than repeated here:** the malformed
verdict that returns exit `0` identically to a valid one; refusals printed with bare `echo` to
stdout, the channel carrying the issue number; "no map was created" and "the map may or may not
exist" sharing exit `1` when their remedies are opposite; the orphaned frontier ticket whose number
is lost because the `printf` never runs; `$MAP`, `$E1` and `$E2` as session memory no artifact
carries, with `$E1`/`$E2` never assigned anywhere at all; the emission backlink inside a quoted
heredoc so `#<MAP>` can never expand; the validator named but never invoked by any step; the
one-ticket-per-session law with no counter, no marker and no check; and the destructive graduation
branch being the scripted one while the safe branch is prose.

**What was NOT inherited, deliberately.** v1's ticket-type translation table maps its four Pocock
ticket types onto `type:investigation` / `type:decision` labels. This skill writes **no `type:`
label at all** — the kind lives in a marker instead. Two reasons: a `type:` label is intake's
classification vocabulary, and putting it on a ticket that is deliberately not pickable is the
ambiguity #4840 is open about; and v1's own shell treats both type labels identically
(`add-frontier-ticket.sh:24-30`), so the label never carried the distinction it appeared to.

## Open questions this session carried

1. **#4840 is open and this skill brushes it.** v1's intake formats rule that *"blockedness is
   derived, never stored — there is no `status:blocked` label"*
   (`gh-issue-intake-formats.md:621`, `write-code/SKILL.md:366`). A native blocking edge *is* a
   stored blockedness carrier. The boundary taken here — frontier tickets carry no `status:triaged`,
   so they are never in the execution picker's candidate pool, and `map read` derives blockedness
   rather than storing a state for it — keeps the two consistent without ruling the general case.
   If #4840 rules that stored blockedness is illegal for standalone issues, this skill's edges are
   unaffected only for as long as frontier tickets stay unpickable. Worth re-reading at that ruling.
2. **The ideation layer has no eval stage.** `packages/fabrika-cli/src/eval/corpus.ts`'s `STAGES` is
   `["triage", "build", "review", "ship-it"]`, so neither `wayfinding` nor `grilling` can declare a
   corpus entry today. That blocks ship gate 3 for the whole quintet, it is not this brief's to fix
   (#4649 owns the harness), and it is filed rather than left in a chat window.
3. **#4644 carries a fifth adopt row the brief does not.** "Tracker-ops as a swappable per-repo
   contract doc" is plausibly the ancestor of the required-repo-files section later mandated on
   #5018. The brief seals scope at four deltas, so this session carried four; flagged rather than
   silently expanded.
4. **The content-ingestion trust posture is unruled** (#4859). §ING declares the seam and the second
   tier's cost; when the posture lands, the first tier changes in the verb layer and the second
   changes here. Nothing in either artifact writes a posture down as settled.

## Eval coverage

The set enumerates: a destination that is a deliverable rather than fog; a fog claim whose questions
are already answered on the board; a write refused because the map moved under a stale read; a
parallel lane that found nothing versus one that could not look; and a direction already recorded
out of scope being re-proposed. (The `SKILL.md` carried this list under a "leaf-rule obligation"
heading in an earlier draft. That was a misapplication: §10's enumeration obligation binds a
**family entry** that folded N per-surface identities into one, and `wayfinding` routes to no
internal leaves. The enumeration is still worth stating — it just belongs here.)

Not covered, and stated rather than left implicit:

- **`map record` on a forked ticket whose ruling reads `stale`** — the seam with `grilling`'s digest
  model. It is specified (`13`, with the state named) and unexercised, because a fixture for it
  needs a two-skill transcript whose `grilling` half would be testing that skill rather than this
  one.
- **A cycle refusal on `--blocks`** (`14`). Specified, unexercised.
- **The `map open` orphan path** (`8`, created then label write fails). Specified, unexercised — the
  fixtures cannot produce a partial GitHub failure without a live API.
- **Terminal coverage:** of the twenty terminals, the runs exercise `NOT-FOG`, `ALREADY-DESCOPED`,
  `MAP-MOVED`, `FINDING-RECORDED`, `MAP-OPENED` and `FRONTIER-LAID`. The remaining twelve are
  reachable by construction from the contract's matrix but are not run-covered.
