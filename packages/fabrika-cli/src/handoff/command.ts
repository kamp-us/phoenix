/**
 * The `handoff` verb group — `fabrika handoff <capture|take|read|claim>`, the `handoff` skill's half
 * of the ideation layer's continuity story.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * `take` reads its asserted half from stdin so a machine-local path has no
 * route into a posted artifact.
 */

import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runCapture} from "./capture-verb.ts";
import {runClaim} from "./claim-verb.ts";
import {runRead} from "./read-verb.ts";
import {runTake} from "./take-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const issueFlag = Flag.integer("issue").pipe(
	Flag.withDescription("the issue the work belongs to; every verb addresses one"),
);

const baseFlag = Flag.string("base").pipe(
	Flag.optional,
	Flag.withDescription(
		"the branch the work is measured against (default: the repository's default branch); a compared field, so pass the value the pack was taken with",
	),
);

const nonceFlag = Flag.string("nonce").pipe(
	Flag.withDescription(
		"this run's key, eight lowercase hex characters — authored once per run and passed explicitly, never inferred from the environment",
	),
);

const capture = leafCommand(
	"capture",
	{issue: issueFlag, base: baseFlag, repo: repoFlag},
	Effect.fn(function* ({issue, base, repo}) {
		yield* emit(
			yield* runCapture({
				issue,
				base: Option.getOrNull(base),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Derive the ground state: branch, head, tree, issue and PR."),
	Command.withDescription(
		[
			"Prints the ground state of branch, head, tree, base, issue and PR as JSON, writing nothing.",
			"  7: no such issue",
			"  11: a git or board read failed, so the ground is UNKNOWN",
			'  Derivation: the handoff skill\'s contract.md, "handoff capture"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika handoff capture --issue 5021"}]),
);

const take = leafCommand(
	"take",
	{
		issue: issueFlag,
		nonce: nonceFlag,
		base: baseFlag,
		declareUnreachable: Flag.boolean("declare-unreachable").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"seal the pack even though the work is unreachable, recording the unreachability in the proven half as a stated loss",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({issue, nonce, base, declareUnreachable, repo}) {
		yield* emit(
			yield* runTake({
				issue,
				nonce,
				base: Option.getOrNull(base),
				declareUnreachable,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Compose, post and read back the sealed handoff pack."),
	Command.withDescription(
		[
			"Seals the stdin sections and a fresh capture into one posted pack and prints it as JSON.",
			"  3: stdin held nothing",
			"  4: a section is missing, misordered, empty or off the closed set",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: no such issue",
			"  8: the comment write failed",
			"  9: the read-back differs",
			"  11: the capture or a precondition read failed; nothing was written",
			"  12: the work is unreachable and --declare-unreachable was not given",
			'  Derivation: the handoff skill\'s contract.md, "handoff take"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"printf '## Intent\\nWiden the fanout guard.\\n\\n## Established\\nA failing case is committed.\\n\\n## Next act\\nFollow one level of helper call.\\n\\n## Unsure\\nWhether one level is enough.\\n' | fabrika handoff take --issue 5021 --nonce 7f3a9c21",
		},
	]),
);

const read = leafCommand(
	"read",
	{issue: issueFlag, base: baseFlag, repo: repoFlag},
	Effect.fn(function* ({issue, base, repo}) {
		yield* emit(
			yield* runRead({
				issue,
				base: Option.getOrNull(base),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Resolve the latest sealed pack and report its drift."),
	Command.withDescription(
		[
			"Prints the latest sealed pack and its drift from the ground re-derived on its branch, as JSON.",
			"  none, sealed and claimed are all answers.",
			"  7: no such issue",
			"  11: a comment, permission or re-derivation read failed",
			"  14: the latest pack does not parse, or its digest disagrees with it",
			'  Derivation: the handoff skill\'s contract.md, "handoff read"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika handoff read --issue 5021"}]),
);

const claim = leafCommand(
	"claim",
	{issue: issueFlag, nonce: nonceFlag, repo: repoFlag},
	Effect.fn(function* ({issue, nonce, repo}) {
		yield* emit(
			yield* runClaim({
				issue,
				nonce,
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Claim the latest sealed pack for this run."),
	Command.withDescription(
		[
			"Claims the latest sealed pack, keyed on the run nonce, and prints the claim as JSON.",
			"  7: no such issue",
			"  8: the claim write failed",
			"  9: the read-back differs",
			"  11: a comment or permission read failed; nothing was written",
			"  13: no sealed pack to claim",
			"  14: the latest pack does not parse",
			"  15: another nonce holds it",
			'  Derivation: the handoff skill\'s contract.md, "handoff claim"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika handoff claim --issue 5021 --nonce 4b8e2f01"}]),
);

export const handoffCommand = Command.make("handoff").pipe(
	Command.withSubcommands([capture, take, read, claim]),
	Command.withShortDescription("Hand one session's work to the next."),
	Command.withDescription(
		"Hand one session's work to the next: derive the ground state, seal a pack of what is asserted plus what is proven, read the latest pack back with its drift, and claim it under a run nonce",
	),
);
