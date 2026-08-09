/**
 * The unified-diff walk: how many files the served diff actually carries, and where each added or
 * removed line sits.
 *
 * **The completeness proof is the file count, and only the file count.** The bytes are local
 * `git diff <base>...<head>` at the bound commit (`diff-verb.ts`, #5117), so the proof compares the
 * `diff --git` header count against the PR's declared `changed_files` and a short one is refused:
 * serving a prefix as the whole PR is the #3925 blind-PASS class one layer down.
 *
 * No truncation marker is matched, because there is nothing to match. `application/vnd.github.diff`
 * does not truncate — over its limits it refuses with HTTP 406 and `errors[].code = "too_large"`,
 * under them it serves whole (live probe, recorded on #4993) — and these bytes do not come from
 * that endpoint anyway. The earlier claim that GitHub truncates at the API tier was asserted from
 * intuition and is false (CLAUDE.md's grounding rule).
 *
 * The count sees whole files only: a diff cut inside the last file's hunks still carries every
 * header and passes. That is a stated bound of the proof, not a failure mode defended against — no
 * producer for that shape is known.
 */

/**
 * Both header forms git emits, per side. A path holding a non-ASCII byte (`core.quotePath`, on by
 * default), a backslash, or a double quote is written `"a/…"` with C-style escapes, and the two
 * sides quote independently — a rename to a Turkish name gives `diff --git a/plain.ts "b/ünlü.ts"`.
 * Matching only the bare form made a quoted file invisible: it undercounted the completeness proof
 * AND handed that file's hunk lines to the previous file (#5159).
 */
const FILE_HEADER =
	/^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.*)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.*))$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const NAMED_ESCAPES: Readonly<Record<string, number>> = {
	a: 0x07,
	b: 0x08,
	f: 0x0c,
	n: 0x0a,
	r: 0x0d,
	t: 0x09,
	v: 0x0b,
	"\\": 0x5c,
	'"': 0x22,
};
const OCTAL_DIGIT = /^[0-7]$/;

/**
 * A quoted header path back to the real name.
 *
 * Git escapes byte by byte, so one `ç` arrives as `\303\247` — the escapes decode into a byte buffer
 * that is UTF-8 decoded once at the end. Decoding each escape to its own character instead would
 * yield mojibake, and `tierMHits` matches `TEST_FILE` against this name, so a name that does not
 * resolve is a blind scan rather than a cosmetic defect.
 */
const unquoteCStyle = (body: string): string => {
	const utf8 = new TextEncoder();
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i += 1) {
		const ch = body[i] ?? "";
		if (ch !== "\\") {
			bytes.push(...utf8.encode(ch));
			continue;
		}
		const next = body[i + 1] ?? "";
		const named = NAMED_ESCAPES[next];
		if (named !== undefined) {
			bytes.push(named);
			i += 1;
			continue;
		}
		if (OCTAL_DIGIT.test(next)) {
			let digits = "";
			while (digits.length < 3 && OCTAL_DIGIT.test(body[i + 1 + digits.length] ?? "")) {
				digits += body[i + 1 + digits.length] ?? "";
			}
			bytes.push(Number.parseInt(digits, 8) & 0xff);
			i += digits.length;
			continue;
		}
		// An escape git does not emit. Take the character literally: a review gate that reports a
		// slightly-off path beats one that throws on a diff it cannot parse.
		bytes.push(...utf8.encode(next));
		i += 1;
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
};

/** The `a/` and `b/` paths off a `diff --git` header, whichever of the two forms each side took. */
const headerPaths = (line: string): {readonly before: string; readonly after: string} | null => {
	const header = FILE_HEADER.exec(line);
	if (header === null) return null;
	const [, quotedBefore, bareBefore, quotedAfter, bareAfter] = header;
	return {
		before: quotedBefore === undefined ? (bareBefore ?? "") : unquoteCStyle(quotedBefore),
		after: quotedAfter === undefined ? (bareAfter ?? "") : unquoteCStyle(quotedAfter),
	};
};

/** How many files the served diff carries — the numerator of the completeness proof. */
export const filesInDiff = (diff: string): number =>
	diff.split("\n").filter((line) => FILE_HEADER.test(line)).length;

/** One added or removed line, resolved to the file and line number a human can open. */
export interface DiffLine {
	readonly file: string;
	readonly line: number;
	readonly kind: "added" | "removed";
	readonly text: string;
}

/**
 * Every added and removed line in the diff, with its file and line number.
 *
 * An added line is numbered in the **new** file and a removed line in the **old** one, because those
 * are the numbers that resolve: a deleted assertion does not exist at any new-file line. The file
 * name is the `b/` path, falling back to `a/` for a deletion, so a rename reports where the line now
 * lives.
 */
export const changedLines = (diff: string): ReadonlyArray<DiffLine> => {
	const out: DiffLine[] = [];
	let file = "";
	let oldLine = 0;
	let newLine = 0;
	for (const raw of diff.split("\n")) {
		const header = headerPaths(raw);
		if (header !== null) {
			const {before, after} = header;
			file = after === "/dev/null" || after === "" ? before : after;
			oldLine = 0;
			newLine = 0;
			continue;
		}
		const hunk = HUNK_HEADER.exec(raw);
		if (hunk !== null) {
			oldLine = Number.parseInt(hunk[1] ?? "0", 10);
			newLine = Number.parseInt(hunk[2] ?? "0", 10);
			continue;
		}
		// Everything above the first hunk — the `index`, `---` and `+++` lines — carries no line
		// number, so it is skipped rather than read as a change.
		if (newLine === 0 && oldLine === 0) continue;
		if (raw.startsWith("+")) {
			out.push({file, line: newLine, kind: "added", text: raw.slice(1)});
			newLine += 1;
		} else if (raw.startsWith("-")) {
			out.push({file, line: oldLine, kind: "removed", text: raw.slice(1)});
			oldLine += 1;
		} else if (raw.startsWith(" ") || raw === "") {
			oldLine += 1;
			newLine += 1;
		}
	}
	return out;
};

/** The two mechanically-detectable §DEV classes. */
export type TierMKind = "suppression" | "removed-assertion";

export interface TierMHit {
	readonly kind: TierMKind;
	readonly file: string;
	readonly line: number;
	readonly token: string;
}

/** Class 5's in-diff suppressions. The four tokens the contract enumerates, and no more. */
const SUPPRESSIONS = ["biome-ignore", "@ts-expect-error", "test.skip", ".only"];

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** What counts as an assertion for class 6. Both spellings the repo's two runners use. */
const ASSERTION = /\b(?:expect|assert)\s*\(/;

/**
 * The Tier-M scan: the §DEV classes a gate can see in the diff itself.
 *
 * These are facts, never the verdict. Whether a disclosed entry's substance covers a hit is Tier R —
 * the judgment layer's — and this scan only makes a `None.` beside a non-empty list visible in one
 * read.
 */
export const tierMHits = (diff: string): ReadonlyArray<TierMHit> => {
	const hits: TierMHit[] = [];
	for (const {file, line, kind, text} of changedLines(diff)) {
		if (kind === "added") {
			for (const token of SUPPRESSIONS) {
				if (text.includes(token)) hits.push({kind: "suppression", file, line, token});
			}
			continue;
		}
		if (TEST_FILE.test(file) && ASSERTION.test(text)) {
			hits.push({kind: "removed-assertion", file, line, token: text.trim()});
		}
	}
	return hits;
};
