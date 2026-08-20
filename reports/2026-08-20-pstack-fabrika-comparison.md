# pstack → fabrika: a comparative read

Dated snapshot, 2026-08-20. A full read of [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) (v0.14.1, by Lauren Tan / "poteto" — 44 skills, 22 playbooks, 2 agents, ~6.5k lines of tested TypeScript tooling) against fabrika's current state (25 skills, 5 agent shells, 28 CLI verb groups, 2 hooks), asking one question: **what does the most battle-tested public AFK-agent stack do that fabrika doesn't, and which of it fits fabrika's shape?**

pstack's thesis, from its README: "pstack gives you fearless parallelism. when you can go deep on one agent and trust it to write good, verifiable code, you can truly parallelize with confidence." Its AFK story is real: overnight autonomous runs, PR babysitting to merge, multi-day orchestrated programs under one coordinator — all shipped and scarred, with the incident costs written inline.

## 1. The two stacks converged independently — that is evidence, not coincidence

Before the gaps, the agreements. The two stacks were built by different people on different harnesses (Cursor vs Claude Code) and arrive at the same load-bearing moves. Each convergence is a design both sides paid to learn, which makes the *divergences* below worth taking seriously too.

| Shared move | pstack form | fabrika form |
|---|---|---|
| Thin skills over mechanical tooling | `watch-pr/` + `orch/` typed CLIs; "Trust its merge state and blocker class instead of ad hoc `gh` calls" | The two-layer split: deterministic parts pushed maximally into `fabrika` verbs (skill-conventions §1) |
| Author ≠ judge, structurally | Comment Sicko vs `/no-comments`; interrogate's reviewers vs lead judgment; verifier on a different model family | build/review, plan/gate, recommendation/ruling; `review` reads its own instructions from the merge base (ADR 0052) |
| Artifacts over self-report | "Delegation: trust artifacts, not self-reports"; ledger keyed by PR + head SHA | `lane prove` reads the artifact behind every `DONE`/`PASS`; "a report is data; what moves the machine is the artifact behind it" |
| Verdict staleness is the enemy | Patch-id check after the "twenty-one verdicts went stale in one run with no signal" incident | ADR 0276: verdicts bound to head SHA **and content digest** — fabrika's is strictly stronger (survives a rebase that preserves content) |
| External text is untrusted data | Review-comment bodies relayed as data; `gh api -f body=@file`; formula-injection escaping in `log.sh` | `report file` takes the body on stdin only; closed-vocabulary cross-lane signals; receiver re-fetches from the artifact |
| Resume is respawn, never memory | "Never resume-chain a brief; respawn fresh with consolidated scope"; reattach cloud work by PR + branch, not agent id | "Resuming a lane is spawning the operator again with the same issue number — the fold says everything a successor needs" |
| Single writer per state file | Orchestrate: "Every file has exactly one writer; owners publish facts, readers aggregate at read time" | Owned-facet reconcile in `triage apply`; single merge authority; digest-guarded compare-and-set body splices |
| Scar-tissue documentation | "A one-line fix that swept its ancestors severed a 41-PR chain and cost a day of repair" | "#5566: that refusal used to arrive a whole review round later"; the M46 park that burned five human cycles in one night |

## 2. Where fabrika is ahead — do not cargo-cult these away

- **State lives on GitHub, not on a VM.** pstack's orchestrate store is a local TSV/JSON directory with a PID lock, and it has to compensate with an externalization rule ("Work that exists only on one VM when that VM dies was never done") and a Cursor-restart recovery playbook. fabrika made the stronger call up front (ADR 0283): verdicts, claims, labels, topology all live on GitHub artifacts; only drive-loop mechanics are local and gitignored. Nothing in pstack should pull fabrika back toward local state.
- **Exit codes are a contract, not a convention.** pstack's `watch-pr` encodes exit codes in types, which is good — but fabrika's shared exit table, "a non-zero exit is UNKNOWN — read the status before the bytes", positive-token answers, and fail-closed zero-scope refusals (ADR 0092) are a more complete interface law than anything in pstack.
- **Deterministic CI enforcement.** pstack's rules are enforced socially (prose in playbooks) plus a few scripts. fabrika has 19 fail-closed guards in CI, a governance gate that derives its own requirement from the diff (`DERIVED-NOT-ELECTED`) and self-fences at the merge base, and `ship gate` as a verdict conjunction with a floor. pstack has no analog to the gate-on-the-gates.
- **Escalation is mechanical.** pstack's escalation split is well-written prose ("known clears, novel escalates" is fabrika's — but as exit codes folded through a closed in-code table, ADR 0302). fabrika's recipes are the stronger rung of pstack's own `principle-encode-lessons-in-structure` ladder, applied to escalation itself.
- **Wire formats.** 15 registered byte-level schemas with total `Found | Absent | Malformed` reads have no pstack equivalent; pstack parses its own comment/TSV surfaces ad hoc.

