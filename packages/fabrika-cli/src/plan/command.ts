/**
 * The `plan` verb group — `fabrika plan <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * `--polarity` is declared as a string on purpose. A value off its closed vocabulary is a **semantic
 * refusal** (`10`), not a malformed-flag usage error (`1`), so the check belongs to the verb.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runApproval} from "./approval-verb.ts";
import {runApprove} from "./approve-verb.ts";
import {runCheck} from "./check-verb.ts";
import {runFlip} from "./flip-verb.ts";
import {runRead} from "./read-verb.ts";
import {runVerdict} from "./verdict-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const epicArg = Argument.integer("number").pipe(
	Argument.withDescription("the epic whose ledger this verb reads"),
);

const tokenFlag = Flag.string("token").pipe(
	Flag.withDescription(
		"the claim token `build claim <epic> --purpose gate` handed this lane — its identity",
	),
);

const digestFlag = Flag.string("digest").pipe(
	Flag.withDescription(
		"the 12-lowercase-hex scope digest `plan check` printed; the verb recomputes it and refuses on 21 if the plan moved",
	),
);

const read = leafCommand(
	"read",
	{number: epicArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(
			yield* runRead({number, repo: Option.getOrNull(repo), cwd: process.cwd(), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("The epic, its children and its parsed ledger."),
	Command.withDescription(
		'Fetch the epic and its native sub-issue children, parse the ledger, and print it as one object: {"answer":"read","epic":n,"children":[…],"epicStories":[…],"cycleDoc":"present|absent|unknown","topology":{…},"digest":"…"}. Fetch and registered parses only — no judgment. Each child carries the three-state assignee slot (assigneesObserved false and assignees null when the payload carried no assignees key), the acceptance-criteria token uncollapsed, and its **Stories:**/**Containment:** fields. Exits 4 (a ledger section or field line appears twice, the ## Dependencies block is unparseable, or a non-empty ### User stories list is not contiguous from 1), 7 (the epic is proven absent or closed, or it has zero sub-issue children), 10 (the issue is not a type:epic), 11 (the epic, the sub-issue list or a child could not be read). Example: fabrika plan read 4300',
	),
);

