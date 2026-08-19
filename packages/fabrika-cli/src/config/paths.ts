/**
 * One key of the path surface, read off the checkout a verb is standing in.
 *
 * Every reader wants the same three things — the value, a sentence naming where it came from, and a
 * refusal it can print verbatim — so the four resolution arms collapse here once instead of at each
 * of the dozen call sites. **`Malformed` and `Unknown` both refuse**: a value nobody could decode
 * and a file nobody could read are equally not an answer, and neither may fall back to the shipped
 * default it did not resolve to. Falling back is how a typo in `.fabrika.jsonc` silently restores
 * phoenix's own paths in a repo that is not phoenix.
 *
 * Per key rather than a whole-surface read: a verb that needs the governed roots has no business
 * refusing over a malformed `cycleDoc` it never opens. The whole-config gate that *does* refuse on
 * any key is `./unusable.ts`, and it stays the write path's gate.
 */

import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "./document.ts";
import type {KeyGroup} from "./key-group.ts";
import {governedRootsKey} from "./keys/governed-roots.ts";
import {
	cycleDocKey,
	DECISIONS_DIR,
	decisionsDirKey,
	designHarnessKey,
	type PathValue,
	roadmapFileKey,
} from "./keys/paths.ts";
import {resolve} from "./load.ts";
import {loadRepoConfig} from "./working-root.ts";

export type Read<A> =
	/** The value to use, and the sentence a verb prints about where it came from. */
	| {readonly _tag: "Value"; readonly value: A; readonly note: string}
	/** No value may be used, and this is the reason, worded by the key that raised it. */
	| {readonly _tag: "Refused"; readonly reason: string};

const readKey = <A>(
	cwd: string,
	group: KeyGroup<A>,
): Effect.Effect<Read<A>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const resolved = resolve(yield* loadRepoConfig(cwd), group);
		switch (resolved._tag) {
			case "Malformed":
			case "Unknown":
				return {_tag: "Refused" as const, reason: resolved.reason};
			case "Declared":
				return {
					_tag: "Value" as const,
					value: resolved.value,
					note: `\`${group.key}\` as declared in ${CONFIG_PATH}`,
				};
			case "Default":
				return {
					_tag: "Value" as const,
					value: resolved.value,
					note: `the shipped \`${group.key}\` — ${resolved.reason}`,
				};
		}
	});

/** The roots a diff derives the `governance` namespace over, for this repo. */
export const readGovernedRoots = (
	cwd: string,
): Effect.Effect<Read<ReadonlyArray<string>>, never, FileSystem.FileSystem | Path.Path> =>
	readKey(cwd, governedRootsKey);

/**
 * The governed roots, or the one refusal sentence every reader of them prints.
 *
 * Seven verbs ask this question and each owns a different exit code, so the code stays theirs and
 * only the sentence is shared. `consequence` is the clause that names what the caller cannot answer
 * without the set — the half a reader actually needs, and the half that would drift if seven verbs
 * each wrote their own.
 */
export const governedRootsOr = (
	verb: string,
	cwd: string,
	consequence: string,
): Effect.Effect<
	| {readonly _tag: "Roots"; readonly roots: ReadonlyArray<string>; readonly note: string}
	| {readonly _tag: "Refused"; readonly message: string},
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const read = yield* readGovernedRoots(cwd);
		return read._tag === "Value"
			? {_tag: "Roots" as const, roots: read.value, note: read.note}
			: {
					_tag: "Refused" as const,
					message: `${verb}: ${CONFIG_PATH} is refused — ${read.reason.replace(/\.$/, "")}, so ${consequence}`,
				};
	});

/** The decision corpus, or the repo's declaration that it keeps none. */
export const readDecisionsDir = (
	cwd: string,
): Effect.Effect<Read<PathValue>, never, FileSystem.FileSystem | Path.Path> =>
	readKey(cwd, decisionsDirKey);

