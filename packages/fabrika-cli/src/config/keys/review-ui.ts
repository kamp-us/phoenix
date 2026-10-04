/**
 * `reviewUi` — how this repo reviews a change to a screen.
 *
 * Three sub-keys. `mode` is the repo's one answer: `preview`, `hand-check`, or `skip` for a repo
 * where screen review is not set up. `screens` names where screens live in a repo that has no
 * runnable `uiSurfaces` row to name them. `whenNoPreview` is the path-by-path list of
 * `{paths, mode}` rules for a PR with no preview deploy.
 *
 * This module ships the vocabulary, the shape and its refusals. What an unset `mode` resolves to
 * depends on a second key, so that answer is `../screen-review.ts`'s; which mode one PR's files
 * resolve to is `../../review-ui/no-preview.ts`'s.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10038#issuecomment-5860347862
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const REVIEW_UI = "reviewUi";
export const WHEN_NO_PREVIEW = "whenNoPreview";
export const MODE = "mode";
export const SCREENS = "screens";
const RULES = `${REVIEW_UI}.${WHEN_NO_PREVIEW}`;

/**
 * The repo's answer for screen review, strictest first. The order is the precedence a PR takes when
 * its head and its merge base answer differently, so a PR cannot loosen the gate it is judged by.
 *
 * `preview`: the reviewer opens a hosted copy of each pull request. `hand-check`: an owner looks at
 * the screen and posts a screenshot. `skip`: screen review is not set up, so a screen change gets
 * the text review only.
 */
export const SCREEN_REVIEW_MODES = ["preview", "hand-check", "skip"] as const;
export type ScreenReviewMode = (typeof SCREEN_REVIEW_MODES)[number];

export const isScreenReviewMode = (value: unknown): value is ScreenReviewMode =>
	typeof value === "string" && (SCREEN_REVIEW_MODES as ReadonlyArray<string>).includes(value);

/**
 * Strictest first. The order is the precedence a PR whose ui files land in different modes resolves
 * by, so it is data rather than a comparison written at each reader.
 */
export const NO_PREVIEW_MODES = ["require-render", "hand-check", "skip"] as const;
export type NoPreviewMode = (typeof NO_PREVIEW_MODES)[number];

export const isNoPreviewMode = (value: unknown): value is NoPreviewMode =>
	typeof value === "string" && (NO_PREVIEW_MODES as ReadonlyArray<string>).includes(value);

/** One rule: the files its globs match need `mode` when the PR has no preview. */
export interface NoPreviewRule {
	readonly paths: ReadonlyArray<string>;
	readonly mode: NoPreviewMode;
}

export interface ReviewUi {
	/** `null` is a repo that has not answered; `../screen-review.ts` says what that resolves to. */
	readonly mode: ScreenReviewMode | null;
	/**
	 * Repo-relative source roots that hold screens, in the grammar a `uiSurfaces` prefix uses: a
	 * trailing `/` is a directory, anything else names one file. They raise the `ui` class beside the
	 * declared rows' prefixes, and unlike a row they need no start command.
	 */
	readonly screens: ReadonlyArray<string>;
	readonly whenNoPreview: ReadonlyArray<NoPreviewRule>;
}

export const SHIPPED_REVIEW_UI: ReviewUi = {mode: null, screens: [], whenNoPreview: []};

const malformed = (reason: string): Decoded<never> => ({_tag: "Malformed", reason});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A glob over repo-relative paths: never blank, never padded, never absolute, and never climbing out
 * of the repo through a `..` segment — a rule that matches nothing a PR can change is a rule the
 * operator believes is in force and is not.
 */
const globRefusal = (glob: unknown): string | null => {
	if (typeof glob !== "string" || glob.trim() === "") return "is blank or not a string";
	if (glob !== glob.trim()) return "carries surrounding whitespace";
	if (glob.startsWith("/")) return "is absolute — globs are repo-relative";
	if (glob.split("/").includes("..")) return "climbs out of the repo through a `..` segment";
	return null;
};

