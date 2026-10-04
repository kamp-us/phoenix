/**
 * What a repo's screen review resolves to, read across the two keys that say it.
 *
 * `reviewUi.mode` is the repo's one answer — `preview`, `hand-check` or `skip` — and a repo may
 * leave it unset. An unset mode cannot resolve off `reviewUi` alone: a repo that declared `uiSurfaces`
 * rows before the key existed was reviewed by preview, and must go on being reviewed that way. So
 * the resolution lives here, over both keys, and no key's own decoder guesses at it.
 *
 * **A repo that has said nothing resolves to `skip`.** Nothing there names a screen, so no screen
 * was ever reviewed; resolving `skip` states what already happened instead of leaving it silent. A
 * repo that declared a row, a `screens` entry or a `whenNoPreview` rule has said something, and
 * resolves to `preview` — the strict arm, and what those repos ran before `mode` existed.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */

import {CONFIG_PATH} from "./document.ts";
import {
	MODE,
	type NoPreviewMode,
	REVIEW_UI,
	type ReviewUi,
	SCREEN_REVIEW_MODES,
	SCREENS,
	type ScreenReviewMode,
	WHEN_NO_PREVIEW,
} from "./keys/review-ui.ts";
import {prefixesOf, UI_SURFACES, type UiSurface} from "./keys/ui-surfaces.ts";

export type {ScreenReviewMode} from "./keys/review-ui.ts";

const MODE_KEY = `${REVIEW_UI}.${MODE}`;

export interface ScreenReview {
	readonly mode: ScreenReviewMode;
	/** `true` when the repo wrote `reviewUi.mode`; `false` when the mode was derived. */
	readonly declared: boolean;
	/**
	 * Every source root the repo names a screen under — the rows' prefixes, then `reviewUi.screens` —
	 * whatever the mode. {@link raisedPrefixes} is the subset that raises the `ui` class.
	 */
	readonly screens: ReadonlyArray<string>;
	/** One clause saying why the mode is what it is, for a readout's detail cell. */
	readonly reason: string;
}

export const screenReviewOf = (
	reviewUi: ReviewUi,
	surfaces: ReadonlyArray<UiSurface>,
): ScreenReview => {
	const screens = [...new Set([...prefixesOf(surfaces), ...reviewUi.screens])];
	if (reviewUi.mode !== null) {
		return {
			mode: reviewUi.mode,
			declared: true,
			screens,
			reason: `${CONFIG_PATH} declares \`${MODE_KEY}\` ${reviewUi.mode}`,
		};
	}
	const said = [
		surfaces.length > 0 ? `${surfaces.length} \`${UI_SURFACES}\` row(s)` : null,
		reviewUi.screens.length > 0
			? `${reviewUi.screens.length} \`${REVIEW_UI}.${SCREENS}\` path(s)`
			: null,
		reviewUi.whenNoPreview.length > 0
			? `${reviewUi.whenNoPreview.length} \`${REVIEW_UI}.${WHEN_NO_PREVIEW}\` rule(s)`
			: null,
	].filter((clause): clause is string => clause !== null);
	return said.length === 0
		? {
				mode: "skip",
				declared: false,
				screens,
				reason: `${CONFIG_PATH} declares no \`${MODE_KEY}\`, no \`${UI_SURFACES}\` row, no \`${REVIEW_UI}.${SCREENS}\` path and no \`${REVIEW_UI}.${WHEN_NO_PREVIEW}\` rule`,
			}
		: {
				mode: "preview",
				declared: false,
				screens,
				reason: `${CONFIG_PATH} declares no \`${MODE_KEY}\` and does declare ${said.join(", ")}`,
			};
};

/** The source roots that raise the `ui` class: none at `skip`, where no screen review is owed. */
export const raisedPrefixes = (review: ScreenReview): ReadonlyArray<string> =>
	review.mode === "skip" ? [] : review.screens;

/**
 * The strictest of several answers. A PR is judged over its head's config and its merge base's, and
 * taking the stricter of the two is what keeps a PR from switching off the gate it faces.
 */
export const strictestMode = (
	first: ScreenReviewMode,
	...rest: ReadonlyArray<ScreenReviewMode>
): ScreenReviewMode =>
	rest.reduce(
		(strictest, mode) =>
			SCREEN_REVIEW_MODES.indexOf(mode) < SCREEN_REVIEW_MODES.indexOf(strictest) ? mode : strictest,
		first,
	);

/**
 * The mode a ui file takes when no `whenNoPreview` rule matches it and its PR has no preview.
 *
 * `skip` answers `require-render` on purpose. At `skip` no path raises the `ui` class, so the only
 * caller that reaches here with it is one standing in a checkout that disagrees with the PR's own
 * config — and the answer that can never loosen a gate is the one that asks for a render.
 */
export const unmatchedMode = (mode: ScreenReviewMode): NoPreviewMode =>
	mode === "hand-check" ? "hand-check" : "require-render";

/** The command that turns screen review on, as a person pastes it. */
export const TURN_ON_STEP = "fabrika status bootstrap hand-check-rule --screens <path>";

/**
 * The one sentence a run ends on when a screen change went unreviewed at `skip`. Fixed here so the
 * verb that prints it and the skill that relays it say the same words, and no skill composes it.
 * It is one sentence so it fits beside the outcome on a closing message's "what happened" line.
 */
export const SCREEN_CHECK_SKIPPED = `The screen check was skipped because screen review is not set up in this repo; to turn it on, run \`${TURN_ON_STEP}\`, where <path> is the folder or file your screens live in.`;
