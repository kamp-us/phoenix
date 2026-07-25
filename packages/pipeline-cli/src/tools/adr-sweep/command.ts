/**
 * The `adr-sweep` tool — `pipeline-cli adr-sweep shortlist --new <NNNN|path>`.
 *
 * The mechanical half of the ADR contradiction sweep the `adr` (authoring) and `review-doc`
 * (gate) skills mandate (#3980): given a new ADR, rank the live `accepted` ADRs it does NOT
 * cite by decision-domain adjacency, so the sweep is a list to clear rather than a memory test.
 * The judgement — is this entry actually re-decided? — stays with the author/reviewer; the
 * exit contract and the honest statement of what this misses live in `gate.ts` / `adr-sweep.ts`.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {DEFAULT_LIMIT} from "./adr-sweep.ts";
import {runSweep} from "./gate.ts";

const DECISIONS_DIR = ".decisions";
const ROOT_MARKERS = [DECISIONS_DIR, "pnpm-workspace.yaml", ".git"] as const;

/**
 * Resolve the default `.decisions` dir against the repo root, not the cwd — `pnpm --filter`
 * runs with cwd = the package dir, where a bare `.decisions` ENOENTs (#447; the same resolver
 * `decisions-index` uses, kept local so neither tool's default becomes the other's API).
 */
const defaultDecisionsDir = Effect.fn(function* (from: string = process.cwd()) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const start = path.resolve(from);
	let dir = start;
	for (;;) {
		for (const marker of ROOT_MARKERS) {
			if (yield* fs.exists(path.join(dir, marker)).pipe(Effect.orElseSucceed(() => false)))
				return path.join(dir, DECISIONS_DIR);
		}
		const parent = path.dirname(dir);
		if (parent === dir) return path.join(start, DECISIONS_DIR);
		dir = parent;
	}
});

const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the .decisions directory to sweep against (default: the repo-root .decisions)",
	),
);

const newFlag = Flag.string("new").pipe(
	Flag.withDescription(
		"the ADR to sweep: a bare id (`0208`) already in --dir, or a path to the ADR file",
	),
);

const limitFlag = Flag.integer("limit").pipe(
	Flag.withDefault(DEFAULT_LIMIT),
	Flag.withDescription("how many shortlist entries to emit"),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the SweepResult as JSON instead of the human report"),
);

const shortlist = Command.make(
	"shortlist",
	{dir: dirFlag, new: newFlag, limit: limitFlag, json: jsonFlag},
	Effect.fn(function* ({dir: dirOpt, new: newRef, limit, json}) {
		const dir = yield* Option.match(dirOpt, {
			onNone: () => defaultDecisionsDir(),
			onSome: Effect.succeed,
		});
		yield* runSweep({dir, newRef, limit, json}).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Rank the uncited live-accepted ADRs whose decision domain this ADR touches — exit 0 only when there is nothing to clear",
	),
);

export const adrSweepCommand = Command.make("adr-sweep").pipe(
	Command.withSubcommands([shortlist]),
	Command.withDescription(
		"Shortlist the live-accepted ADRs a new ADR may contradict but does not cite (#3980)",
	),
);
