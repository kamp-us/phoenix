/**
 * The `crew-fanout-guard` filesystem gate — the IO seam behind #3606's "every crew bridge
 * denies every non-allowlisted mutating roster agent-type" check, split from `command.ts`
 * so it is crossable in unit tests over a fake repo dir rather than only by spawning the
 * bin (the core-in-its-own-file idiom).
 *
 * `checkCrewFanout` enumerates the two agent-def dirs (the kampus-pipeline roster + the
 * pipeline-crew roster), parses each def's `name`/`disallowedTools`, resolves the three
 * bridge defs, and delegates the verdict to the pure core (`crew-fanout-guard.ts`). It
 * fails `CheckFailed` (exit non-zero) on any non-passing verdict — an uncovered agent-type,
 * a missing bridge, a stale allowlist, or zero scope (fail-closed, ADR 0092). A directory/
 * file IO failure is an `IoError` (also non-zero — both failures, undistinguished).
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {
	type AgentDef,
	BRIDGE_NAMES,
	judge,
	parseAgentDef,
	renderReport,
} from "./crew-fanout-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/** The two agent-def dirs whose union is the crew's spawnable roster. */
const AGENT_DIRS = [
	"claude-plugins/kampus-pipeline/agents",
	"claude-plugins/pipeline-crew/agents",
] as const;

/** Read + parse every `*.md` agent def under `<root>/<dir>` (tolerant of an absent dir). */
const parseAgentDefsIn = (
	root: string,
	dir: string,
): Effect.Effect<ReadonlyArray<AgentDef>, IoError> =>
	Effect.try({
		try: () => {
			const base = join(root, dir);
			// A moved/renamed dir surfaces as zero scope / missing-bridge downstream (fail-closed),
			// not a crash — the verdict, not an ENOENT throw, carries the diagnosis.
			if (!existsSync(base)) return [];
			const out: Array<AgentDef> = [];
			for (const entry of readdirSync(base, {withFileTypes: true})) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const def = parseAgentDef(readFileSync(join(base, entry.name), "utf8"));
				if (def) out.push(def);
			}
			return out;
		},
		catch: (cause) => new IoError({path: join(root, dir), cause}),
	});

/**
 * The CI gate: succeed when every crew bridge def denies every non-allowlisted mutating
 * roster agent-type, else `CheckFailed`. Fails closed on zero scope (ADR 0092).
 */
export const checkCrewFanout = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const perDir = yield* Effect.forEach(AGENT_DIRS, (dir) => parseAgentDefsIn(root, dir), {
			concurrency: "unbounded",
		});
		const allDefs = perDir.flat();
		const rosterAgents = allDefs.map((d) => d.name);
		const byName = new Map(allDefs.map((d) => [d.name, d]));
		const bridges = BRIDGE_NAMES.map((n) => byName.get(n)).filter(
			(d): d is AgentDef => d !== undefined,
		);

		const verdict = judge({rosterAgents, bridges});
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
