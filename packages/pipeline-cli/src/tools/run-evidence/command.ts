/**
 * The `run-evidence` tool — `pipeline-cli run-evidence read --pr N | --sha S [--expect <state>]`.
 *
 *   node src/bin.ts run-evidence read --pr 3951                    # exit 0 = a validated bundle is PRESENT
 *   node src/bin.ts run-evidence read --pr 3951 --expect pending   # exit 0 = genuinely not-yet-published
 *
 * The single tested bundle lookup a gate cites instead of hand-rolling the `gh api` chain (#3991,
 * the same single-source move as `verdict read` / `checks read`). stdout is the JSON reading —
 * including `reportLine`, the ready-to-paste `Run-evidence bundle:` line a verdict carries with its
 * lookup evidence — and the exit status answers "is it the state I expected" (default `present`).
 *
 * A non-`present` exit is NOT an error the caller should treat as absence: read `state` for which of
 * the four it was. `RunEvidenceIoLive` is baked in with `Command.provide(...)` so the registered
 * command's residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {RunEvidenceIo, RunEvidenceIoLive} from "./github.ts";
import {type BundleState, classifyBundle, renderReportLine} from "./run-evidence.ts";

const FAIL_EXIT_CODE = 1;

const STATES: ReadonlyArray<BundleState> = ["present", "pending", "absent", "unknown"];

const prFlag = Flag.integer("pr").pipe(
	Flag.optional,
	Flag.withDescription("the pull request whose live head the bundle must be bound to"),
);

const shaFlag = Flag.string("sha").pipe(
	Flag.optional,
	Flag.withDescription("the head SHA to look up directly (alternative to --pr)"),
);

const expectFlag = Flag.string("expect").pipe(
	Flag.optional,
	Flag.withDescription(`the state an exit 0 means: ${STATES.join(" | ")} (default: present)`),
);

const fail = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`run-evidence: ${reason}\n`);
		process.exit(FAIL_EXIT_CODE);
	});

const parseExpect = (raw: Option.Option<string>): Effect.Effect<BundleState> => {
	const value = Option.getOrElse(raw, () => "present")
		.trim()
		.toLowerCase();
	return (STATES as ReadonlyArray<string>).includes(value)
		? Effect.succeed(value as BundleState)
		: fail(`invalid --expect '${value}' — expected one of ${STATES.join(" | ")}`);
};

const read = Command.make(
	"read",
	{pr: prFlag, sha: shaFlag, expect: expectFlag},
	Effect.fn(function* ({pr, sha, expect}) {
		const expected = yield* parseExpect(expect);
		const io = yield* RunEvidenceIo;
		const pinned = Option.getOrUndefined(sha);
		const prNumber = Option.getOrUndefined(pr);
		if ((pinned === undefined) === (prNumber === undefined)) {
			return yield* fail("pass exactly one of --pr <n> or --sha <sha>");
		}
		const head = pinned ?? (yield* io.headSha(prNumber as number));
		const reading = classifyBundle(yield* io.probe(head));
		const reportLine = renderReportLine(reading);
		yield* Console.log(
			JSON.stringify({
				state: reading.state,
				reason: reading.reason,
				detail: reading.detail,
				evidence: reading.evidence,
				manifest: reading.manifest,
				reportLine,
			}),
		);
		if (reading.state === expected) {
			process.stderr.write(`${reportLine}\n`);
			return;
		}
		return yield* fail(`${reportLine} (expected ${expected})`);
	}),
).pipe(
	Command.withDescription(
		"Resolve a PR head's run-evidence bundle to present | pending | absent | unknown with its lookup evidence (exit 0 = the state matches --expect, default present)",
	),
);

export const runEvidenceCommand = Command.make("run-evidence").pipe(
	Command.withSubcommands([read]),
	Command.withDescription(
		"Read a PR head's SHA-bound run-evidence bundle — the shared four-state lookup that never reports a pending or unreadable bundle as absent (#3991)",
	),
	Command.provide(RunEvidenceIoLive),
);
