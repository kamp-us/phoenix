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
import {runRestage} from "./restage-verb.ts";
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
		[
			'Prints the epic, its children and its parsed ledger as {"answer":"read",…} JSON.',
			"  4: the ledger grammar refused",
			"  7: the epic is absent or closed, or has no children",
			"  10: not a type:epic",
			"  11: a read failed (UNKNOWN)",
			'  Derivation: the check-epic-plan skill\'s contract.md, "plan read"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika plan read 9420"}]),
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
	Command.withShortDescription("The deterministic floor over the fifteen hard defect types."),
	Command.withDescription(
		[
			'Derives the floor over the fifteen defect types and prints {"answer":"clean|defective",…}.',
			"  4: the ledger grammar refused",
			"  7: zero scope",
			"  10: not a type:epic",
			"  11: a read the floor needs failed (UNKNOWN)",
			"  25: the plan is not approved as it now stands",
			'  Derivation: the check-epic-plan skill\'s contract.md, "plan check"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika plan check 9420"}]),
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
		[
			'Re-gates, flips every planned child to status:triaged, and prints {"answer":"flipped",…}.',
			"  4: the ledger grammar refused",
			"  7: zero children",
			"  8: a write is unproven (UNKNOWN)",
			"  10: not a type:epic, or --digest is malformed",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			"  20: the re-gate found hard defects",
			"  21: the plan moved since the check",
			"  22: a child is unchanged; refs on stderr",
			"  23: a label to write is absent from the taxonomy",
			"  25: the plan is not approved as it now stands",
			'  Derivation: the check-epic-plan skill\'s contract.md, "plan flip"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika plan flip 9420 --digest 4d90e1bb27ac --token build:s-9f2e:c1a4d6f8-…"},
	]),
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
		[
			'Posts the plan gate\'s verdict bound to the scope digest and prints {"answer":"posted",…}.',
			'  Stdin, optional: "caveat: <kind> #<ref> — <text>" lines.',
			"  4: the ledger grammar refused",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: zero children",
			"  8: posted and unprovable (UNKNOWN)",
			"  9: posted; the read-back does not match",
			"  10: a value off its vocabulary",
			"  11: a read failed; nothing was posted",
			"  15: this lane does not hold the epic's claim",
			"  21: the plan moved since the check",
			"  25: the plan is not approved as it stands",
			'  Derivation: the check-epic-plan skill\'s contract.md, "plan verdict"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika plan verdict 9420 --digest 4d90e1bb27ac --token build:s-9f2e:c1a4d6f8-… < caveats.md",
		},
	]),
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
	Command.withShortDescription("Record a control-plane account's approval of the epic's plan."),
	Command.withDescription(
		[
			'Posts an approval bound to the scope digest it derives and prints {"answer":"approved",…}.',
			"  4: the ledger grammar refused",
			"  7: the epic is absent or closed, or has no children",
			"  8: posted and unprovable (UNKNOWN)",
			"  9: posted; the read-back does not match",
			"  10: not a type:epic",
			"  11: a read failed; nothing was posted",
			"  24: the invoking account is not on the control-plane roster",
			'  Derivation: the check-epic-plan skill\'s contract.md, "Verb inventory"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika plan approve 9420"}]),
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
		[
			'Prints the epic\'s approval state as {"answer":"approval","state":"current|stale|absent",…}.',
			"  4: the ledger grammar refused",
			"  7: the epic is absent or closed, or has no children",
			"  10: not a type:epic",
			"  11: a read failed; the state is UNKNOWN, not absent",
			'  Derivation: the check-epic-plan skill\'s contract.md, "Verb inventory"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika plan approval 9420"}]),
);

const restage = leafCommand(
	"restage",
	{number: epicArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(yield* runRestage({number, token, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription(
		"Reconcile a minted epic's Dependencies region against its children.",
	),
	Command.withDescription(
		[
			'Drops refs closed unlanded from Dependencies and prints {"answer":"restaged|unchanged",…}.',
			"  4: the Dependencies block is unparseable",
			"  7: the epic is absent or closed, has no children, or no region",
			"  8: the PATCH is unconfirmed (UNKNOWN)",
			"  9: written; it does not read back as composed",
			"  10: not a type:epic",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			"  26: the Dependencies region has no single meaning",
			"  27: every named issue closed unlanded; re-plan",
			'  Derivation: the check-epic-plan skill\'s contract.md, "plan restage"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika plan restage 9420 --token build:s-9f2e:c1a4d6f8-…"}]),
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
		restage,
	]),
	Command.withShortDescription("Gate an epic's plan before its children build."),
	Command.withDescription(
		"Gate an epic's plan: read its ledger, derive the deterministic floor, flip its planned children into the build pool, and post the verdict bound to the scope digest",
	),
);
