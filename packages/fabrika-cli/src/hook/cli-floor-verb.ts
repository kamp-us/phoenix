/**
 * `hook cli-floor` — at session start, warn when the running CLI is older than the minimum the
 * fabrika plugin declares.
 *
 * The plugin root comes from `$CLAUDE_PLUGIN_ROOT`, which the harness sets for a plugin's own hooks.
 * The warning travels as `systemMessage`, the hook-output field the harness shows the user; a met
 * minimum answers with a fabrika-namespaced token under `suppressOutput`, so the adopter sees
 * nothing new.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9675#issuecomment-5790600028
 */
import {Effect, FileSystem, Path} from "effect";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	belowFloorWarning,
	CLI_FLOOR_FILE,
	type FloorSource,
	type FloorVerdict,
	judgeCliFloor,
} from "./cli-floor.ts";
import {FLOOR_UNKNOWN} from "./codes.ts";

const VERB = "fabrika hook cli-floor";

export const PLUGIN_ROOT_ENV = "CLAUDE_PLUGIN_ROOT";

export interface CliFloorOptions {
	/** The running CLI's own version. */
	readonly installed: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Reads the floor file at an absolute path; a failed read is `Unreadable`, never an error. */
	readonly read: (path: string) => Effect.Effect<FloorSource>;
}

export const readFloorFile = (
	path: string,
): Effect.Effect<FloorSource, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path).pipe(
			Effect.map((text): FloorSource => ({_tag: "Text", text})),
			Effect.catch((error) =>
				Effect.succeed<FloorSource>({_tag: "Unreadable", reason: `${path}: ${error.message}`}),
			),
		);
	});

const outcomeFor = (verdict: FloorVerdict, scope: string): VerbOutcome => {
	switch (verdict._tag) {
		case "Unknown":
			return refuse(FLOOR_UNKNOWN, `${VERB}: UNKNOWN — ${verdict.reason}`, [scope]);
		case "Below": {
			const warning = belowFloorWarning(verdict);
			return answer(
				JSON.stringify({
					systemMessage: warning,
					fabrika: {
						verb: "hook cli-floor",
						outcome: "below",
						installed: verdict.installed,
						minimum: verdict.minimum,
					},
				}),
				[scope, warning],
			);
		}
		case "Met":
			return answer(
				JSON.stringify({
					suppressOutput: true,
					fabrika: {
						verb: "hook cli-floor",
						outcome: "met",
						installed: verdict.installed,
						minimum: verdict.minimum,
					},
				}),
				[scope],
			);
	}
};

export const runCliFloor = ({
	installed,
	env,
	read,
}: CliFloorOptions): Effect.Effect<VerbOutcome, never, Path.Path> =>
	Effect.gen(function* () {
		const root = env[PLUGIN_ROOT_ENV];
		if (root === undefined || root.trim() === "")
			return refuse(
				FLOOR_UNKNOWN,
				`${VERB}: UNKNOWN — $${PLUGIN_ROOT_ENV} is unset, so there is no plugin minimum to compare against`,
			);
		const path = yield* Path.Path;
		const floorPath = path.join(root, CLI_FLOOR_FILE);
		const floor = yield* read(floorPath);
		return outcomeFor(
			judgeCliFloor({installed, floor}),
			`${VERB}: compared v${installed} with ${CLI_FLOOR_FILE} under $${PLUGIN_ROOT_ENV}`,
		);
	});
