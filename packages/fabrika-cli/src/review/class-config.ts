/**
 * The config a PR's classes are derived over: `.fabrika.jsonc` read out of git objects at the PR's
 * head and at its merge base, never out of the checkout a verb stands in.
 *
 * **Why not the working tree.** The file list a scope verb partitions is read at the bound head, so
 * pairing it with the working tree's config mixed the PR's files with whatever the local checkout
 * held. A checkout three merges behind `main` reported no `ui` class for a PR under a declared
 * prefix, and pulling `main` changed the answer — two verbs standing in two trees could disagree
 * about one head.
 *
 * **Why both refs, and why their union.** Head alone lets a PR delete its own `uiSurfaces` row or
 * governed root and skip the gate it should face; base alone misses a PR that adds a new app. So a
 * path raises the `ui` class, counts as governed, or carries a subsystem constraint if **either**
 * config says so. A config absent at one ref is that ref's shipped defaults, exactly as an absent
 * working-tree file is; a config that does not decode, or a read that failed, refuses and names the
 * ref — the union of an answer and UNKNOWN is UNKNOWN.
 *
 * **Screen review is resolved per ref and the stricter answer wins.** A ref whose config resolves
 * `skip` (`../config/screen-review.ts`) names no path that raises the `ui` class, so a PR raises it
 * only off a ref that reviews screens. That is the same union: a PR that sets `skip` on its own head
 * still faces the gate its merge base declares, and one that turns screen review on is judged by it.
 *
 * Only the tracked file exists at a ref, so {@link loadConfig}'s tracked-only door is the one taken:
 * a machine-local layer can never reach a class derivation.
 *
 * One pure core and two byte openers. {@link classConfigAtCommits} reads the object database, for
 * the verbs that bound their head through git (`./head.ts`) or read a local range.
 * {@link classConfigOfPull} reads the platform at the PR's head and at the merge base the platform
 * computes, for the verbs whose file list is the platform's own. Both hand the same bytes of the same
 * two commits to {@link classConfigOf}, so the transport cannot change an answer.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10031
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */

import {Effect} from "effect";
import {CONFIG_PATH, type ConfigSource} from "../config/document.ts";
import {governedRootsKey} from "../config/keys/governed-roots.ts";
import {type ReviewSubsystem, reviewSubsystemsKey} from "../config/keys/review-subsystems.ts";
import {type ReviewUi, reviewUiKey} from "../config/keys/review-ui.ts";
import {NO_UI_SURFACES, type UiSurface, uiSurfacesKey} from "../config/keys/ui-surfaces.ts";
import {loadConfig} from "../config/load.ts";
import {type Read, readFromLoad} from "../config/read-key.ts";
import {
	raisedPrefixes,
	type ScreenReview,
	type ScreenReviewMode,
	screenReviewOf,
	strictestMode,
} from "../config/screen-review.ts";
import {execCapture} from "../io/exec.ts";
import {readFileAt, type Shell} from "../io/git.ts";
import {mergeBaseOf} from "../io/pulls.ts";
import {readFileAtRef} from "../ship/github.ts";

/** Which of the two commits a config was read at — named in every note and every refusal. */
export type ConfigSide = "head" | "base";

/** One commit's config bytes, as the opener found them. */
export interface ConfigAt {
	readonly side: ConfigSide;
	readonly sha: string;
	readonly source: ConfigSource;
}

/** The three class inputs, each the union of what the head and the base declare. */
export interface ClassConfig {
	readonly governedRoots: ReadonlyArray<string>;
	readonly uiPrefixes: ReadonlyArray<string>;
	/** How this PR's screens are reviewed: the stricter of its head's answer and its merge base's. */
	readonly screenReview: {
		readonly mode: ScreenReviewMode;
		/** Why each ref resolves the mode it does, one clause per ref. */
		readonly note: string;
	};
	readonly subsystems: ReadonlyArray<ReviewSubsystem>;
	/** Where each value came from, one sentence per key, for a verb's diagnostics. */
	readonly notes: {
		readonly governedRoots: string;
		readonly uiSurfaces: string;
		readonly reviewSubsystems: string;
	};
}

