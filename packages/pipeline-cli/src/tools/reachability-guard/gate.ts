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
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	consumedConstantsIn,
	type FlagDefinition,
	judge,
	parseFlagDefinitions,
	parseJourneyTags,
	renderReport,
} from "./reachability-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

// Repo-relative path fragments (POSIX): combined with the absolute `root` at runtime
// through the `Path.Path` seam, so they stay plain-string literals rather than a
// module-level `node:path` join with no seam in scope.
const KEYS_PATH = "apps/web/src/flags/keys.ts";
const SRC_ROOT = "apps/web/src";
const E2E_DIR = "apps/web/tests/e2e";

/**
 * Recursively collect the files under `dir` matching `matches`, over the Effect
 * `FileSystem`/`Path` seam (over the bin's `NodeServices.layer`) so a gate `unit` test
 * substitutes an in-memory fs for the real disk (.patterns/effect-platform-access.md); a
 * fs fault folds `PlatformError` → the `IoError` this gate already carries. This is the
 * one why-note for the file's platform-seam migration — the readers below follow suit.
 *
 * A missing UI/e2e dir is zero files, NOT an IO failure — the fail-closed scope anchor is
 * the keys.ts read (zero parsed definitions ⇒ zero-scope). An absent .tsx/e2e tree then
 * resolves as "no consumer / no journey", which judge correctly reports as unreachable.
 */
const walk = (
	dir: string,
	matches: (name: string) => boolean,
): Effect.Effect<ReadonlyArray<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return [];
		const acc: Array<string> = [];
		for (const name of yield* fs
			.readDirectory(dir)
			.pipe(Effect.mapError((cause) => new IoError({path: dir, cause})))) {
			const abs = path.join(dir, name);
			const isDir =
				(yield* fs.stat(abs).pipe(Effect.mapError((cause) => new IoError({path: abs, cause}))))
					.type === "Directory";
			if (isDir) {
				if (name === "node_modules" || name === "dist") continue;
				acc.push(...(yield* walk(abs, matches)));
			} else if (matches(name)) {
				acc.push(abs);
			}
		}
		return acc;
	});

/** Read + parse the flag-key module; a missing module fails as IO (not a vacuous pass). */
const readDefinitions = (
	root: string,
): Effect.Effect<ReadonlyArray<FlagDefinition>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const keysPath = path.join(root, KEYS_PATH);
		const text = yield* fs
			.readFileString(keysPath, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: keysPath, cause})));
		return parseFlagDefinitions(text);
	});

/** Collect the constant names referenced by ≥1 `.tsx` under `apps/web/src`. */
const gatherConsumers = (
	root: string,
	candidateNames: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const files = yield* walk(path.join(root, SRC_ROOT), (name) => name.endsWith(".tsx"));
		const consumed = new Set<string>();
		for (const abs of files) {
			const source = yield* fs
				.readFileString(abs, "utf8")
				.pipe(Effect.mapError((cause) => new IoError({path: abs, cause})));
			for (const name of consumedConstantsIn(source, candidateNames)) consumed.add(name);
		}
		return consumed;
	});

/** Collect the flag keys registered via `@journey:<key>` across the e2e specs. */
const gatherJourneyKeys = (
	root: string,
): Effect.Effect<ReadonlySet<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const files = yield* walk(path.join(root, E2E_DIR), (name) => name.endsWith(".spec.ts"));
		const keys = new Set<string>();
		for (const abs of files) {
			const source = yield* fs
				.readFileString(abs, "utf8")
				.pipe(Effect.mapError((cause) => new IoError({path: abs, cause})));
			for (const key of parseJourneyTags(source)) keys.add(key);
		}
		return keys;
	});

/**
 * The gate: succeed when `flagKey` is reachable (a consuming `.tsx` + a registered journey
 * e2e) or exempt, else `CheckFailed`. Fails closed on zero parsed flag definitions and on
 * an unknown flag key (ADR 0092 / 0173 §1).
 */
export const checkReachability = (
	root: string,
	flagKey: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
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
