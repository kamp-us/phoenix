/**
 * The anchored-invariant scan: a per-anchor **block** comparison of two commits' bytes, plus the
 * older same-line walk over a unified diff.
 *
 * An anchor is the `<!-- anchor: NAME -->` HTML comment fabrika skills already carry. The inventory
 * therefore lives **in the guarded file**, which is the whole design difference from v1's gate check:
 * that one kept a hardcoded prose list of what each gate promises, inside the reviewing skill, so the
 * copy drifted from the guards silently and nothing checked it. Anchors cannot rot while the guards
 * move, because they move with them.
 *
 * **Why a block comparison exists at all (#5514).** The diff walk below can only see an anchor whose
 * *own line* is in the diff, and it compares only the text trailing the tag on that line. Anchors in
 * this corpus are inline — `<!-- anchor: NAME --> **Claim.** …` — and the claim wraps over several
 * more lines, so a rewrite of those continuation lines left the anchor line byte-identical, produced
 * no sighting at all, and the verb answered `no-anchor-change` over a guarantee that had in fact been
 * reworded (PR #5501). {@link scanAnchorBlocks} compares each anchor's whole paragraph at both
 * commits, so what it sees does not depend on the shape of the diff.
 *
 * What the scan still cannot see is stated rather than implied: a guard weakened in prose carrying no
 * anchor is invisible here **by construction**. That is why the verb's third outcome is
 * `no-anchors-in-reach` — the mechanical floor reporting its own silence — and never a clearance.
 */

const ANCHOR = /<!--\s*anchor:\s*([A-Z][A-Z0-9-]*)\s*-->/;
const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const INLINE_CODE = /`[^`]*`/g;

/**
 * The line with its inline-code spans blanked out — an anchor tag inside backticks is *documentation
 * of the pattern*, not an anchor. Without this the scan counts the governance skill's own sentence
 * describing the tag as a twelfth anchor of eleven, which inflates the `anchors-in-reach` denominator
 * and would report a phantom `modified` the day that sentence is reworded — both landing on the
 * self-editing PR the fence exists for (#5199).
 *
 * The blanking is length-preserving on purpose: every index into the masked text is an index into the
 * original, so a caller matches here and still slices the real bytes. Position, not line-start, is the
 * discriminator — real anchors sit after a list bullet and after a heading too, so a line-start rule
 * would drop genuine anchors, which is a worse defect than the one being fixed.
 */
const maskInlineCode = (text: string): string =>
	text.replace(INLINE_CODE, (span) => " ".repeat(span.length));

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
	const matched = ANCHOR.exec(maskInlineCode(text));
	if (matched?.[1] === undefined) return null;
	return {name: matched[1], rest: text.slice(matched.index + matched[0].length).trim(), line};
};

/** How many anchors a file's bytes carry — the `anchors-in-reach` denominator, per file. */
export const anchorsIn = (text: string): number =>
	text.split("\n").filter((line) => ANCHOR.test(maskInlineCode(line))).length;

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

/**
 * A line that ends the paragraph an anchor opened: blank, a heading, a new list item, or a fence.
 *
 * Markdown has no end-of-paragraph token, so the block has to end at what starts the *next* unit. The
 * list-item and heading clauses are what keep an anchor sitting on one bullet from swallowing its
 * siblings — without them a reword of the bullet *below* an anchor reads as that anchor moving, and a
 * guard that cries on unrelated prose gets read past.
 */
const BLOCK_BREAK = /^\s*$|^\s*#{1,6}\s|^\s*(?:[-*+]|\d+[.)])\s|^\s*(?:```|~~~)/;

/**
 * Whitespace collapsed to single spaces, so a re-wrap is not a change.
 *
 * A block spans several lines and markdown line breaks are cosmetic: comparing raw bytes would report
 * every reflow as a weakened guarantee, which is the same noise {@link scanAnchors}' move-is-not-a-hit
 * rule exists to avoid.
 */
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One anchor's paragraph at one commit — the tag's trailing text plus the lines that continue it. */
interface AnchorBlock {
	readonly name: string;
	/** 1-based, the line the tag itself sits on. */
	readonly line: number;
	readonly text: string;
}