export type ClassConfigRead =
	| {readonly _tag: "Config"; readonly config: ClassConfig}
	| {
			readonly _tag: "Refused";
			/** The whole sentence a verb prints: its name, the reason, and its consequence. */
			readonly message: string;
			/** The reason alone, naming the ref, for a verb that folds it into a sentence of its own. */
			readonly reason: string;
	  };

const refused = (verb: string, consequence: string, reason: string): ClassConfigRead => ({
	_tag: "Refused",
	message: `${verb}: ${reason}, so ${consequence}`,
	reason,
});

/** The two commits a PR's classes are read between. */
export interface ClassRefs {
	readonly head: string;
	readonly base: string;
}

const sideName = (at: ConfigAt): string => `the ${at.side} ${at.sha}`;

const union = <A>(values: ReadonlyArray<A>, keyOf: (value: A) => string): ReadonlyArray<A> => {
	const seen = new Map<string, A>();
	for (const value of values) if (!seen.has(keyOf(value))) seen.set(keyOf(value), value);
	return [...seen.values()];
};

type Value<A> = Extract<Read<A>, {readonly _tag: "Value"}>;

interface Side {
	readonly _tag: "Side";
	readonly at: ConfigAt;
	readonly governed: Value<ReadonlyArray<string>>;
	readonly surfaces: Value<ReadonlyArray<UiSurface>>;
	readonly reviewUi: Value<ReviewUi>;
	readonly screenReview: ScreenReview;
	readonly subsystems: Value<ReadonlyArray<ReviewSubsystem>>;
}

/** One commit's four keys, or the first reason one of them has no value. */
const sideOf = (at: ConfigAt): Side | Extract<Read<never>, {readonly _tag: "Refused"}> => {
	const load = loadConfig(at.source);
	const governed = readFromLoad(load, governedRootsKey);
	if (governed._tag === "Refused") return governed;
	const surfaces = readFromLoad(load, uiSurfacesKey);
	if (surfaces._tag === "Refused") return surfaces;
	const reviewUi = readFromLoad(load, reviewUiKey);
	if (reviewUi._tag === "Refused") return reviewUi;
	const subsystems = readFromLoad(load, reviewSubsystemsKey);
	if (subsystems._tag === "Refused") return subsystems;
	return {
		_tag: "Side",
		at,
		governed,
		surfaces,
		reviewUi,
		screenReview: screenReviewOf(reviewUi.value, surfaces.value),
		subsystems,
	};
};

/**
 * The class config over two commits' bytes, or the refusal naming the ref that could not answer.
 *
 * `consequence` is the caller's clause for what it cannot answer without the config; the exit code
 * stays the caller's, as it does for every sibling `…Or` reader in `../config/paths.ts`.
 */
export const classConfigOf = (
	verb: string,
	consequence: string,
	head: ConfigAt,
	base: ConfigAt,
): ClassConfigRead => {
	const sides: Side[] = [];
	for (const at of [head, base]) {
		const side = sideOf(at);
		if (side._tag === "Refused") {
			return refused(
				verb,
				consequence,
				`${CONFIG_PATH} at ${sideName(at)} is refused — ${side.reason.replace(/\.$/, "")}`,
			);
		}
		sides.push(side);
	}
	const noteOf = (note: (side: Side) => string): string =>
		sides.map((side) => `at ${sideName(side.at)}, ${note(side)}`).join("; ");
	const [first, ...rest] = sides.map((side) => side.screenReview.mode) as [
		ScreenReviewMode,
		...ScreenReviewMode[],
	];
	const mode = strictestMode(first, ...rest);
	return {
		_tag: "Config",
		config: {
			governedRoots: union(
				sides.flatMap((side) => side.governed.value),
				(root) => root,
			),
			uiPrefixes: union(
				sides.flatMap((side) => raisedPrefixes(side.screenReview)),
				(prefix) => prefix,
			),
			screenReview: {
				mode,
				note: noteOf((side) => side.screenReview.reason),
			},
			subsystems: union(
				sides.flatMap((side) => side.subsystems.value),
				(entry) => JSON.stringify([entry.subsystem, entry.pattern, entry.constraint]),
			),
			notes: {
				governedRoots: noteOf((side) => side.governed.note),
				uiSurfaces: noteOf((side) => side.surfaces.note),
				reviewSubsystems: noteOf((side) => side.subsystems.note),
			},
		},
	};
};