/**
 * Why one `screens` entry is refused, or `null`. A source root is held to the path rules a glob is,
 * and to one more: it is matched by prefix or equality, never as a pattern, so a `*` in it would be
 * a root the owner believes covers files and covers none.
 */
export const screenRootRefusal = (root: unknown): string | null => {
	const refused = globRefusal(root);
	if (refused !== null) return refused.replace("globs are", "screen paths are");
	return (root as string).includes("*")
		? "carries a `*` — a screen path is a folder ending in `/` or one file, never a pattern"
		: null;
};

const decodeRule = (entry: unknown, index: number): Decoded<NoPreviewRule> => {
	const at = `${RULES}[${index}]`;
	if (!isRecord(entry)) return malformed(`"${at}" is not a {paths, mode} object`);
	const unknown = Object.keys(entry).find((key) => key !== "paths" && key !== "mode");
	if (unknown !== undefined) {
		return malformed(`"${at}.${unknown}" is not a known field — a rule carries paths and mode`);
	}
	const {paths, mode} = entry;
	if (!Array.isArray(paths) || paths.length === 0) {
		return malformed(`"${at}.paths" is missing or not a non-empty list of globs`);
	}
	for (const [position, glob] of paths.entries()) {
		const refused = globRefusal(glob);
		if (refused !== null) return malformed(`"${at}.paths[${position}]" ${refused}`);
	}
	if (!isNoPreviewMode(mode)) {
		return malformed(
			`"${at}.mode" is ${JSON.stringify(mode) ?? "missing"}, not one of ${NO_PREVIEW_MODES.join(", ")}`,
		);
	}
	return {_tag: "Value", value: {paths: paths as ReadonlyArray<string>, mode}};
};

const KNOWN_KEYS: ReadonlyArray<string> = [MODE, SCREENS, WHEN_NO_PREVIEW];

const decodeMode = (declared: unknown): Decoded<ScreenReviewMode | null> => {
	if (declared === undefined) return {_tag: "Value", value: null};
	return isScreenReviewMode(declared)
		? {_tag: "Value", value: declared}
		: malformed(
				`"${REVIEW_UI}.${MODE}" is ${JSON.stringify(declared) ?? "missing"}, not one of ${SCREEN_REVIEW_MODES.join(", ")}`,
			);
};

const decodeScreens = (declared: unknown): Decoded<ReadonlyArray<string>> => {
	if (declared === undefined) return {_tag: "Value", value: []};
	if (!Array.isArray(declared)) {
		return malformed(`"${REVIEW_UI}.${SCREENS}" is not a list of repo-relative paths`);
	}
	for (const [position, root] of declared.entries()) {
		const refused = screenRootRefusal(root);
		if (refused !== null) return malformed(`"${REVIEW_UI}.${SCREENS}[${position}]" ${refused}`);
	}
	return {_tag: "Value", value: [...new Set(declared as ReadonlyArray<string>)]};
};

const decodeRules = (declared: unknown): Decoded<ReadonlyArray<NoPreviewRule>> => {
	if (declared === undefined) return {_tag: "Value", value: []};
	if (!Array.isArray(declared)) return malformed(`"${RULES}" is not a list of {paths, mode} rules`);
	const rules: NoPreviewRule[] = [];
	for (const [index, entry] of declared.entries()) {
		const rule = decodeRule(entry, index);
		if (rule._tag === "Malformed") return rule;
		rules.push(rule.value);
	}
	return {_tag: "Value", value: rules};
};

