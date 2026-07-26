/**
 * The `lane` tool — `pipeline-cli lane status [--json]` (#3964, epic #3947).
 *
 * The lane accounting the factory never had: which build lanes are occupied, who holds each,
 * and which of them are platform — computed from GitHub artifacts rather than self-reported by
 * an engine. A self-report is neither verifiable nor attributable, which is how a wrong lane
 * number (build lanes mixed with review-plan gates) reached a capacity decision.
 *
 *   pipeline-cli lane status          # the human table
 *   pipeline-cli lane status --json   # the stable machine shape the #3948 heartbeat consumes
 *
 * Read-only by construction: it resolves claims, it never writes or releases one. Enforcing the
 * 2-of-6 quota is the sibling child (#3965); this verb only reports the numbers it enforces on.
 *
 * Exit-code contract: 0 = a computed report; non-zero = the ADR-0092 empty-scan refusal or a
 * `gh`/repo failure. A non-zero exit never carries a lane count, so a caller can never mistake
 * a broken read for an idle factory.
 */
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {LaneSources, LaneSourcesLive} from "./github.ts";
import {status as computeStatus, renderReport} from "./lane.ts";

const EMPTY_SCAN_EXIT_CODE = 1;

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the machine-readable lane status on stdout instead of the table"),
);

const status = Command.make(
	"status",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		const result = computeStatus(yield* (yield* LaneSources).inventory());
		if (json) yield* Console.log(JSON.stringify(result));
		if (!result.ok) {
			// The refusal reason goes to stderr in BOTH modes, so a machine consumer branching on
			// exit status still gets the human "why" in the log (ADR 0092 §1, emit what you scanned).
			process.stderr.write(`${renderReport(result)}\n`);
			process.exit(EMPTY_SCAN_EXIT_CODE);
			return;
		}
		if (!json) yield* Console.log(renderReport(result));
	}),
).pipe(
	Command.withDescription(
		"Report the active build-lane set — each lane's stage, holder, and platform/product class — against the 6-lane capacity and 2-lane platform quota",
	),
);

export const laneCommand = Command.make("lane").pipe(
	Command.withSubcommands([status]),
	Command.withDescription(
		"Lane accounting computed off GitHub, not self-reported: the unlanded build-lane set, classified platform vs product against the founder-set 6-lane capacity / 2-lane platform quota (#3964)",
	),
	Command.provide(LaneSourcesLive),
);