const check = leafCommand(
	"check",
	{number: epicArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(
			yield* runCheck({number, repo: Option.getOrNull(repo), cwd: process.cwd(), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("The deterministic floor over the fourteen hard defect types."),
	Command.withDescription(
		'The deterministic floor over the fourteen hard defect types — the whole pass/fail decision. BOTH arms exit 0 and the discriminator is the "answer" state word (clean | defective); a defective floor is this verb\'s answer, never its refusal, and the guard against acting on one lives at `plan flip`\'s own re-gate. "skipped" names a class that could not be derived (today only MISSING_CONTAINMENT, and only when the cycle-doc probe failed) — it never makes the floor clean by omission. Exits 4 (the ledger grammar refused), 7 (zero scope), 10 (the issue is not a type:epic), 11 (a read the floor depends on failed — a child, a referenced issue, a dependent\'s blocked_by list, or the control-plane roster — UNKNOWN, never "not approved" and never "no edge"), 25 (the plan is not approved as it now stands: no standing marker, or one binding a digest the plan has moved off — refused BEFORE the floor is derived, so an unapproved AND defective plan refuses on this, ADR 0289). Example: fabrika plan check 4300',
	),
);

const flip = leafCommand(
	"flip",
	{number: epicArg, digest: digestFlag, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, digest, token, repo}) {
		yield* emit(
			yield* runFlip({
				number,
				digest,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Flip every planned child to triaged, re-gating first."),
	Command.withDescription(
		'Flip every status:planned child to status:triaged, re-gating first, and report the OBSERVED results as a tally over every child — flipped | already | unchanged | not-planned, read back from GitHub, never asserted from intent. status:triaged is added before status:planned is removed, always, so a child caught mid-write still carries a status: label. Zero planned children is an answer with terminal "nothing-to-flip", not a refusal. Exits 4 (the grammar refused during the re-gate), 7 (zero children), 8 (a write was attempted and no re-read could prove its outcome), 10 (not a type:epic, or --digest is not 12 lowercase hex), 11 (a read failed — nothing was written), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, since ownership turns on the whole token and never the session id, #6060), 20 (the re-gate derived hard defects), 21 (the plan moved since the check), 22 (at least one child is unchanged — the refs are on stderr), 23 (a label the flip must write is absent from the repo taxonomy — refused, never created, #4285), 25 (the plan is not approved as it now stands — the re-gate covers the human decision too, so a check that passed before a re-plan cannot be carried past this write, ADR 0289). Example: fabrika plan flip 4300 --digest 4d90e1bb27ac --token build:s-9f2e:c1a4d6f8-…',
	),
);

const verdict = leafCommand(
	"verdict",
	{
		number: epicArg,
		digest: digestFlag,
		token: tokenFlag,
		polarity: Flag.string("polarity").pipe(
			Flag.optional,
			Flag.withDescription(
				"an optional cross-check: PASS or FAIL. The verb derives its own polarity from the floor; a supplied value that disagrees is a 10 refusal, never the posted verdict",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, digest, token, polarity, repo}) {
		yield* emit(
			yield* runVerdict({
				number,
				digest,
				token,
				polarity: Option.getOrNull(polarity),
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the plan gate's verdict, bound to the scope digest."),
	Command.withDescription(
		'Post the gate\'s verdict comment, bound to the scope digest, and read it back. Prints {"answer":"posted","epic":n,"polarity":"PASS","digest":"…","skipped":[],"comment":id,"caveats":k}. The polarity is DERIVED by re-running the floor — a caller never supplies it. Optional stdin carries advisory caveats, one per line, "caveat: <kind> #<ref> — <text>", over the closed set ac-not-checkable | brief-fidelity | slice-too-broad | dependency-implied-not-declared; an empty stdin is an ordinary answer. Exits 4 (the grammar refused), 5/6 (the authored caveats carry a machine-local path, or are a bare @ path reference), 7 (zero children), 8 (posted and unprovable — UNKNOWN), 9 (posted but the read-back does not match), 10 (--digest malformed, not a type:epic, --polarity disagrees with the derived floor, an off-set caveat kind, or a caveat naming a ref outside the scanned set), 11 (a read failed — nothing was posted), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, since ownership turns on the whole token and never the session id, #6060), 21 (the plan moved since the check), 25 (the plan is not approved as it now stands — nothing is posted, not even a FAIL: a posted verdict is the gate saying it ran, ADR 0289). Example: fabrika plan verdict 4300 --digest 4d90e1bb27ac --token build:s-9f2e:c1a4d6f8-… < caveats.md',
	),
);

const approve = leafCommand(
	"approve",
	{number: epicArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(
			yield* runApprove({
				number,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record a control-plane approval of the epic's plan."),
	Command.withDescription(
		'Post the approval marker on the epic, bound to the scope digest this verb derives itself, and read it back. Prints {"answer":"approved","epic":n,"digest":"…","by":"…","at":"…","comment":id}. There is NO --digest flag and adding one would be the defect: an approval whose scope its caller supplies attests whatever the caller pleased, and the binding is the whole point (ADR 0289). The control-plane roster is resolved at write time from .github/CODEOWNERS on the default branch, through the same modules `ship cp-approval` uses. Exits 4 (the ledger grammar refused), 7 (the epic is proven absent or closed, or it has zero children), 8 (posted and unprovable — UNKNOWN), 9 (posted but the read-back does not match), 10 (the issue is not a type:epic), 11 (a read failed — including the roster read, which is never "not approved" and never "approved", #4223; nothing was posted), 24 (the invoking account is not on the roster, or the roster names nobody). Example: fabrika plan approve 5843',
	),
);

const approval = leafCommand(
	"approval",
	{number: epicArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(
			yield* runApproval({
				number,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Report the epic's approval state — current, stale or absent."),
	Command.withDescription(
		'Report whether the epic\'s plan carries a current approval. Prints {"answer":"approval","epic":n,"state":"current|stale|absent","by":"…","markerDigest":"…","derivedDigest":"…","at":"…","comment":id,"disregarded":k,"unauthorized":k}. A REPORTING surface, never the enforcement: an absent approval is this verb\'s answer at exit 0, while `plan check` / `plan flip` / `plan verdict` each re-derive the approval themselves and refuse on 25. The control-plane roster is resolved at READ time too, so a marker from an account outside it is not an approval however fresh its digest, and is counted in "unauthorized" (ADR 0289). Both digests are printed so a stale answer shows what moved. A marker that reaches for the format and drifts is counted in "disregarded" rather than folded into "absent". Exits 4 (the ledger grammar refused), 7 (the epic is proven absent or closed, or it has zero children), 10 (the issue is not a type:epic), 11 (the epic, a child, the roster or the comment list could not be read — the state is UNKNOWN, not absent). Example: fabrika plan approval 5843',
	),
);

export const planCommand = Command.make("plan").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		read,
		check,
		flip,
		verdict,
		approve,
		approval,
	]),
	Command.withShortDescription("Gate an epic's plan before its children build."),
	Command.withDescription(
		"Gate an epic's plan: read its ledger, derive the deterministic floor, flip its planned children into the build pool, and post the verdict bound to the scope digest",
	),
);
