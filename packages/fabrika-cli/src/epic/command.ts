/**
 * The `epic` verb group — `fabrika epic <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * `--event` and `--polarity` are declared as strings on purpose. A value off their closed vocabulary
 * is a **semantic refusal** (`10`), not a malformed-flag usage error (`1`), so the check belongs to
 * the verb and not to the parser.
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runBrief} from "./brief-verb.ts";
import {runLanded} from "./landed-verb.ts";
import {DEAD_AXIS_CAP, EPIC_EVENTS, FAIL_AXIS_CAP} from "./ledger.ts";
import {runNext} from "./next-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runRecord} from "./record-verb.ts";
import {runSliceDiff} from "./slice-diff-verb.ts";
import {runStatus} from "./status-verb.ts";
import {runVerdict} from "./verdict-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const epicArg = Argument.integer("number").pipe(
	Argument.withDescription("the epic issue this run conducts"),
);

const sliceFlag = Flag.string("slice").pipe(
	Flag.withDescription("the slice id this verb acts on, as the planned ledger names it (C<n>)"),
);

const open = leafCommand(
	"open",
	{number: epicArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(
			yield* runOpen({
				number,
				repo: Option.getOrNull(repo),
				env: process.env,
				at: new Date().toISOString(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Open or resume an epic run and print its state."),
	Command.withDescription(
		'Open or resume the run: parse the epic\'s slice topology, create the nonce-keyed run ledger if absent, print run state. Prints {"answer":"opened","epic":n,"run":"<epic>-<nonce>","slices":[…],"order":[…],"resumed":false}; a ledger already at this key answers "resumed":true and the run picks up where it left off. Runs the tree and claim assertions only — never the lane branch, because this verb precedes `fabrika build branch`. Exits 4 (no parseable planned ledger or "## Dependencies" block — "no parseable slices" is never "no slices"), 7 (the epic or a named child is proven absent or closed), 10 (the issue is not a type:epic), 11 (the epic, a child or the ledger path could not be read or created), 15 (this session does not hold the epic\'s claim), 21 (a ledger exists at this key and holds unnameable state). Example: fabrika epic open 4300',
	),
);

const next = leafCommand(
	"next",
	{number: epicArg},
	Effect.fn(function* ({number}) {
		yield* emit(yield* runNext({number, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("The one next action for this run."),
	Command.withDescription(
		`The state relay: ledger + git graph folded into exactly one next action. Prints one JSON object whose "action" is dispatch-slice | evaluate-slice | retry-slice | escalate-slice | open-pr | done | halted. Reads no GitHub beyond the lane guard, spawns nothing, judges nothing. The two retry breakers are its arithmetic and are never summed: the fail axis caps at ${FAIL_AXIS_CAP}, the dead axis at ${DEAD_AXIS_CAP}; escalate-slice is an ANSWER on exit 0, not the 23 refusal. Exits 11 (the ledger or the graph could not be read), 14/15 (the lane guard's refusals), 20 (no ledger at this run's key — run "fabrika epic open <n>" first), 21 (the ledger holds unnameable state). Example: fabrika epic next 4300`,
	),
);

const record = leafCommand(
	"record",
	{
		number: epicArg,
		event: Flag.string("event").pipe(
			Flag.withDescription(
				`the event to append, from the closed set: ${EPIC_EVENTS.join(" | ")} — verdict-recorded is written only by "fabrika epic verdict"`,
			),
		),
		slice: sliceFlag.pipe(Flag.optional),
		detail: Flag.string("detail").pipe(
			Flag.optional,
			Flag.withDescription(
				"one line of detail — a classification token, an escalation reason; never free prose read back as instruction",
			),
		),
	},
	Effect.fn(function* ({number, event, slice, detail}) {
		yield* emit(
			yield* runRecord({
				number,
				event,
				slice: Option.getOrNull(slice),
				detail: Option.getOrNull(detail),
				env: process.env,
				at: new Date().toISOString(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Append one event to the run ledger."),
	Command.withDescription(
		'Append one closed-vocabulary event to the run ledger, append-only, and read the tail back. Prints {"answer":"recorded","seq":n,"event":"…","slice":"…"}. The HEAD SHA is SELF-CAPTURED into slice-dispatched and slice-landed — a caller-supplied SHA would reopen the self-report hole this group closes — so the answer omits it and the read-back proves it from the artifact. Exits 8 (the append could not be proven — UNKNOWN), 9 (the tail does not read back), 10 (--event off-enum, --slice unknown to the run, or the event contradicts derived state), 11 (a required read failed), 14/15 (the lane guard\'s refusals), 20 (no ledger at this run\'s key), 21 (unnameable ledger state), 23 (the slice\'s breaker is at cap — only breaker-tripped or run-halted). Example: fabrika epic record 4300 --event slice-dispatched --slice C2',
	),
);

const brief = leafCommand(
	"brief",
	{
		number: epicArg,
		slice: sliceFlag,
		retry: Flag.boolean("retry").pipe(
			Flag.withDescription(
				"compose the retry form: prepend the Fix-First line from the latest FAIL verdict (default: false)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, slice, retry, repo}) {
		yield* emit(
			yield* runBrief({
				number,
				slice,
				retry,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The dispatch brief for one slice."),
	Command.withDescription(
		"The dispatch brief for one slice, emitted through the registered slice-handoff wire format: ## Slice (the child's acceptance criteria verbatim), ## Ground (tree, branch, base SHA, the per-slice handoff path), ## Rules (byte-fixed text the format owns), and ## Fix-First with --retry. The document is NOT leak-scanned — ## Ground carries machine-local paths by construction, so a brief is consumed in-session and never posted. Exits 4 (the child's acceptance criteria are absent or malformed — no criterion is invented), 7 (the child issue is proven absent or closed), 10 (--slice unknown to this run, or --retry with no FAIL verdict on record), 11 (the ledger, the child issue or the git base could not be read), 14/15 (the lane guard's refusals), 20 (no ledger at this run's key), 21 (unnameable ledger state), 23 (the slice's breaker is at cap — escalate, do not dispatch). Example: fabrika epic brief 4300 --slice C2",
	),
);

const landed = leafCommand(
	"landed",
	{number: epicArg, slice: sliceFlag},
	Effect.fn(function* ({number, slice}) {
		yield* emit(yield* runLanded({number, slice, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Prove a slice's commit landed, from the git graph alone."),
	Command.withDescription(
		'Prove a slice\'s commit landed, from the git graph alone and NEVER from a subagent\'s report: HEAD moved since the slice\'s opening SHA, the old tip is an ancestor of the new HEAD, the tree is clean, and the commit is non-empty. Prints {"answer":"landed","slice":"…","commit":"…","parent":"…","files":n}. Exits 7 (the new commit changes zero files), 10 (the old tip is not an ancestor — history was rewritten under the run; a human decides), 11 (the ledger or git state could not be read), 14/15 (the lane guard\'s refusals), 13 (proven: the tree is dirty beside the new commit), 20 (no ledger at this run\'s key), 21 (unnameable ledger state), 22 (proven: HEAD is unchanged since the slice opened — a dead dispatch, distinct from a failed slice). Example: fabrika epic landed 4300 --slice C2',
	),
);

const sliceDiff = leafCommand(
	"slice-diff",
	{
		number: epicArg,
		commit: Flag.string("commit").pipe(
			Flag.withDescription("the slice commit to serve, 7–40 lowercase hex, resolved locally"),
		),
	},
	Effect.fn(function* ({number, commit}) {
		yield* emit(yield* runSliceDiff({number, commit}));
	}),
).pipe(
	Command.withShortDescription("The unpushed slice commit's diff against its first parent."),
	Command.withDescription(
		"The unpushed commit's unified diff against its first parent, served from the local object store exactly as git show gives it — no push, no CI dependency, no draft PR. Completeness is the object store's: a commit that resolves serves in full or the read fails. Runs the TREE assertion only — an evaluator holds no claim, it reads. Exits 7 (the diff is empty — nothing to review, ADR 0092), 10 (--commit is not 7–40 lowercase hex), 11 (the git read failed), 24 (proven: the commit is not in this branch's local graph). Example: fabrika epic slice-diff 4300 --commit 8c1f2a9d",
	),
);

const verdict = leafCommand(
	"verdict",
	{
		number: epicArg,
		slice: sliceFlag,
		commit: Flag.string("commit").pipe(
			Flag.withDescription("the exact commit the evaluator read, 7–40 lowercase hex"),
		),
		polarity: Flag.string("polarity").pipe(
			Flag.withDescription("PASS or FAIL — a third token is not a polarity, it is a 10 refusal"),
		),
	},
	Effect.fn(function* ({number, slice, commit, polarity}) {
		yield* emit(
			yield* runVerdict({
				number,
				slice,
				commit,
				polarity,
				env: process.env,
				at: new Date().toISOString(),
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record one slice verdict, bound to its commit SHA."),
	Command.withDescription(
		'Record one slice verdict from the body on STDIN, bound to the commit SHA in the local graph — content-addressed, so any amend or rebase makes the old verdict unbindable rather than stale. Prints {"answer":"recorded","slice":"…","polarity":"PASS","commit":"…","seq":n}. The recorded marker is composed by the shared verdict-marker format under the namespace slice:<id>, its clause the body\'s first line, which is what next injects as Fix-First. Exits 3 (stdin held nothing), 8 (the append could not be proven), 9 (the tail does not read back), 10 (polarity off-enum, or --commit is not the slice\'s landed commit), 11 (a required read failed), 14/15 (the lane guard\'s refusals), 20 (no ledger at this run\'s key), 21 (unnameable ledger state), 23 (the slice\'s breaker is at cap), 24 (the commit is not in the local graph). Example: fabrika epic verdict 4300 --slice C2 --commit 8c1f2a9d --polarity FAIL < findings.md',
	),
);

const status = leafCommand(
	"status",
	{number: epicArg},
	Effect.fn(function* ({number}) {
		yield* emit(yield* runStatus({number, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("The whole run folded from the ledger and the live graph."),
	Command.withDescription(
		"The whole run folded, derived fresh from the ledger and the live graph: per-slice state (pending | dispatched | landed | passed | retrying | escalated | dead-dispatch), each verdict four-valued against the graph (current | fail | none | unbindable — an unbindable verdict is surfaced, never dropped and never rendered as current), both per-slice counters, and the run counters. This fold is the handoff artifact: a successor session resumes from it and the ledger, not from anyone's narrative. Exits 11, 14/15, 20, 21 — triggers exactly as in `fabrika epic next`. Example: fabrika epic status 4300",
	),
);

export const epicCommand = Command.make("epic").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		open,
		next,
		record,
		brief,
		landed,
		sliceDiff,
		verdict,
		status,
	]),
	Command.withShortDescription("Conduct one epic as a single pull request."),
	Command.withDescription(
		"Conduct one epic as a single PR: open the nonce-keyed run ledger, relay the next action, brief and prove each slice from the git graph, and bind a verdict to the unpushed commit",
	),
);
