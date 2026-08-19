/**
 * The containment invariant, as a check over declared data rather than over compiled-in constants.
 *
 * A triage facet is **delete authority, not naming**: every label its `owns` matches and its keep set
 * does not is removed. #4285 is what that costs when the two disagree — a well-formed run stripped an
 * issue's only priority and printed a success line. The invariant that stops it: *the set of values an
 * input can produce must be a subset of what its facet owns.*
 *
 * Once the vocabulary is configuration, a test over constants proves nothing about what a repo
 * loaded, so the check lives here and runs at load. It refuses in two directions, and the asymmetry
 * is the whole design:
 *
 * - **A declared value its facet does not own is always refused.** Such a value is written and then
 *   never superseded, because the facet has no authority to remove it — two priorities coexist and
 *   every queue read downstream picks whichever it sees first.
 * - **An enumerated facet that owns a label no declared value produces is refused too.** Every extra
 *   member of a literal list is delete authority with no naming counterpart, which is #4285's exact
 *   shape.
 * - **A pattern wider than its values is not refused**, because that width is deliberate and not
 *   decidable anyway: `^p\d+$` owns `p3` so a priority retired from the vocabulary is still cleaned
 *   up, and no finite check can enumerate a regex's language to prove otherwise.
 */

/** What a facet owns: a regular expression over labels, or an explicit set of them. */
export type Ownership =
	| {readonly _tag: "Pattern"; readonly source: string}
	| {readonly _tag: "Set"; readonly labels: ReadonlyArray<string>};

/** One facet's vocabulary: what it owns, and every label an input can make it keep. */
export interface FacetVocabulary {
	readonly name: string;
	readonly owns: Ownership;
	readonly values: ReadonlyArray<string>;
}

/**
 * The `owns` predicate one ownership declares.
 *
 * A pattern that does not compile answers `false` for everything, which would silently hand the facet
 * zero delete authority — so {@link patternError} is what a decoder calls first, and no caller reaches
 * here with a source that does not compile.
 */
export const ownsLabel = (ownership: Ownership): ((label: string) => boolean) => {
	if (ownership._tag === "Set") {
		const labels = new Set(ownership.labels);
		return (label) => labels.has(label);
	}
	const pattern = new RegExp(ownership.source);
	return (label) => pattern.test(label);
};

/** Why `source` is not a usable pattern, or `null`. Called before {@link ownsLabel} ever compiles it. */
export const patternError = (source: string): string | null => {
	try {
		new RegExp(source);
		return null;
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
};

const render = (ownership: Ownership): string =>
	ownership._tag === "Set" ? `[${ownership.labels.join(", ")}]` : `/${ownership.source}/`;

const facetRefusal = (key: string, facet: FacetVocabulary): string | null => {
	const owned = ownsLabel(facet.owns);
	const both = `owns=${render(facet.owns)}, values=[${facet.values.join(", ")}]`;

	const unowned = facet.values.filter((value) => !owned(value));
	if (unowned.length > 0) {
		return `\`${key}\` facet \`${facet.name}\` declares ${unowned.length} value(s) it does not own — ${unowned.join(", ")}; ${both}. A value outside its facet's delete authority is written once and never superseded.`;
	}

	if (facet.owns._tag === "Set") {
		const values = new Set(facet.values);
		const extra = facet.owns.labels.filter((label) => !values.has(label));
		if (extra.length > 0) {
			return `\`${key}\` facet \`${facet.name}\` owns ${extra.length} label(s) no declared value produces — ${extra.join(", ")}; ${both}. An enumerated facet's extra member is delete authority with nothing to name it, which is #4285's mechanism.`;
		}
	}

	return null;
};

/**
 * Why the whole vocabulary violates containment, or `null`.
 *
 * Every facet is checked and the refusals are joined rather than short-circuited: a config with three
 * bad facets fixed one round-trip at a time is three refusals an operator reads one at a time.
 */
export const containmentRefusal = (
	key: string,
	facets: ReadonlyArray<FacetVocabulary>,
): string | null => {
	const refusals = facets.flatMap((facet) => {
		const refusal = facetRefusal(key, facet);
		return refusal === null ? [] : [refusal];
	});
	return refusals.length === 0 ? null : refusals.join(" ");
};