## 3. The gap that matters: fabrika has no clock

This is the headline finding. pstack's AFK machinery rests on three legs — **a wake mechanism, a finish predicate, and re-arm discipline** — and fabrika has none of the three, despite having a *better* lane machine underneath.

**pstack's legs:**
1. **Wake mechanism chosen up front.** `autonomous-run.md`: pick it with `/loop` before the first iteration — an event to watch gets a watcher subagent with a long time-based heartbeat as fallback; no event gets a fixed-interval heartbeat.
2. **Finish condition as a checkable predicate,** stated before iteration one. "A vague goal stalls; a predicate lets you stop." "A plateau is not a stop… never relax the predicate to declare victory." "A duration is not a finish condition."
3. **Re-arm discipline.** babysit: "Watcher output drives wakeups. Never add a second sleep loop. A babysit that fixes a blocker and ends without rearming has abandoned the stack."

**fabrika today:** the `operate` loop, recipes, `heal-ci sweep`, and `lane stale` are all built — and nothing starts any of them. The five `schedule:` workflows in `.github/workflows/` are all deterministic guards. The `heal-ci` skill says it "is reachable on a schedule," but no workflow declares that schedule. `lane stale` detects a lane that has gone quiet with something owed — and only ever runs when a human thinks to run it. A human starts every driver session. fabrika is a fully-built engine with no ignition.

The recommendations below are ordered by leverage toward closing exactly this.

## 4. Recommendations

### R1 — Ship the patrol: a scheduled entry point (the missing ignition)

Add the schedule `heal-ci` already claims, and widen it into a patrol chore. A scheduled workflow (or a `/loop`-driven session on the harness side) that runs, in order: `heal-ci sweep` (classifies every open PR, writes nothing), `lane stale --older-than 60` (reports lanes with something owed), and a `recipe route` pass over any lane a recipe table already names (known parks clear mechanically per ADR 0302, novel ones stay parked). Everything in that sentence exists as a verb today; the whole change is a trigger plus a chore workflow template alongside `park-sweep`. This converts fabrika's biggest structural asset — mechanical, escalation-safe unattended passes — from "reachable" to "running".

### R2 — Encode the three legs into `operate` and the driver posture

Borrow pstack's discipline as skill law, in fabrika idiom:
- **Finish predicate before the first spawn.** An `operate` run states its terminal as a checkable predicate (a fold state, a merged PR, a label) before dispatching anything. The lane machine almost forces this already; make it explicit so a driver session can't run on a vibe.
- **Re-arm or hand off, never just stop.** A driver that ends its turn with a non-terminal lane and no scheduled next wake has abandoned the lane — pstack's babysit rule, verbatim in spirit. Where the harness offers a scheduling primitive, the skill requires arming it; where it doesn't, the skill requires a `handoff` pack. Today the gap between "operator died" and "human notices" is unbounded.
- **Never relax the predicate.** pstack's "extending the run is a new pass through step 1, not a judgment call you make at 3am" is exactly the kind of anchored invariant fabrika already knows how to write.

### R3 — A pickup verb: "what is stranded under my name?"

pstack has `recall` ("catch me up") and `session-pickup` ("inherit the prior agent's work; the trail is authoritative — a 'let me verify from scratch' pass is the tell that you're treating the trail as untrustworthy"). fabrika's `handoff` covers the *deliberate* case — a sealed pack with proven and asserted halves — but there is no answer to the undeliberate one: a session died, and its successor (or the founder, back at the keyboard) wants one command that lists open claims, unclaimed packs, stale lanes, and unresolved parks attributable to this account. That's a read-only aggregation over artifacts fabrika already owns — a `status pickup` (or extension of `status board`) verb, plus a short skill section teaching the successor to treat the fold and the pack as authoritative rather than re-deriving. This is the recovery half of R1's detection half.

### R4 — A reflect loop that feeds the intake pipe

