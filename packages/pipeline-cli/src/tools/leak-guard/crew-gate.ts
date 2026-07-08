/**
 * The `leak-guard sweep` filesystem gate — the IO seam behind #2357's repeatable
 * pipeline-crew sanitization check (crew epic #2342 Phase 4). Split from `command.ts`
 * so it is crossable in unit tests over a fake dir rather than only by spawning the
 * bin (the core-in-its-own-file idiom the other guards share).
 *
 * `sweepCrew` recursively enumerates every file under the crew directory, runs the
 * pure `findCrewLeaks` core on each, and fails `CheckFailed` (exit non-zero) on ANY
 * personal-data hit OR when zero files are in scope (fail-closed, ADR 0092 — an empty
 * scan is a misconfiguration, never a vacuous green). A directory/file IO failure is
 * an `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative} from "node:path";
import {Console, Data, Effect} from "effect";
import {type CrewLeak, findCrewLeaks} from "./crew-leak.ts";

/** A directory/file IO failure: the sweep couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

/** The default crew directory the sweep scopes over, repo-root-relative. */
export const CREW_DIR = "claude-plugins/pipeline-crew";

interface FileHits {
	readonly file: string;
	readonly leaks: ReadonlyArray<CrewLeak>;
}

/** Recursively collect every regular file's absolute path under `dir`. */
const walkFiles = (dir: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const abs = join(dir, entry.name);
		// Resolve symlinks through statSync; recurse dirs, collect files.
		const st = statSync(abs);
		if (st.isDirectory()) out.push(...walkFiles(abs));
		else if (st.isFile()) out.push(abs);
	}
	return out;
};

/**
 * The CI gate: succeed when a non-empty crew tree carries zero personal-data hits,
 * else `CheckFailed`. `root` is the repo root; `dir` the crew subdir (default
 * `CREW_DIR`). Fails closed on zero files in scope (ADR 0092).
 */
export const sweepCrew = (
	root: string,
	dir: string = CREW_DIR,
): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const base = join(root, dir);
		const files = yield* Effect.try({
			try: () => walkFiles(base),
			catch: (cause) => new IoError({path: base, cause}),
		});

		if (files.length === 0) {
			return yield* Effect.fail(
				new CheckFailed({
					reason:
						`leak-guard sweep: scanned ZERO files under ${dir} — fail-closed (ADR 0092). ` +
						"Is the repo root correct, or did the crew move?",
				}),
			);
		}

		const results: Array<FileHits> = [];
		for (const abs of files) {
			const content = yield* Effect.try({
				try: () => readFileSync(abs, "utf8"),
				catch: (cause) => new IoError({path: abs, cause}),
			});
			const leaks = findCrewLeaks(content);
			if (leaks.length > 0) results.push({file: relative(root, abs), leaks});
		}

		if (results.length === 0) {
			yield* Console.log(
				`leak-guard sweep: clean — ${files.length} file(s) under ${dir}, zero personal-data hits`,
			);
			return;
		}

		const lines: Array<string> = [
			`leak-guard sweep: blocked — personal-data leak(s) in ${dir} (#2357):`,
		];
		for (const {file, leaks} of results) {
			for (const leak of leaks) {
				lines.push(`  ${file}: [${leak.class}] ${leak.matched} — ${leak.reason}`);
			}
		}
		lines.push(
			"The crew ships zero real operator data — route people/machine values through the " +
				"personalization seam (PERSONALIZATION.md), never a literal.",
		);
		return yield* Effect.fail(new CheckFailed({reason: lines.join("\n")}));
	});
