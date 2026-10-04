/**
 * What `status bootstrap hand-check-rule` writes, decided over what the repo already says.
 *
 * The step turns screen review on at `hand-check`, and it owes two things: the repo answers
 * `hand-check`, and some path can raise the `ui` class so a pull request can actually reach that
 * answer. The second is why this is a decision and not a constant. A repo with no `uiSurfaces` row
 * and no `reviewUi.screens` path names no screen, so a rule written there is one no pull request can
 * trigger — and reporting it `ok` told an owner they would be asked for a screenshot that nothing
 * ever asked for.
 *
 * Pure: the standing config and the paths the owner named in, a plan out. The verb owns the bytes.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */

import {
	MODE,
	REVIEW_UI,
	type ReviewUi,
	SCREENS,
	type ScreenReviewMode,
	screenRootRefusal,
	WHEN_NO_PREVIEW,
} from "../config/keys/review-ui.ts";
import {UI_SURFACES} from "../config/keys/ui-surfaces.ts";

/** The one `reviewUi.mode` this step ever writes. */
export const HAND_CHECK_MODE = "hand-check" satisfies ScreenReviewMode;

export interface HandCheckInput {
	/** The decoded `reviewUi` the target file carries, or the shipped default where it has none. */
	readonly standing: ReviewUi;
	/** How many `uiSurfaces` rows the target file declares. */
	readonly surfaces: number;
	/** The `--screens` paths the owner passed, as typed. */
	readonly screens: ReadonlyArray<string>;
}

export type HandCheckPlan =
	/** Write these `reviewUi` sub-keys; a key absent here is left exactly as it stands. */
	| {
			readonly _tag: "Write";
			readonly mode: typeof HAND_CHECK_MODE | null;
			readonly screens: ReadonlyArray<string> | null;
	  }
	| {readonly _tag: "Exists"; readonly notice: string}
	| {readonly _tag: "BadScreen"; readonly reason: string}
	| {readonly _tag: "NoScreens"; readonly reason: string};

/**
 * Whether the standing config already answers `hand-check`, or says something this step leaves
 * alone. A repo with `whenNoPreview` rules and no `mode` made its own path-by-path statement before
 * `mode` existed, and a mode written over it could only change what those rules' unmatched files owe.
 */
const modeToWrite = (standing: ReviewUi): typeof HAND_CHECK_MODE | null => {
	if (standing.mode === "skip") return HAND_CHECK_MODE;
	return standing.mode === null && standing.whenNoPreview.length === 0 ? HAND_CHECK_MODE : null;
};

export const planHandCheck = ({standing, surfaces, screens}: HandCheckInput): HandCheckPlan => {
	for (const root of screens) {
		const refused = screenRootRefusal(root);
		if (refused !== null) {
			return {_tag: "BadScreen", reason: `--screens ${JSON.stringify(root)} ${refused}`};
		}
	}
	if (standing.mode === "preview") {
		return {
			_tag: "Exists",
			notice: `already declares \`${REVIEW_UI}.${MODE}\` preview, so screen review is on and this step leaves it — nothing written.`,
		};
	}
	const named = [...new Set([...standing.screens, ...screens])];
	if (surfaces === 0 && named.length === 0) {
		return {
			_tag: "NoScreens",
			reason: `names no screen files (no \`${UI_SURFACES}\` row and no \`${REVIEW_UI}.${SCREENS}\` path), so no pull request could trigger a hand-check — run this again with \`--screens <path>\`, where <path> is the folder your screens live in, ending in "/", or one file such as index.html`,
		};
	}
	const mode = modeToWrite(standing);
	const added = named.length > standing.screens.length ? named : null;
	if (mode === null && added === null) {
		return {
			_tag: "Exists",
			notice:
				standing.mode === "hand-check"
					? `already declares \`${REVIEW_UI}.${MODE}\` hand-check — nothing written.`
					: `already carries a \`${REVIEW_UI}.${WHEN_NO_PREVIEW}\` rule — nothing written.`,
		};
	}
	return {_tag: "Write", mode, screens: added};
};
