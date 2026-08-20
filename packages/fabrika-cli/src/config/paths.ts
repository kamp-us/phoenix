/**
 * The declared paths a verb opens, each read off the checkout it is standing in.
 *
 * The four-arm collapse every key reader shares lives at `./read-key.ts`; this module is the path
 * surface's own readers over it, plus the `…Or` shapes that pair a value with the one refusal
 * sentence its several callers print.
 */

import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "./document.ts";
import {governedRootsKey} from "./keys/governed-roots.ts";
import {
	cycleDocKey,
	DECISIONS_DIR,
	decisionsDirKey,
	designHarnessKey,
	type PathValue,
	roadmapFileKey,
} from "./keys/paths.ts";
import {type Read, readKey} from "./read-key.ts";

export type {Read};

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
 * An explicit override wins over all of it. The flag names a directory the operator is pointing at,
 * and a config key cannot overrule an argument typed at the shell — including in a repo that
 * declined the key, where the flag is how you read a corpus that is not the repo's own.
 */
export type CorpusRead =
	| {readonly _tag: "Dir"; readonly dir: string; readonly note: string}
	| {readonly _tag: "Declined"; readonly message: string}
	| {readonly _tag: "Refused"; readonly message: string};

/**
 * How this caller lets an operator point at a corpus by hand — the flag's own name, and what was
 * typed after it.
 *
 * The name travels with the value because the `Declined` message advertises it, and a shared
 * literal cannot: `--dir` is `adr`'s and `governance`'s spelling, `glossary check` spells the same
 * override `--decisions` and means the register directory by `--dir`, and `guard decisions-index
 * validate` has no override at all. All three inheriting one hardcoded clause sent two of them
 * after a flag their verb does not accept (#6433). Pairing the two halves in one value leaves no
 * way to accept a directory without naming the flag it came from, or to advertise one the verb
 * does not have.
 */
export type CorpusOverride =
	| {readonly _tag: "NoFlag"}
	| {readonly _tag: "Flag"; readonly flag: string; readonly given: string | null};

/** For a verb that offers no way to point at a corpus: the remedy clause is omitted, not faked. */
export const noCorpusOverride: CorpusOverride = {_tag: "NoFlag"};

export const corpusOverride = (flag: string, given: string | null): CorpusOverride => ({
	_tag: "Flag",
	flag,
	given,
});

const remedy = (override: CorpusOverride): string =>
	override._tag === "Flag" ? ` Point ${override.flag} at a corpus to read one anyway.` : "";

export const decisionsDirOr = (
	verb: string,
	cwd: string,
	override: CorpusOverride,
	declinedConsequence: string,
): Effect.Effect<CorpusRead, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (override._tag === "Flag" && override.given !== null) {
			return {
				_tag: "Dir" as const,
				dir: override.given,
				note: `${override.flag} ${override.given}`,
			};
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
					message: `${verb}: ${CONFIG_PATH} declines \`${DECISIONS_DIR}\` — this repo keeps no decision corpus, so ${declinedConsequence}${remedy(override)}`,
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