pstack's `reflect` mines a finished session's transcript through three lensed reviewers plus a synthesizer, with three filters fabrika should steal wholesale:
1. **The structural-enforcement check**: anything a lint/guard/type would enforce better than prose moves out of the skill edit and into tooling backlog — pstack's "pick the strongest rung," which is already fabrika's native instinct (recipes, guards).
2. **The durable-vs-drifting filter**: drop SHAs, counts, dated findings; keep patterns.
3. **The hard human gate**: "Skill changes affect every future agent in the org; do not auto-apply."

fabrika's version should *not* edit skills directly — it should file `report` issues (the sanctioned intake, already type-blind and triage-owned), one per durable lesson, with the lesson's transcript evidence quoted. The pipeline then does what it already does: triage classifies, a skill-class build implements, `review-skill` + `governance` gate it. pstack needed a bespoke approval flow because it has no pipeline; fabrika gets the approval flow for free. This also partially back-fills what was lost when the eval layer was removed (#5510 → #5517): a feedback channel from sessions to skill text.

### R5 — A live-surface verification map for `apps/web`

pstack's `create-verification-skill` is its most transferable single artifact: interview the repo (not the user), generate a per-app verify skill with Launch / Doctor / Drive / Evidence / Cleanup sections and a feature map (one file per feature: how a user reaches it, exact drive commands, observable results, gotchas), then **prove the generated skill end-to-end once** — "a generated skill that was never executed is a draft, not a deliverable." Its ledger stance is the right bar: "CI green is an input to a verdict, not a verdict"; the live lane is the floor.

fabrika has the substrate (the `@kampus/fabrika-cli/capture` library, `ui render`, golden diffs) but only for *styled-surface* judgment. A `verify` feature map for `apps/web` — sozluk/pano flows driven on a real workerd via Playwright — would give `build` and `review` a proof rung above unit tests and below "founder clicks around," and it slots into the existing shape: a manifest-like committed map, a verb that drives one feature and captures evidence, evidence attached the way `ui evidence` already attaches. pstack's maintenance loop (`maintain-verification-skill`: doc drift vs product regression, "never edit product code during a run") shows what the upkeep chore looks like — and that chore is itself an R1 patrol candidate.

### R6 — Give `spend` a producer, then adopt the 70% landing rule

The spend ledger has no producer today, by the CLI README's own admission. pstack runs budget-shaped autonomy: "by roughly 70% of it, stop spawning and land what is verified, because finished-but-unlanded work counts as zero," and bounds its own infra retries "the same way you bound a child's." Neither is adoptable until spend is measured. First a producer (the operator writing per-spawn rows is enough), then a driver-side landing discipline read off the rollup. Deliberately *not* a gate in the verb — `spend`'s can't-gate design is asserted by test and should stay; the discipline belongs in `operate`'s skill text, like pstack keeps it in the playbook.

### R7 — Retry-by-failure-mode as recipe rows

pstack classifies a dead worker before retrying: cap-hit/OOM → smaller scope; network drop → retry as-is; tool error → retry on a different model; unknown → once; two retries then replan around it. Plus the liveness rules fabrika's `lane stale` consumer will need: "Transcript mtime is not liveness"; a zombie's findings are "salvaged through a fresh unit, never a blind merge." fabrika's retry today is uniform (two review retries then `frozen`) and dead-spawn cleanup is bespoke prose in `operate`. The pstack table is exactly the shape of a recipe: a closed classification, each row folding to an event. This turns R1's patrol from "report stale lanes" into "clear the mechanically clearable ones."

### R8 — Land the prose rubric; import unslop's shape

fabrika's `review` doc rubric still says the shared writing rubric "is the fallback until it lands." pstack's `unslop` is the best public version of that rubric: 31 numbered AI-tell rules (each `Pattern → examples → fix`), the generic-doc test ("if the sentence could appear unchanged in another project's docs, it says nothing about this one — cut it"), the "adding soul" counterweight against sterile prose, and the meta-rule worth quoting into the skill verbatim: "Write the reply clean as you draft it. The cleanup-afterward pass has been measured to fail." It is MIT-licensed, the same route `writing-for-agents` already took from mattpocock/skills. Note the one house-style conflict: unslop bans em dashes; phoenix's voice uses them. Import the rubric's *method*, adjust the rule list to the house voice.

### R9 — Calibration idioms for `review`'s fan-out and the founder's queue

Three small, cheap steals:
- **Visible skips.** pstack playbooks: "A step you choose not to do stays in the list with a one-line `skip: <reason>`; skipping silently is not allowed." fabrika skills have closed terminal vocabularies but no per-step skip discipline; adding it makes a session's checklist auditable after the fact.
- **The Dismissed section as a trust mechanism.** interrogate's lead judgment publishes Act-on / Consider / Noted / **Dismissed** with an agreement map, plus nitpick-gravity calibration ("reviewers fill their review; if they don't find critical issues, they'll inflate nits… more than 5 Act-on items means you're not filtering hard enough"). fabrika's `review` routes findings binary (traces to the goal or `/report`), which is stronger — but the fan-out subagents' *rejected* findings currently vanish. Recording what the reviewer dismissed and why, in the verdict comment, is what lets a human audit the gate instead of trusting it.
- **Batch the founder's seat.** pstack parks every human question as a `gates.md` entry *before* asking and batches them into the status page, "so a completion flood cannot wipe AskQuestion state" — the human supervises asynchronously. fabrika's human seats are deliberate (ADR 0278/0289) and should stay; what can improve is their *interface*: a `status board` view that aggregates every waiting park, pending `cp-approval`, un-ruled grilling round, and cap request into one queue, so the founder's recurring seat is a batch, not an interrupt stream.

### R10 — When evals return, start from pstack's blinding protocol

fabrika's skill ship gate lost its eval third when the eval layer was removed. pstack's `eval.md` is the most concrete anti-observer-effect protocol in the corpus: a banned word list for anything a candidate can see (`eval`, `judge`, `rubric`, `score`…), organic-looking prompts, candidates unaware of each other, one judge scoring both sets in a single pass ("two judge runs with different prompts don't compare; the calibration drifts"), and grading chain-following from transcripts, never self-report ("citing a principle is not reading its leaf skill, and reading it is not applying it"). Whatever replaces #5517 should begin here.

## 5. What not to import

- **The local orchestrate store.** Directly contradicts ADR 0283, and pstack's own recovery playbooks are the cost of that choice.
- **"I don't believe in planning."** pstack ships no planning skills by conviction; fabrika's plan-epic → check-epic-plan → founder approval chain is a founder ruling (ADR 0289) sized to human capacity (ADR 0278). Different product, different bet.
- **"Just do it" for external actions.** pstack proceeds on team-chat posts and ticket updates without asking. fabrika's authority map (single merge authority, human release flips, verbatim-cited rulings) is the safer default for a two-founder product.
- **Model heterogeneity as a design axis.** pstack's role→model mapping, cross-model verification ("self-review is not a substitute"), and different-family judges are genuinely interesting — pstack holds that model diversity beats persona diversity for adversarial signal — but fabrika's single-model allowlist is enforced by the spawn hook as a founder ruling. Worth a grilling question someday, not a unilateral change.
- **Character-voice agents.** Comment Sicko is funny and reportedly effective, but fabrika's `deslop-comments` gets the same authorship/judgment separation with closed report shapes instead of a persona.

## 6. Side findings: fabrika doc drift noticed during this read

Spotted while mapping fabrika for the comparison; all filed or routed on 2026-08-20 at the founder's request (dedup by hand — this session lacks the fabrika CLI's `gh` transport):