const decode = (raw: unknown): Decoded<ReviewUi> => {
	if (!isRecord(raw)) return malformed(`\`${REVIEW_UI}\` is not an object`);
	const unknown = Object.keys(raw).find((key) => !KNOWN_KEYS.includes(key));
	if (unknown !== undefined) {
		return malformed(
			`"${REVIEW_UI}.${unknown}" is not a known key — ${REVIEW_UI} carries ${KNOWN_KEYS.join(", ")}`,
		);
	}
	const mode = decodeMode(raw[MODE]);
	if (mode._tag === "Malformed") return mode;
	const screens = decodeScreens(raw[SCREENS]);
	if (screens._tag === "Malformed") return screens;
	const rules = decodeRules(raw[WHEN_NO_PREVIEW]);
	if (rules._tag === "Malformed") return rules;
	// `skip` says no screen review is owed anywhere and a rule says what one path owes, so a repo
	// declaring both has made two statements that cannot both hold, and neither is read.
	if (mode.value === "skip" && rules.value.length > 0) {
		return malformed(
			`"${REVIEW_UI}.${MODE}" is skip, which says screen review is not set up, and "${RULES}" declares ${rules.value.length} rule(s) for it — drop the rules, or set ${MODE} to preview or hand-check`,
		);
	}
	return {
		_tag: "Value",
		value: {mode: mode.value, screens: screens.value, whenNoPreview: rules.value},
	};
};

/** The shape a repo writes: an unset `mode` is absent, never `null`. */
const render = ({mode, screens, whenNoPreview}: ReviewUi): unknown => ({
	...(mode === null ? {} : {[MODE]: mode}),
	[SCREENS]: screens,
	[WHEN_NO_PREVIEW]: whenNoPreview,
});

const PATH_PATTERN = "^(?!/)(?!.*(^|/)\\.\\.(/|$))\\S(.*\\S)?$";

export const reviewUiKey: KeyGroup<ReviewUi> = {
	key: REVIEW_UI,
	shippedDefault: SHIPPED_REVIEW_UI,
	decode,
	render,
	jsonSchema: {
		type: "object",
		description:
			"How this repo reviews a change to a screen. A repo that declares no `mode`, no `screens`, no `whenNoPreview` rule and no `uiSurfaces` row has screen review off.",
		properties: {
			[MODE]: {
				type: "string",
				enum: [...SCREEN_REVIEW_MODES],
				description:
					"`preview`: the reviewer opens a hosted copy of each pull request, and a screen change with no preview ends CANT-SEE. `hand-check`: an owner's screenshots on the pull request stand in for the render. `skip`: screen review is not set up — a screen change gets the text review only, and the run says the screen check was skipped. Unset resolves to `skip` in a repo that declares no `screens`, no `whenNoPreview` rule and no `uiSurfaces` row, and to `preview` otherwise. `skip` beside a `whenNoPreview` rule is refused.",
			},
			[SCREENS]: {
				type: "array",
				description:
					"Where the screens live, for a repo with no `uiSurfaces` row to name them: repo-relative source roots that raise the ui class. Ending in `/` a root is a directory covering every file under it; otherwise it names exactly one file. No start command is needed.",
				items: {
					type: "string",
					minLength: 1,
					pattern: PATH_PATTERN,
				},
			},
			[WHEN_NO_PREVIEW]: {
				type: "array",
				description:
					"Path rules for a PR with no preview deploy. The first rule whose glob matches a ui-class file sets that file's mode; a file no rule matches takes the repo's `mode` (`preview` needs a render, `hand-check` an owner's screenshots). A PR whose ui files land in different modes takes the strictest: require-render, then hand-check, then skip.",
				items: {
					type: "object",
					properties: {
						paths: {
							type: "array",
							description:
								"Repo-relative globs — `*` within one segment, `**` spanning directories. Never absolute, never through `..`.",
							minItems: 1,
							items: {
								type: "string",
								minLength: 1,
								pattern: PATH_PATTERN,
							},
						},
						mode: {
							type: "string",
							enum: [...NO_PREVIEW_MODES],
							description:
								"`require-render`: no preview is CANT-SEE. `hand-check`: an owner's screenshots on the PR naming its exact head stand in for the render, routed with `fabrika review-ui route --hand-check`. `skip`: no rendered review is owed, routed with `fabrika review-ui route --no-preview`. Both non-render outcomes are flagged on the record and in `ship gate`.",
						},
					},
					required: ["paths", "mode"],
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	},
};
