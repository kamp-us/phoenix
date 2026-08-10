/**
 * `<set>/manifest.json` — the render→evidence seam, parsed.
 *
 * `ui render` writes this file byte-identically to its own stdout, and `ui evidence` reads the set
 * back through it: no value crosses that seam by memory, and a set whose manifest is absent or
 * unparseable is refused rather than reconstructed from whatever PNGs happen to be on disk.
 */

/** One capture as its set manifest records it. */
export interface SetCapture {
	readonly surface: string;
	readonly path: string;
	readonly sha256: string;
	readonly firstRender: boolean;
}

export type SetParse =
	| {readonly _tag: "Set"; readonly captures: ReadonlyArray<SetCapture>}
	| {readonly _tag: "Violation"; readonly violation: string};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parseSetManifest = (text: string): SetParse => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {_tag: "Violation", violation: `it does not parse (${(err as Error).message})`};
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.captures)) {
		return {_tag: "Violation", violation: "it carries no captures array"};
	}
	if (parsed.captures.length === 0) return {_tag: "Violation", violation: "it names zero captures"};
	const captures: SetCapture[] = [];
	for (const capture of parsed.captures) {
		if (
			!isRecord(capture) ||
			typeof capture.surface !== "string" ||
			typeof capture.path !== "string" ||
			typeof capture.sha256 !== "string"
		) {
			return {_tag: "Violation", violation: "a capture row is missing surface, path or sha256"};
		}
		captures.push({
			surface: capture.surface,
			path: capture.path,
			sha256: capture.sha256,
			firstRender: capture.firstRender === true,
		});
	}
	return {_tag: "Set", captures};
};

/** An after-surface with its before, or the recorded fact that it is new. */
export interface Pair {
	readonly surface: string;
	readonly before: SetCapture | null;
	readonly after: SetCapture;
}

export type Pairing =
	| {readonly _tag: "Pairs"; readonly pairs: ReadonlyArray<Pair>}
	| {readonly _tag: "Unexplained"; readonly surface: string};

/**
 * Pair every after-capture with its before by surface id.
 *
 * A `firstRender` surface pairs with nothing and is labeled a new surface; an after-surface with
 * neither a before nor a `firstRender` mark refuses, because an unexplained missing baseline is a
 * hole in the evidence, not a layout choice.
 */
export const pairSets = (
	before: ReadonlyArray<SetCapture>,
	after: ReadonlyArray<SetCapture>,
): Pairing => {
	const index = new Map(before.map((capture) => [capture.surface, capture]));
	const pairs: Pair[] = [];
	for (const capture of after) {
		const match = index.get(capture.surface) ?? null;
		if (match === null && !capture.firstRender) {
			return {_tag: "Unexplained", surface: capture.surface};
		}
		pairs.push({
			surface: capture.surface,
			before: capture.firstRender ? null : match,
			after: capture,
		});
	}
	return {_tag: "Pairs", pairs};
};