1. `claude-plugins/fabrika/README.md` and `docs/agent-shells.md` both say **four** agent shells; there are five — already owned by open [#6437](https://github.com/kamp-us/phoenix/issues/6437); a note there adds the third surface (`docs/README.md`'s "exactly three").
2. `docs/agent-shells.md` says a shell declares an `effort:` setting; no agent file does → [#6558](https://github.com/kamp-us/phoenix/issues/6558) (priors #5696/#5697 closed).
3. skill-conventions §13 is headed "Six skills fork" but lists five — already owned by open [#5941](https://github.com/kamp-us/phoenix/issues/5941).
4. `.out-of-scope/` is cited as a first-class scope law but the directory does not exist → [#6561](https://github.com/kamp-us/phoenix/issues/6561) (prior #5667 closed in the 2026-08-19 p2 purge).
5. `graduate` still routes source-closing to the deleted `pipeline-cli tracker graduate` → [#6559](https://github.com/kamp-us/phoenix/issues/6559).
6. `docs/README.md` still frames the docs as pending landings of #4648's children; all seven exist → [#6560](https://github.com/kamp-us/phoenix/issues/6560).
7. `operate`'s "lane open/emit exist only as spec on #5688" line is stale — both verbs shipped → [#6562](https://github.com/kamp-us/phoenix/issues/6562) (prior #5880 closed in the purge).
8. The CLI README documents 27 of 28 groups; `config` has no section → [#6563](https://github.com/kamp-us/phoenix/issues/6563).