/**
 * Where the decision corpus is for this run — three answers, and the middle one is the point.
 *
 * `Declined` is not a failure and not an empty corpus: it is the repo stating it keeps none, so a
 * verb that reads the corpus must say that rather than scan a directory that was never meant to
 * exist and report what it found there as the whole truth (R11.1 on #5603).
 *
 * An explicit `--dir` wins over all of it. The flag names a directory the operator is pointing at,
 * and a config key cannot overrule an argument typed at the shell — including in a repo that
 * declined the key, where the flag is how you read a corpus that is not the repo's own.
 */
export type CorpusRead =
	| {readonly _tag: "Dir"; readonly dir: string; readonly note: string}
	| {readonly _tag: "Declined"; readonly message: string}
	| {readonly _tag: "Refused"; readonly message: string};

export const decisionsDirOr = (
	verb: string,
	cwd: string,
	override: string | null,
	declinedConsequence: string,
): Effect.Effect<CorpusRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (override !== null) {
			return {_tag: "Dir" as const, dir: override, note: `--dir ${override}`};
		}
		const read = yield* readDecisionsDir(cwd);
		if (read._tag === "Refused") {
			return {
				_tag: "Refused" as const,
				message: `${verb}: ${CONFIG_PATH} is refused — ${read.reason.replace(/\.$/, "")}, so where the decision corpus lives is UNKNOWN.`,
			};
		}
		return read.value._tag === "Path"
			? {_tag: "Dir" as const, dir: read.value.path, note: read.note}
			: {
					_tag: "Declined" as const,
					message: `${verb}: ${CONFIG_PATH} declines \`${DECISIONS_DIR}\` — this repo keeps no decision corpus, so ${declinedConsequence} Point --dir at a corpus to read one anyway.`,
				};
	});

/** The roadmap declaration the scope fence and `triage homes` read. */
export const readRoadmapFile = (
	cwd: string,
): Effect.Effect<Read<string>, never, FileSystem.FileSystem | Path.Path> =>
	readKey(cwd, roadmapFileKey);

/** The cycle doc the containment class is gated on. */
export const readCycleDoc = (
	cwd: string,
): Effect.Effect<Read<string>, never, FileSystem.FileSystem | Path.Path> =>
	readKey(cwd, cycleDocKey);

/**
 * A declared path, or the one refusal sentence its readers print.
 *
 * The same shape as {@link governedRootsOr} and for the same reason: several verbs open each of
 * these files and each owns its exit code, so the code stays theirs and only the sentence is shared.
 * A config nobody can decode leaves the read UNKNOWN — never "the file is absent", which is the
 * answer that quietly switches a gate off for the run.
 */
export type PathOr =
	| {readonly _tag: "Path"; readonly path: string; readonly note: string}
	| {readonly _tag: "Refused"; readonly message: string};

const pathOr = (verb: string, consequence: string, read: Read<string>): PathOr =>
	read._tag === "Value"
		? {_tag: "Path", path: read.value, note: read.note}
		: {
				_tag: "Refused",
				message: `${verb}: ${CONFIG_PATH} is refused — ${read.reason.replace(/\.$/, "")}, so ${consequence}`,
			};

/** The cycle doc's path, or the refusal its readers print. */
export const cycleDocOr = (
	verb: string,
	cwd: string,
	consequence: string,
): Effect.Effect<PathOr, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(readCycleDoc(cwd), (read) => pathOr(verb, consequence, read));

/** The design harness's path, or the refusal its readers print. */
export const designHarnessOr = (
	verb: string,
	cwd: string,
	consequence: string,
): Effect.Effect<PathOr, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(readDesignHarness(cwd), (read) => pathOr(verb, consequence, read));

/** The headless-render harness config. */
export const readDesignHarness = (
	cwd: string,
): Effect.Effect<Read<string>, never, FileSystem.FileSystem | Path.Path> =>
	readKey(cwd, designHarnessKey);
