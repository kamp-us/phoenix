/**
 * Whether a finished lane's screen change went unreviewed because screen review is not set up.
 *
 * At `skip` no path raises the `ui` class, so nothing in the lane's own log says a screen was
 * involved: the review ran over text classes and passed. The run still owes the person one sentence
 * saying the screen check was skipped. Two facts can show a screen was involved, and either is
 * enough:
 *
 * - the lane was booted off an issue labelled `class:ui` — the seed its machine document carries;
 * - a pull request the lane shipped changes a file under a source root the repo names a screen
 *   under, which a repo can declare while still at `skip`.
 *
 * The first is the only signal in a repo that names no screen file at all, where no diff can tell a
 * screen from any other file.
 *
 * **A lane that opened no pull request skipped nothing.** A check is skipped over a change, and a
 * lane that ended on a diagnosis made none.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */

import {Effect} from "effect";
import type {ScreenReview} from "../config/screen-review.ts";
import type {Attempt} from "../io/git.ts";
import {isUiSurface} from "../review/classes.ts";
import type {CompiledLane} from "./machine.ts";

export type ScreenCheck =
	/** A screen change shipped with no screen review, at `skip`. */
	| {readonly _tag: "Skipped"}
	/** Nothing was skipped: screen review is set up, or the lane touched no screen. */
	| {readonly _tag: "NotSkipped"}
	/** A read failed, so whether a screen went unreviewed is UNKNOWN. */
	| {readonly _tag: "Unread"; readonly reason: string};

/** What the lane itself says about its screens, read off its machine and its record. */
export interface ScreenCheckLane {
	/** Whether the lane was seeded `ui` at boot, off its issue's `class:ui` label. */
	readonly seededUi: boolean;
	/** The pull requests the lane's log names. */
	readonly prs: ReadonlyArray<number>;
}

/** The two reads the answer needs, passed in so the decision is provable offline. */
export interface ScreenCheckReads<R> {
	/** What screen review resolves to in the repo the driver stands in. */
	readonly review: Effect.Effect<
		| {readonly _tag: "Review"; readonly review: ScreenReview}
		| {readonly _tag: "Refused"; readonly message: string},
		never,
		R
	>;
	/** One pull request's changed files. */
	readonly files: (pr: number) => Effect.Effect<Attempt<ReadonlyArray<string>>, never, R>;
}

/** Whether any task of the lane was seeded with the `ui` class when it was booted. */
export const seededUi = (lane: CompiledLane): boolean =>
	Object.values(lane.tasks).some((task) => task.initial.classes.includes("ui"));

export const readScreenCheck = <R>(
	lane: ScreenCheckLane,
	reads: ScreenCheckReads<R>,
): Effect.Effect<ScreenCheck, never, R> =>
	Effect.gen(function* () {
		if (lane.prs.length === 0) return {_tag: "NotSkipped"} as const;
		const read = yield* reads.review;
		if (read._tag === "Refused") return {_tag: "Unread", reason: read.message} as const;
		const {review} = read;
		if (review.mode !== "skip") return {_tag: "NotSkipped"} as const;
		if (lane.seededUi) return {_tag: "Skipped"} as const;
		if (review.screens.length === 0) return {_tag: "NotSkipped"} as const;
		for (const pr of lane.prs) {
			const files = yield* reads.files(pr);
			if (files._tag === "Failure") {
				return {
					_tag: "Unread",
					reason: `cannot read the changed files of #${pr}: ${files.reason}`,
				} as const;
			}
			if (files.value.some((file) => isUiSurface(file, review.screens))) {
				return {_tag: "Skipped"} as const;
			}
		}
		return {_tag: "NotSkipped"} as const;
	});
