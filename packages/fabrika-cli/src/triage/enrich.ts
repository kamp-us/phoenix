/**
 * The `triage enrich` envelope: how a body is composed, and how a prior enrichment is recognised.
 *
 * **Detection is a marker the verb writes, not a shape it infers** (founder ruling on #4866,
 * 2026-08-08, option (b)). The two shape-based detectors that preceded it were mode-scoped and keyed
 * on disjoint literals, so a re-run in the *other* mode matched neither, fell through to "first
 * enrichment ⇒ wrap", and nested the whole existing envelope — provenance boundary included — inside
 * a fresh block, compounding per run. A marker is one rule and is mode-independent, so that class
 * dies for every marker-bearing body rather than for one axis of it.
 *
 * **The marker is also the boundary.** It sits on its own line immediately above the preserved
 * `<details>` block, so "is this enriched?" and "where does the authored region end?" are the same
 * read. Nothing has to locate a `<details>` opener or a summary literal, which is what made the old
 * detectors mode-scoped in the first place.
 *
 * **The issue number is bound into the marker**, so an enriched body pasted into a *different* issue
 * reads as fresh and is wrapped rather than partially overwritten. That covers both the
 * quote-impersonation case the retired terminality test defended against and the
 * paste-that-ends-the-body residual it could not — the case `contract.md` named as the limit of any
 * content-derived test.
 *
 * Pre-marker bodies are recognised by `./enrich-legacy.ts`, which is one-time migration code.
 */

/** Which authored region the verb last wrote: a rewrite (default mode) or a pitch (`--epic`). */
export type EnrichMode = "rewrite" | "wrap";

/** The summary line each mode's preserved block carries. Pinned by the contract, byte for byte. */
export const SUMMARY_LINE: Readonly<Record<EnrichMode, string>> = {
	rewrite: "<summary>Original report (verbatim)</summary>",
	wrap: "<summary>Original brief (verbatim)</summary>",
};

/**
 * The marker, anchored to a whole line.
 *
 * Anchored, never a substring test: a body that *quotes* the marker inside a fenced block or mid-line
 * — a bug report about this very format is an ordinary filing here — must not be read as carrying
 * one. The number and the mode are captured because the number is the binding this ruling turns on.
 */
export const MARKER_RE = /^<!-- fabrika:enriched issue=(\d+) mode=(rewrite|wrap) -->$/m;

export const renderMarker = (issue: number, mode: EnrichMode): string =>
	`<!-- fabrika:enriched issue=${issue} mode=${mode} -->`;

export type Detection =
	/** No enrichment of *this* issue is present, so the whole body is the original to preserve. */
	| {
			readonly _tag: "Fresh";
			readonly reason: "no marker" | "marker binds another issue" | "no v1 envelope";
			/** The issue the foreign marker binds, when that is why this body reads as fresh. */
			readonly boundTo: number | null;
	  }
	/** Enriched already: replace everything above `preserved`, and keep `preserved` byte for byte. */
	| {
			readonly _tag: "Enriched";
			readonly via: "marker" | "legacy";
			/** The mode the marker records, or `null` for a legacy body that carries no marker. */
			readonly markedMode: EnrichMode | null;
			readonly preserved: string;
	  };

/**
 * Split a marker-bearing body at its **first** marker line.
 *
 * First, not last, and that ordering is load-bearing: the verb always emits its own marker *above*
 * the preserved block, so a marker carried inside preserved content — a quoted envelope, a foreign
 * paste that was wrapped — is always the later one and can never be mistaken for the boundary.
 */
const splitAtMarker = (
	body: string,
): {readonly issue: number; readonly mode: EnrichMode; readonly preserved: string} | null => {
	const match = MARKER_RE.exec(body);
	if (match === null || match.index === undefined) return null;
	const after = match.index + match[0].length;
	return {
		issue: Number(match[1]),
		mode: match[2] as EnrichMode,
		// Drop the single newline that terminates the marker line; everything below is verbatim.
		preserved: body.slice(body.startsWith("\n", after) ? after + 1 : after),
	};
};

/**
 * Classify a body against the issue it lives on.
 *
 * `legacyPreserved` is injected rather than imported so the migration branch is one argument and one
 * module to delete when the v1 backlog is absorbed — see `./enrich-legacy.ts`.
 */
export const detect = (
	body: string,
	issue: number,
	legacyPreserved: (body: string) => string | null,
): Detection => {
	const marked = splitAtMarker(body);
	if (marked !== null) {
		return marked.issue === issue
			? {_tag: "Enriched", via: "marker", markedMode: marked.mode, preserved: marked.preserved}
			: {_tag: "Fresh", reason: "marker binds another issue", boundTo: marked.issue};
	}
	// The legacy shapes are only consulted for a body carrying NO marker at all. A body whose marker
	// binds another issue returned above: it is a paste, and running a shape test over a paste is
	// exactly the impersonation the binding exists to refuse.
	const legacy = legacyPreserved(body);
	return legacy === null
		? {_tag: "Fresh", reason: "no marker", boundTo: null}
		: {_tag: "Enriched", via: "legacy", markedMode: null, preserved: legacy};
};

const EPIC_HEADER = "## Epic — awaiting plan";

/** The authored region — everything above the marker — for one mode and one caller's stdin. */
const authoredRegion = (mode: EnrichMode, text: string): string =>
	mode === "rewrite"
		? `${text.trim()}\n\n---\n\n`
		: `## Pitch\n\n${text.trim()}\n\n${EPIC_HEADER}\n\n\`plan-epic\` appends its plan and dependency topology below.\n\n`;

/** The preserved block a **first** enrichment builds around the redacted original. */
export const wrapOriginal = (mode: EnrichMode, original: string): string =>
	`<details>\n${SUMMARY_LINE[mode]}\n\n${original.trim()}\n\n</details>\n`;

/**
 * The whole new body: a fresh authored region, the marker, then `preserved` verbatim.
 *
 * `preserved` is the block **and every byte below it** on a re-enrich — `plan-epic` writes its plan
 * and dependency topology under the wrap, and preserving the block alone would delete them, which is
 * the same destruction by a shorter route.
 */
export const composeBody = (options: {
	readonly mode: EnrichMode;
	readonly issue: number;
	readonly authored: string;
	readonly preserved: string;
}): string =>
	`${authoredRegion(options.mode, options.authored)}${renderMarker(options.issue, options.mode)}\n${options.preserved}`;
