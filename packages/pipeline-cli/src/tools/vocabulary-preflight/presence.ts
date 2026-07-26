/**
 * Whether the labels a scan scopes on exist in the target repo at all (#4272).
 *
 * A leaf module with no imports on purpose: the guards consume the type and `vocabulary.ts`
 * builds the required set out of the guards' own constants, so parking this type in either
 * place would make the preflight and the guards import each other in a cycle.
 */

/**
 * Absence carries the missing names because naming them IS the remedy: a guard that reds on an
 * absent vocabulary has to say which label the adopting repo never created, or the red is the
 * same unactionable "nothing in scope" it replaced.
 */
export type VocabularyPresence =
	| {readonly _tag: "present"}
	| {readonly _tag: "absent"; readonly missing: ReadonlyArray<string>};

export const PRESENT: VocabularyPresence = {_tag: "present"};

/**
 * Resolve the scoping labels a check depends on against the repo's live label universe.
 *
 * Fail-closed by construction (ADR 0092): an empty universe resolves ABSENT, never present — an
 * unreadable label list and a repo that genuinely has none are indistinguishable from here, and
 * the safe reading of both is "the prerequisite is unmet".
 */
export const resolvePresence = (
	required: ReadonlyArray<string>,
	universe: ReadonlyArray<string>,
): VocabularyPresence => {
	const missing = required.filter((label) => !universe.includes(label));
	return missing.length === 0 ? PRESENT : {_tag: "absent", missing};
};
