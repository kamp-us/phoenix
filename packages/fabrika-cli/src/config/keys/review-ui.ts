/**
 * `reviewUi` — what the rendered-review gate needs from a PR that has no preview deploy.
 *
 * One sub-key today, `whenNoPreview`: a list of `{paths, mode}` rules over repo-relative globs.
 * Which mode a PR resolves to is `../../review-ui/no-preview.ts`'s answer; this module ships the
 * vocabulary, the shape and its refusals.
 *
 * The shipped default is the empty list, and empty is today's behaviour: every file resolves to
 * `require-render`, so a PR with no preview ends `CANT-SEE` exactly as it did before the key existed.
 * A repo loosens that only by declaring a rule, path by path.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10038#issuecomment-5860347862
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const REVIEW_UI = "reviewUi";
export const WHEN_NO_PREVIEW = "whenNoPreview";
const RULES = `${REVIEW_UI}.${WHEN_NO_PREVIEW}`;

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
	readonly whenNoPreview: ReadonlyArray<NoPreviewRule>;
}

export const SHIPPED_REVIEW_UI: ReviewUi = {whenNoPreview: []};

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

const decode = (raw: unknown): Decoded<ReviewUi> => {
	if (!isRecord(raw)) return malformed(`\`${REVIEW_UI}\` is not an object`);
	const unknown = Object.keys(raw).find((key) => key !== WHEN_NO_PREVIEW);
	if (unknown !== undefined) {
		return malformed(
			`"${REVIEW_UI}.${unknown}" is not a known key — ${REVIEW_UI} carries ${WHEN_NO_PREVIEW}`,
		);
	}
	const declared = raw[WHEN_NO_PREVIEW];
	if (declared === undefined) return {_tag: "Value", value: SHIPPED_REVIEW_UI};
	if (!Array.isArray(declared)) return malformed(`"${RULES}" is not a list of {paths, mode} rules`);
	const rules: NoPreviewRule[] = [];
	for (const [index, entry] of declared.entries()) {
		const rule = decodeRule(entry, index);
		if (rule._tag === "Malformed") return rule;
		rules.push(rule.value);
	}
	return {_tag: "Value", value: {whenNoPreview: rules}};
};

export const reviewUiKey: KeyGroup<ReviewUi> = {
	key: REVIEW_UI,
	shippedDefault: SHIPPED_REVIEW_UI,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"What the rendered-review gate (`review-ui`) needs from a PR that has no preview deploy. Absent changes nothing: a PR with no preview ends CANT-SEE.",
		properties: {
			[WHEN_NO_PREVIEW]: {
				type: "array",
				description:
					"Path rules for a PR with no preview deploy. The first rule whose glob matches a ui-class file sets that file's mode; a file no rule matches needs a render (`require-render`). A PR whose ui files land in different modes takes the strictest: require-render, then hand-check, then skip.",
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
								pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$))\\S(.*\\S)?$",
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
