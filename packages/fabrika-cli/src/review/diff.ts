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

const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
		const header = FILE_HEADER.exec(raw);
		if (header !== null) {
			const before = header[1] ?? "";
			const after = header[2] ?? "";
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
