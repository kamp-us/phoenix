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
 *
 * It is applied to a line's **prose**, which in a comment-framed block is the line with its decoration
 * removed — see {@link commentFramedLines}.
 */
const BLOCK_BREAK = /^\s*$|^\s*#{1,6}\s|^\s*(?:[-*+]|\d+[.)])\s|^\s*(?:```|~~~)/;

const COMMENT_OPEN = "/*";
const COMMENT_CLOSE = "*/";

/**
 * A block comment's decoration on one line: its opener, or the star a docblock repeats down its left
 * edge. The terminator is excluded — that ends the frame rather than decorating a line inside it.
 */
const COMMENT_DECORATION = /^\s*(?:\/\*+|\*(?!\/))\s?/;

/**
 * Which lines sit inside a block comment — the frame the anchor's paragraph is written in (#5514).
 *
 * Half the guarded corpus writes its anchored claims in TypeScript docblocks, where every continuation
 * line begins with a star. Read as markdown that star is a new list item, so {@link BLOCK_BREAK} fired
 * on the line immediately after every `.ts` anchor and its block was truncated to the tag's own line —
 * 80 anchors counted in the `anchors-in-reach` denominator and structurally unable to contribute to
 * the numerator, which is the shape #5514 exists to remove.
 *
 * The two cases are only distinguishable by *frame*, never by the line: `* a bullet` and a docblock's
 * `* a continuation` are the same bytes. So the frame is resolved once per file here, and a
 * comment-framed block reads each line's prose with its decoration stripped, ending where the comment
 * does. Keying on the frame rather than on a file extension is what keeps an anchor in a docblock and
 * an anchor in prose one rule instead of two — a `.md` file's fenced TypeScript example is framed by
 * the same evidence its `.ts` original is.
 *
 * The scan is over comment syntax, not a parse, so an unterminated opener inside a string literal
 * would frame the lines after it. That misreads nothing on its own: the block still ends at the same
 * paragraph boundaries, it just tolerates a leading star — and a tag reached after real content is
 * already fenced to its own line by {@link OPENS_LINE}.
 */
const commentFramedLines = (lines: ReadonlyArray<string>): ReadonlyArray<boolean> => {
	const framed: boolean[] = [];
	let open = false;
	for (const line of lines) {
		if (open) {
			framed.push(true);
			if (line.includes(COMMENT_CLOSE)) open = false;
			continue;
		}
		const opened = line.lastIndexOf(COMMENT_OPEN);
		const closed = opened >= 0 && line.indexOf(COMMENT_CLOSE, opened + COMMENT_OPEN.length) >= 0;
		open = opened >= 0 && !closed;
		framed.push(open);
	}
	return framed;
};

/**
 * Whitespace collapsed to single spaces, so a re-wrap is not a change.
 *
 * A block spans several lines and markdown line breaks are cosmetic: comparing raw bytes would report
 * every reflow as a weakened guarantee, which is the same noise {@link scanAnchors}' move-is-not-a-hit
 * rule exists to avoid.
 */
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * What may sit before a tag on a line that still *opens* a paragraph: indentation, blockquote markers
 * and one list bullet. Nothing else.
 *
 * A tag reached only after real content did not open the lines below it, so continuing through them
 * captures text the anchor never covered. That is not hypothetical: this file's own tests embed the
 * tag in TypeScript string literals, and the block ran off the end of the literal and swallowed the
 * assertions after it, so editing an assertion reported the fixture as a moved invariant.
 *
 * Nearly every anchor in the guarded corpus opens its line — bare, after a bullet, after a blockquote
 * marker, or after a docblock's star. The exceptions are of two kinds and neither is a loss. A handful
 * of markdown anchors are written at the very *end* of their line, so their compared text is the empty
 * string either way. The rest are this package's own test fixtures, which embed the tag in a string
 * literal — the case the fence exists for.
 *
 * A tag that does NOT open its line still gets a block: the text trailing it on that one line, which
 * is exactly what the diff walk has always compared. So this is a fence on the *widening*, never a
 * narrowing of what was already covered (#5514).
 */
const OPENS_LINE = /^[\s>]*(?:(?:[-*+]|\d+[.)])\s+)?$/;

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
 *
 * Inside a block comment a line's prose is the line minus its decoration, and the comment's
 * terminator ends the block — see {@link commentFramedLines} for why the frame, not the file's
 * extension, is what decides.
 */
export const anchorBlocksIn = (text: string): ReadonlyArray<AnchorBlock> => {
	const lines = text.split("\n");
	const framed = commentFramedLines(lines);
	const blocks: AnchorBlock[] = [];
	for (const [index, line] of lines.entries()) {
		const matched = ANCHOR.exec(maskInlineCode(line));
		if (matched?.[1] === undefined) continue;
		const inComment = framed[index] === true;
		const prose = (raw: string): string => (inComment ? raw.replace(COMMENT_DECORATION, "") : raw);
		const body = [line.slice(matched.index + matched[0].length)];
		const opens = OPENS_LINE.test(prose(line.slice(0, matched.index)));
		for (let next = index + 1; opens && next < lines.length; next += 1) {
			const raw = lines[next] ?? "";
			if (inComment && framed[next] !== true) break;
			const ends = inComment ? raw.indexOf(COMMENT_CLOSE) : -1;
			const candidate = prose(ends >= 0 ? raw.slice(0, ends) : raw);
			// The break test reads the raw line and the anchor test the masked one, because masking is
			// length-preserving but not content-preserving: it eats the leading backticks of a ``` fence,
			// which is exactly the marker the break is looking for.
			if (BLOCK_BREAK.test(candidate) || ANCHOR.test(maskInlineCode(candidate))) break;
			body.push(candidate);
			if (ends >= 0) break;
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
 * A name absent from `after` is `removed`; a name whose normalized block text differs is `modified`,
 * reported at the line it now sits on. A block that only moved is neither.
 *
 * **An unchanged block is claimed before a reworded one, and each is claimed once.** Where a name is
 * used twice in one file, matching by position alone answers the wrong question the moment a new
 * occurrence is inserted above an old one: both blocks are intact, but occurrence 1 is now compared
 * against occurrence 2's text and reads as reworded. Matching an identical block first makes an
 * insertion silent while leaving a genuine rewording loud, because a reworded block has no identical
 * counterpart to claim; consuming each match keeps two same-named blocks two questions rather than
 * letting one answer for both.
 */
export const scanAnchorBlocks = (
	file: string,
	before: string,
	after: string,
): ReadonlyArray<AnchorHit> => {
	const later = byName(anchorBlocksIn(after));
	const hits: AnchorHit[] = [];
	for (const block of anchorBlocksIn(before)) {
		const candidates = later.get(block.name) ?? [];
		const intact = candidates.findIndex((entry) => entry.text === block.text);
		if (intact >= 0) {
			candidates.splice(intact, 1);
			continue;
		}
		const reworded = candidates.shift();
		if (reworded === undefined) {
			hits.push({kind: "removed", name: block.name, file, line: block.line});
		} else {
			hits.push({kind: "modified", name: block.name, file, line: reworded.line});
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
