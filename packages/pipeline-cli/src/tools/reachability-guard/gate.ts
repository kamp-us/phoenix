/**
 * The `reachability-guard` filesystem gate (ADR 0173) — the IO seam behind the
 * flag-reachability check, split from `command.ts` so it is crossable in unit tests over
 * a fake repo dir rather than only by spawning the bin (the core-in-its-own-file idiom;
 * #855).
 *
 * `checkReachability` is the gate: it reads the flag-key module, walks the SPA `.tsx`
 * source for consuming references and the e2e specs for `@journey` registrations, and
 * delegates the verdict to the pure core (`reachability-guard.ts`). It fails `CheckFailed`
 * (exit non-zero) on an unreachable user-facing flag, an unknown flag key, or zero parsed
 * flag definitions (fail-closed, ADR 0092). A directory/file IO failure is an `IoError`
 * (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import {
	consumedConstantsIn,
	type FlagDefinition,
	judge,
	parseFlagDefinitions,
	parseJourneyTags,
	renderReport,
} from "./reachability-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

const KEYS_PATH = join("apps", "web", "src", "flags", "keys.ts");
const SRC_ROOT = join("apps", "web", "src");
const E2E_DIR = join("apps", "web", "tests", "e2e");

// A missing UI/e2e dir is zero files, NOT an IO failure — the fail-closed scope anchor is
// the keys.ts read (zero parsed definitions ⇒ zero-scope). An absent .tsx/e2e tree then
// resolves as "no consumer / no journey", which judge correctly reports as unreachable.
const walk = (dir: string, matches: (name: string) => boolean, acc: Array<string>): void => {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			walk(abs, matches, acc);
		} else if (matches(entry.name)) {
			acc.push(abs);
		}
	}
};

/** Read + parse the flag-key module; a missing module fails as IO (not a vacuous pass). */
const readDefinitions = (root: string): Effect.Effect<ReadonlyArray<FlagDefinition>, IoError> =>
	Effect.try({
		try: () => parseFlagDefinitions(readFileSync(join(root, KEYS_PATH), "utf8")),
		catch: (cause) => new IoError({path: join(root, KEYS_PATH), cause}),
	});

/** Collect the constant names referenced by ≥1 `.tsx` under `apps/web/src`. */
const gatherConsumers = (
	root: string,
	candidateNames: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>, IoError> =>
	Effect.try({
		try: () => {
			const files: Array<string> = [];
			walk(join(root, SRC_ROOT), (name) => name.endsWith(".tsx"), files);
			const consumed = new Set<string>();
			for (const abs of files) {
				for (const name of consumedConstantsIn(readFileSync(abs, "utf8"), candidateNames)) {
					consumed.add(name);
				}
			}
			return consumed;
		},
		catch: (cause) => new IoError({path: join(root, SRC_ROOT), cause}),
	});

/** Collect the flag keys registered via `@journey:<key>` across the e2e specs. */
const gatherJourneyKeys = (root: string): Effect.Effect<ReadonlySet<string>, IoError> =>
	Effect.try({
		try: () => {
			const files: Array<string> = [];
			walk(join(root, E2E_DIR), (name) => name.endsWith(".spec.ts"), files);
			const keys = new Set<string>();
			for (const abs of files) {
				for (const key of parseJourneyTags(readFileSync(abs, "utf8"))) keys.add(key);
			}
			return keys;
		},
		catch: (cause) => new IoError({path: join(root, E2E_DIR), cause}),
	});

/**
 * The gate: succeed when `flagKey` is reachable (a consuming `.tsx` + a registered journey
 * e2e) or exempt, else `CheckFailed`. Fails closed on zero parsed flag definitions and on
 * an unknown flag key (ADR 0092 / 0173 §1).
 */
export const checkReachability = (
	root: string,
	flagKey: string,
): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const definitions = yield* readDefinitions(root);
		const consumingConstants = yield* gatherConsumers(
			root,
			definitions.map((d) => d.constantName),
		);
		const journeyKeys = yield* gatherJourneyKeys(root);
		const verdict = judge({flagKey, definitions, consumingConstants, journeyKeys});
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
