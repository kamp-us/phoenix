/**
 * The anchored-invariant scan, pure over a unified diff.
 *
 * An anchor is the `<!-- anchor: NAME -->` HTML comment fabrika skills already carry. The inventory
 * therefore lives **in the guarded file**, which is the whole design difference from v1's gate check:
 * that one kept a hardcoded prose list of what each gate promises, inside the reviewing skill, so the
 * copy drifted from the guards silently and nothing checked it. Anchors cannot rot while the guards
 * move, because they move with them.
 *
 * What this scan cannot see is stated rather than implied: a guard weakened in prose carrying no
 * anchor is invisible here **by construction**. That is why the verb's third outcome is
 * `no-anchors-in-reach` — the mechanical floor reporting its own silence — and never a clearance.
 */

const ANCHOR = /<!--\s*anchor:\s*([A-Z][A-Z0-9-]*)\s*-->/;
const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** One anchored invariant the diff removes or changes. */
export interface AnchorHit {
	readonly kind: "removed" | "modified";
	readonly name: string;
	readonly file: string;
	readonly line: number;
}

/** One side of the diff: the anchor's name, the text that followed it, and the line it sat on. */
interface AnchorSighting {
	readonly name: string;
	readonly rest: string;
	readonly line: number;
}

const sightingOf = (text: string, line: number): AnchorSighting | null => {
	const matched = ANCHOR.exec(text);
	if (matched?.[1] === undefined) return null;
	return {name: matched[1], rest: text.slice(matched.index + matched[0].length).trim(), line};
};

/** How many anchors a file's bytes carry — the `anchors-in-reach` denominator, per file. */
export const anchorsIn = (text: string): number =>
	text.split("\n").filter((line) => ANCHOR.test(line)).length;

/** The destination path of one `diff --git` header, or `null` when the line is not one. */
export const changedFileOf = (line: string): string | null => FILE_HEADER.exec(line)?.[2] ?? null;

/** How many files a unified diff carries — the completeness proof's numerator. */
export const filesInDiff = (diff: string): number =>
	diff.split("\n").filter((line) => FILE_HEADER.test(line)).length;

/**
 * Every anchored invariant the diff removes or modifies, in diff order.
 *
 * The pairing is by NAME within a file: a name on a removed line and on no added line is `removed`;
 * a name on both sides whose following text differs is `modified`. A name on both sides with the
 * same text moved and did not change, so it is neither — a scan that reported it would drown the
 * two findings that matter in every reflow.
 */
export const scanAnchors = (diff: string): ReadonlyArray<AnchorHit> => {
	const hits: AnchorHit[] = [];
	let file: string | null = null;
	let removed: AnchorSighting[] = [];
	let added: AnchorSighting[] = [];
	let oldLine = 0;
	let newLine = 0;

	const flush = (): void => {
		if (file === null) return;
		for (const gone of removed) {
			const back = added.find((entry) => entry.name === gone.name);
			if (back === undefined) {
				hits.push({kind: "removed", name: gone.name, file, line: gone.line});
			} else if (back.rest !== gone.rest) {
				hits.push({kind: "modified", name: gone.name, file, line: back.line});
			}
		}
		removed = [];
		added = [];
	};

	for (const line of diff.split("\n")) {
		const header = changedFileOf(line);
		if (header !== null) {
			flush();
			file = header;
			continue;
		}
		const hunk = HUNK_HEADER.exec(line);
		if (hunk !== null) {
			oldLine = Number(hunk[1] ?? "0");
			newLine = Number(hunk[2] ?? "0");
			continue;
		}
		if (file === null) continue;
		if (line.startsWith("---") || line.startsWith("+++")) continue;
		if (line.startsWith("-")) {
			const seen = sightingOf(line.slice(1), oldLine);
			if (seen !== null) removed.push(seen);
			oldLine += 1;
		} else if (line.startsWith("+")) {
			const seen = sightingOf(line.slice(1), newLine);
			if (seen !== null) added.push(seen);
			newLine += 1;
		} else if (line.startsWith(" ") || line === "") {
			oldLine += 1;
			newLine += 1;
		}
	}
	flush();
	return hits;
};

/** A changed file is guard-bearing iff it carries an anchor, or sits under `.github/workflows/`. */
export const WORKFLOW_ROOT = ".github/workflows/";

export const isGuardBearing = (path: string, anchors: number): boolean =>
	anchors > 0 || path.startsWith(WORKFLOW_ROOT);