/**
 * Every anchor a file's bytes carry, with the paragraph each one opens.
 *
 * Anchor detection runs on {@link maskInlineCode}'d text, on the line that *opens* a block and on
 * every line that could *end* one, so a tag inside backticks neither mints a block nor cuts one
 * short. The compared text is the real bytes, because that fence is about what counts as an anchor,
 * not about which prose an anchor covers.
 */
export const anchorBlocksIn = (text: string): ReadonlyArray<AnchorBlock> => {
	const lines = text.split("\n");
	const blocks: AnchorBlock[] = [];
	for (const [index, line] of lines.entries()) {
		const matched = ANCHOR.exec(maskInlineCode(line));
		if (matched?.[1] === undefined) continue;
		const body = [line.slice(matched.index + matched[0].length)];
		for (let next = index + 1; next < lines.length; next += 1) {
			const candidate = lines[next] ?? "";
			// The break test reads the raw line and the anchor test the masked one, because masking is
			// length-preserving but not content-preserving: it eats the leading backticks of a ``` fence,
			// which is exactly the marker the break is looking for.
			if (BLOCK_BREAK.test(candidate) || ANCHOR.test(maskInlineCode(candidate))) break;
			body.push(candidate);
		}
		blocks.push({name: matched[1], line: index + 1, text: normalize(body.join(" "))});
	}
	return blocks;
};

const byName = (blocks: ReadonlyArray<AnchorBlock>): Map<string, AnchorBlock[]> => {
	const grouped = new Map<string, AnchorBlock[]>();
	for (const block of blocks) {
		const kept = grouped.get(block.name);
		if (kept === undefined) grouped.set(block.name, [block]);
		else kept.push(block);
	}
	return grouped;
};

/**
 * Every anchored invariant whose block `before` carries and `after` removed or reworded.
 *
 * Pairing is by NAME and then by occurrence, so a name used twice in one file is two independent
 * questions rather than one that answers itself from the wrong paragraph. A name absent from `after`
 * is `removed`; a name whose normalized block text differs is `modified`, reported at the line it
 * now sits on. A block that only moved is neither.
 */
export const scanAnchorBlocks = (
	file: string,
	before: string,
	after: string,
): ReadonlyArray<AnchorHit> => {
	const later = byName(anchorBlocksIn(after));
	const seen = new Map<string, number>();
	const hits: AnchorHit[] = [];
	for (const block of anchorBlocksIn(before)) {
		const nth = seen.get(block.name) ?? 0;
		seen.set(block.name, nth + 1);
		const match = later.get(block.name)?.[nth];
		if (match === undefined) {
			hits.push({kind: "removed", name: block.name, file, line: block.line});
		} else if (match.text !== block.text) {
			hits.push({kind: "modified", name: block.name, file, line: match.line});
		}
	}
	return hits;
};

/**
 * The two scans as one hit list, at most one hit per (file, NAME).
 *
 * The block comparison subsumes the diff walk wherever both can run, but not everywhere: a deleted
 * file has no head bytes to compare and a rename's base path is not in the change list, so the walk
 * is the only scan that reaches those. Keeping both and deduping is therefore a widening, never a
 * second opinion — and `first` wins so the walk's diff-order line numbers survive.
 */
export const mergeHits = (
	first: ReadonlyArray<AnchorHit>,
	second: ReadonlyArray<AnchorHit>,
): ReadonlyArray<AnchorHit> => {
	const merged: AnchorHit[] = [...first];
	const keys = new Set(first.map((hit) => `${hit.file} ${hit.name}`));
	for (const hit of second) {
		const key = `${hit.file} ${hit.name}`;
		if (keys.has(key)) continue;
		keys.add(key);
		merged.push(hit);
	}
	return merged;
};

/** A changed file is guard-bearing iff it carries an anchor, or sits under `.github/workflows/`. */
export const WORKFLOW_ROOT = ".github/workflows/";

export const isGuardBearing = (path: string, anchors: number): boolean =>
	anchors > 0 || path.startsWith(WORKFLOW_ROOT);
