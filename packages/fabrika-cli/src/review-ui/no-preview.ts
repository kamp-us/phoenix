/**
 * What the ui gate needs from a PR with no preview deploy, off the repo's `reviewUi.whenNoPreview`
 * rules and its `reviewUi.mode`.
 *
 * The first rule whose glob matches a file sets that file's mode, and a file no rule matches takes
 * the repo's own answer: a render at `preview`, an owner's screenshots at `hand-check`
 * (`../config/screen-review.ts`'s `unmatchedMode`). Across a PR the strictest file wins: one file
 * that needs a render is enough to need a render, because the looser modes are exemptions a repo
 * granted per path, never per PR.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10038#issuecomment-5860347862
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */

import {
	NO_PREVIEW_MODES,
	type NoPreviewMode,
	type NoPreviewRule,
} from "../config/keys/review-ui.ts";
import {matchPath} from "../review/filter-spike.ts";

export type {NoPreviewMode, NoPreviewRule} from "../config/keys/review-ui.ts";

/**
 * The mode an unmatched file resolves to where the caller names none — a render, which is what a
 * repo reviewed by preview owes and the one answer that can never loosen a gate.
 */
export const UNMATCHED: NoPreviewMode = "require-render";

/** One file's mode: the first matching rule's, else `unmatched`. */
export const fileMode = (
	rules: ReadonlyArray<NoPreviewRule>,
	file: string,
	unmatched: NoPreviewMode = UNMATCHED,
): NoPreviewMode =>
	rules.find((rule) => rule.paths.some((glob) => matchPath(glob, file)))?.mode ?? unmatched;

const strictness = (mode: NoPreviewMode): number => NO_PREVIEW_MODES.indexOf(mode);

/**
 * The mode a PR's ui-class files resolve to: the strictest of their per-file modes.
 *
 * An empty file list resolves to {@link UNMATCHED} whatever the repo's mode. Nothing then raised the
 * ui class, and the one answer that can never loosen a gate is the one that asks for a render.
 */
export const noPreviewMode = (
	rules: ReadonlyArray<NoPreviewRule>,
	uiFiles: ReadonlyArray<string>,
	unmatched: NoPreviewMode = UNMATCHED,
): NoPreviewMode =>
	uiFiles.length === 0
		? UNMATCHED
		: uiFiles
				.map((file) => fileMode(rules, file, unmatched))
				.reduce((strictest, mode) => (strictness(mode) < strictness(strictest) ? mode : strictest));

/** The files that set a PR's mode — the ones a refusal names so the reader knows which rule to read. */
export const filesAtMode = (
	rules: ReadonlyArray<NoPreviewRule>,
	uiFiles: ReadonlyArray<string>,
	mode: NoPreviewMode,
	unmatched: NoPreviewMode = UNMATCHED,
): ReadonlyArray<string> => uiFiles.filter((file) => fileMode(rules, file, unmatched) === mode);
