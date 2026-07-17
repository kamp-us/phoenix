/**
 * The `cp-cardinality` tool — `pipeline-cli cp-cardinality decide [flags]` (issue #2541).
 *
 *   printf '%s\n' "$MEMBERS" | pipeline-cli cp-cardinality decide \
 *     --author "$AUTHOR" [--non-author-approval-at-head] [--self-approval-at-head]
 *
 * The deterministic §CP discharge decision ship-it's control-plane approval gate runs
 * (ADR 0175, enforcing decision #2435). Reads the active `@kamp-us/control-plane` member
 * logins from stdin (one per line, like class-probe reads changed files), takes the PR
 * author and the two current-head approval signals as flags, and prints the decision word
 * (`discharge` | `stop`) to **stdout** — the token ship-it branches on. A human reason goes
 * to **stderr**. Exit code mirrors the decision: 0 on `discharge`, 1 on `stop`, so the gate
 * bash can `pipeline-cli cp-cardinality decide … && carry-on || STOP` and fail closed.
 *
 * IO here (the thin bin); the whole ADR-0175 branch lives in `cp-cardinality.ts` (the pure,
 * unit-tested core). ship-it owns the `gh api` REST resolution of the members roster, the PR
 * author/head, and the two SHA-bound signals — the integration half this tool never touches.
 */
import {readFileSync} from "node:fs";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CpCardinalityInput, decideCpCardinality} from "./cp-cardinality.ts";

const authorFlag = Flag.string("author").pipe(
	Flag.withDescription("the PR author login (keys the single-owner branch)"),
);

const nonAuthorApprovalFlag = Flag.boolean("non-author-approval-at-head").pipe(
	Flag.withDescription(
		"a current-head APPROVED review by a control-plane member who is NOT the author exists",
	),
);

const selfApprovalFlag = Flag.boolean("self-approval-at-head").pipe(
	Flag.withDescription(
		"a current-head self-approval marker authored by the sole owner exists (N==1 discharge signal)",
	),
);

/** Read the control-plane member logins from stdin; empty/failed read ⇒ N==0 (fail closed). */
const readMembers = (): ReadonlyArray<string> => {
	let raw: string;
	// biome-ignore lint/plugin: best-effort read — an empty/failed stdin is absorbed into [] (⇒ N==0, fail closed), never the E channel; a total helper, not Effect-cosplay.
	try {
		raw = readFileSync(0, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
};

const decideCmd = Command.make(
	"decide",
	{
		author: authorFlag,
		nonAuthorApproval: nonAuthorApprovalFlag,
		selfApproval: selfApprovalFlag,
	},
	Effect.fn(function* ({author, nonAuthorApproval, selfApproval}) {
		const input: CpCardinalityInput = {
			members: readMembers(),
			author,
			nonAuthorApprovalAtHead: nonAuthorApproval,
			selfApprovalAtHead: selfApproval,
		};
		const verdict = decideCpCardinality(input);
		yield* Effect.sync(() =>
			process.stderr.write(
				`cp-cardinality: N=${verdict.n} branch=${verdict.branch} — ${verdict.reason}\n`,
			),
		);
		yield* Console.log(verdict.decision);
		// Exit code mirrors the decision so the gate bash fails closed on `stop` (ADR 0175).
		if (verdict.decision === "stop") return yield* Effect.sync(() => process.exit(1));
	}),
).pipe(
	Command.withDescription(
		"Decide the §CP discharge deterministically from control-plane team cardinality (ADR 0175, #2541)",
	),
);

export const cpCardinalityCommand = Command.make("cp-cardinality").pipe(
	Command.withSubcommands([decideCmd]),
	Command.withDescription(
		"Deterministic §CP team-cardinality discharge check ship-it's control-plane gate runs (ADR 0175, #2541)",
	),
);
