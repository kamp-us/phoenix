/**
 * `containmentVocabulary` — which child types are asked for a `**Containment:**` marker, and which
 * values satisfy it.
 *
 * Declared rather than compiled in (R14.1, #5603 comment 47), because containment is a *deployment*
 * story and fabrika installs into repos that have a different one or none at all. Phoenix ships
 * dark-ship, so its marker reads `flag` or `exempt`; a library repo might ask for `unpublished` or
 * `exempt`; a repo with no deployment story asks for nothing.
 *
 * **The shipped default is phoenix's pair, and it is deliberately not empty.** An empty default
 * would retire a gate for every repo that never declared anything, which is the one direction this
 * surface never moves in.
 *
 * **An empty half means the marker is never required.** A repo turning containment off empties
 * either list, and both readers stop asking — that is the graceful absence a repo with no
 * deployment story needs, and it is a declaration rather than the side effect of a missing file.
 *
 * This module owns the whole containment judgment — the read and the gap — because `ledger child`
 * and the plan floor both make it, and two derivations of "which types, which values" are two
 * chances to answer one question differently.
 */

import {isRecord} from "../../io/json.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const CONTAINMENT_VOCABULARY = "containmentVocabulary";

/**
 * The keyword that *declines* containment, reserved across every repo's vocabulary.
 *
 * It is recognised so a child that writes it reads as "declared and declined" rather than as a typo,
 * and it can never be a legal value: a marker whose value is the declination satisfies nothing.
 */
export const DECLINED = "none";

export interface ContainmentVocabulary {
	/** The `type:` labels a child must carry to be asked for a marker at all. */
	readonly types: ReadonlyArray<string>;
	/** The keywords that satisfy the marker, lowercased. Never carries {@link DECLINED}. */
	readonly values: ReadonlyArray<string>;
}

/** Phoenix's pair — what a repo declaring nothing still gets. */
export const SHIPPED_CONTAINMENT_VOCABULARY: ContainmentVocabulary = {
	types: ["type:feature"],
	values: ["flag", "exempt"],
};

const MALFORMED = `\`${CONTAINMENT_VOCABULARY}\` is not {"types": [type labels], "values": [keywords]} — e.g. {"types": ["type:feature"], "values": ["flag", "exempt"]}`;

const decode = (raw: unknown): Decoded<ContainmentVocabulary> => {
	if (!isRecord(raw)) return {_tag: "Malformed", reason: MALFORMED};
	// Each half falls to its own shipped value when absent, so a repo re-spelling the values keeps
	// the default type set without restating it.
	const types =
		raw.types === undefined ? SHIPPED_CONTAINMENT_VOCABULARY.types : trimmedStrings(raw.types);
	const declared =
		raw.values === undefined ? SHIPPED_CONTAINMENT_VOCABULARY.values : trimmedStrings(raw.values);
	if (types === null || declared === null) return {_tag: "Malformed", reason: MALFORMED};
	const values = declared.map((value) => value.toLowerCase());
	if (values.includes(DECLINED)) {
		return {
			_tag: "Malformed",
			reason: `\`${CONTAINMENT_VOCABULARY}\` declares "${DECLINED}" as a legal value — it is the reserved declination, so a child declaring it would satisfy the marker by refusing it.`,
		};
	}
	return {_tag: "Value", value: {types, values}};
};

export const containmentVocabularyKey: KeyGroup<ContainmentVocabulary> = {
	key: CONTAINMENT_VOCABULARY,
	shippedDefault: SHIPPED_CONTAINMENT_VOCABULARY,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"Which child types are asked for a `**Containment:**` marker, and which values satisfy it. An empty half means the marker is never required.",
		properties: {
			types: {
				type: "array",
				description: "The `type:` labels a child must carry to be asked for a marker.",
				items: {type: "string", minLength: 1},
			},
			values: {
				type: "array",
				description: `The keywords that satisfy the marker. Never "${DECLINED}", the reserved declination.`,
				items: {type: "string", minLength: 1},
			},
		},
		additionalProperties: false,
	},
};

/** Whether this vocabulary asks any child for a marker. An empty half is a vocabulary that asks nothing. */
export const asksNothing = (vocabulary: ContainmentVocabulary): boolean =>
	vocabulary.types.length === 0 || vocabulary.values.length === 0;

/**
 * A child's containment keyword: the leading word of the marker value, when the vocabulary knows it.
 *
 * Leading word only, so `flag (default-off)` reads as `flag`. A keyword the vocabulary does not know
 * reads as **unset** rather than as itself — a marker nobody can act on is not a declaration, and
 * folding the two would let a typo print as though the repo had chosen it.
 */
export const readContainment = (
	value: string | undefined,
	vocabulary: ContainmentVocabulary,
): string | null => {
	const keyword =
		(value ?? "")
			.trim()
			.split(/[\s(,.]/)[0]
			?.toLowerCase() ?? "";
	return keyword === DECLINED || vocabulary.values.includes(keyword) ? keyword : null;
};

/** Why a child's marker is off the vocabulary: the asked type it carries, and what it declared. */
export interface ContainmentGap {
	readonly type: string;
	/** The declared keyword, or `unset` when there was none the vocabulary knows. */
	readonly got: string;
}

/**
 * The one containment judgment, over one child.
 *
 * Both callers word their own refusal from it — the same fact reads as "this child cannot be minted"
 * to `ledger child` and as a `MISSING_CONTAINMENT` defect to the plan floor — but *whether* there is
 * a gap is decided here, once.
 */
export const containmentGap = (
	vocabulary: ContainmentVocabulary,
	labels: ReadonlyArray<string>,
	containment: string | null,
): ContainmentGap | null => {
	if (asksNothing(vocabulary)) return null;
	const asked = vocabulary.types.find((type) => labels.includes(type));
	if (asked === undefined) return null;
	if (containment !== null && vocabulary.values.includes(containment)) return null;
	return {type: asked, got: containment ?? "unset"};
};