/**
 * The one stderr line a scope verb prints about the `ui` class: the prefixes it derived the class
 * over, or why it derived none. At `skip` it says screen review is not set up, so a repo's unreviewed
 * screens are stated on every scope read rather than left for a reader to infer from an empty set.
 */
export const uiDerivationLine = (verb: string, config: ClassConfig): string => {
	if (config.screenReview.mode === "skip") {
		return `${verb}: screen review is not set up, so no path raises the ui class and no rendered review is owed — ${config.screenReview.note}.`;
	}
	return config.uiPrefixes.length === 0
		? `${verb}: ${NO_UI_SURFACES}.`
		: `${verb}: ui derived over ${config.uiPrefixes.length} prefix(es) — ${config.notes.uiSurfaces}.`;
};

/**
 * One commit's config out of the object database.
 *
 * `ls-tree` first, because it is the read that tells a file nobody wrote from a commit nobody
 * fetched: it lists nothing for an absent path and fails for an absent commit, where `git show`
 * fails the same way for both.
 */
export const configAtCommit = (side: ConfigSide, sha: string): Shell<ConfigAt> =>
	Effect.gen(function* () {
		const listed = yield* execCapture("git", ["ls-tree", "--full-tree", sha, "--", CONFIG_PATH]);
		if (!listed.ok) {
			return {side, sha, source: {_tag: "Unreadable" as const, reason: listed.reason}};
		}
		if (listed.stdout.trim() === "") return {side, sha, source: {_tag: "Absent" as const}};
		const text = yield* readFileAt(sha, CONFIG_PATH);
		return {
			side,
			sha,
			source:
				text._tag === "Ok"
					? {_tag: "Text" as const, text: text.value}
					: {_tag: "Unreadable" as const, reason: text.reason},
		};
	});

/** The class config at two commits this checkout's object database already holds. */
export const classConfigAtCommits = (
	verb: string,
	consequence: string,
	refs: ClassRefs,
): Shell<ClassConfigRead> =>
	Effect.gen(function* () {
		const head = yield* configAtCommit("head", refs.head);
		const base = yield* configAtCommit("base", refs.base);
		return classConfigOf(verb, consequence, head, base);
	});

const configAtPlatformRef = (repo: string, side: ConfigSide, sha: string): Shell<ConfigAt> =>
	Effect.map(readFileAtRef(repo, CONFIG_PATH, sha), (read) => ({
		side,
		sha,
		source:
			read._tag === "Present"
				? {_tag: "Text" as const, text: read.value}
				: read._tag === "Absent"
					? {_tag: "Absent" as const}
					: {_tag: "Unreadable" as const, reason: read.reason},
	}));

/**
 * The class config of one PR as the platform serves it: at `head`, and at the merge base of `head`
 * with `baseRef` — the commit the platform's own `pulls/<n>/files` list is diffed from.
 */
export const classConfigOfPull = (
	verb: string,
	consequence: string,
	repo: string,
	pull: {readonly headSha: string; readonly baseRef: string},
): Shell<ClassConfigRead> =>
	Effect.gen(function* () {
		const base = yield* mergeBaseOf(repo, pull.baseRef, pull.headSha);
		if (base._tag === "Failure") {
			return refused(
				verb,
				consequence,
				`cannot read the merge base of ${pull.headSha} with ${pull.baseRef}: ${base.reason.replace(/\.$/, "")} — ${CONFIG_PATH} at the merge base is unread`,
			);
		}
		const head = yield* configAtPlatformRef(repo, "head", pull.headSha);
		const atBase = yield* configAtPlatformRef(repo, "base", base.value);
		return classConfigOf(verb, consequence, head, atBase);
	});
