/**
 * The workspace grammar, the two records that live in it, and the two digests taken over them —
 * pure, so two implementers compute one number and a test can assert every violation without a disk.
 *
 * The path is keyed on the **nonce alone**: no session segment, no issue segment, no pid. Two
 * concurrent spikes carry different minted nonces and therefore different directories, which is the
 * whole of the collision answer (#4544, #4516, #3607, #5028).
 *
 * **Both digests are defined byte-exactly here** because they are compared across runs and across
 * processes: `treeDigest` decides whether a throwaway stayed thrown away, and `evidenceDigest`
 * decides whether a captured decision still covers the log. A digest whose input is "however this
 * implementation happened to serialize it" cannot answer either question twice the same way.
 */

import {createHash} from "node:crypto";
import {join, sep} from "node:path";

/** The one directory segment under the OS temp root that every workspace sits beneath. */
export const WORKSPACE_ROOT = "fabrika-spike";

/** The capture bound per stream, in bytes. Past it capture stops and the record says `truncated`. */
export const CAPTURE_BYTES = 1024 * 1024;

/** The nonce grammar: eight lowercase hex, minted by `spike open` and an argument everywhere else. */
export const NONCE_RE = /^[0-9a-f]{8}$/;

export const isNonce = (value: string): boolean => NONCE_RE.test(value);

/** The two ruled artifact shapes (#5017). */
export const KINDS = ["logic", "ui"] as const;
export type Kind = (typeof KINDS)[number];

export const isKind = (value: string): value is Kind =>
	(KINDS as ReadonlyArray<string>).includes(value);

/** `<tmpRoot>/fabrika-spike/<nonce>`. Both callers pass a **physically resolved** temp root. */
export const workspacePath = (tmpRoot: string, nonce: string): string =>
	join(tmpRoot, WORKSPACE_ROOT, nonce);

export const manifestPath = (workspace: string): string => join(workspace, "spike.json");
export const evidencePath = (workspace: string): string => join(workspace, "evidence.jsonl");
export const captureOutPath = (workspace: string, seq: number): string =>
	join(workspace, "runs", `${seq}.out`);
export const captureErrPath = (workspace: string, seq: number): string =>
	join(workspace, "runs", `${seq}.err`);

/**
 * Whether the workspace resolves inside the repository working tree.
 *
 * Both arguments must already be **physically** resolved — symlinks followed, `.` and `..` folded.
 * On macOS `/tmp` is a symlink to `/private/tmp`, so a lexical test gives a different answer than a
 * resolved one, and a repository checked out under the temp root would pass a lexical test while
 * sitting inside the very tree the digest measures.
 */
export const isInsideTree = (workspace: string, treeRoot: string): boolean =>
	workspace === treeRoot || workspace.startsWith(`${treeRoot}${sep}`);

/** The workspace manifest: written by `spike open`, never rewritten once it is completed. */
export interface Manifest {
	readonly spike: number | null;
	readonly nonce: string;
	readonly kind: Kind;
	readonly question: string;
	readonly repo: string;
	readonly ticket: number | null;
	readonly treeDigest: string;
	readonly treeRoot: string;
}

/** The manifest's keys, in the order it is written. Extra or missing keys are both violations. */
export const MANIFEST_KEYS: ReadonlyArray<keyof Manifest> = [
	"spike",
	"nonce",
	"kind",
	"question",
	"repo",
	"ticket",
	"treeDigest",
	"treeRoot",
];

export type Parsed<A> =
	| {readonly _tag: "Parsed"; readonly value: A}
	| {readonly _tag: "Malformed"; readonly reason: string};

const malformed = <A>(reason: string): Parsed<A> => ({_tag: "Malformed", reason});
const parsed = <A>(value: A): Parsed<A> => ({_tag: "Parsed", value});

const DIGEST_RE = /^[0-9a-f]{64}$/;

const asRecord = (text: string): Record<string, unknown> | null => {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
};

/** The manifest, or the **first** violation — the whole file is refused either way. */
export const parseManifest = (text: string): Parsed<Manifest> => {
	const record = asRecord(text);
	if (record === null) return malformed("it is not a JSON object");
	for (const key of MANIFEST_KEYS) {
		if (!Object.hasOwn(record, key)) return malformed(`the key "${key}" is missing`);
	}
	const extra = Object.keys(record).find(
		(key) => !(MANIFEST_KEYS as ReadonlyArray<string>).includes(key),
	);
	if (extra !== undefined) return malformed(`it carries an unexpected key "${extra}"`);
	const {spike, nonce, kind, question, repo, ticket, treeDigest, treeRoot} = record;
	if (spike !== null && !Number.isInteger(spike))
		return malformed('"spike" is not an integer or null');
	if (typeof nonce !== "string" || !isNonce(nonce)) {
		return malformed('"nonce" is not eight lowercase hex characters');
	}
	if (typeof kind !== "string" || !isKind(kind)) return malformed('"kind" is not logic or ui');
	if (typeof question !== "string") return malformed('"question" is not a string');
	if (typeof repo !== "string") return malformed('"repo" is not a string');
	if (ticket !== null && !Number.isInteger(ticket)) {
		return malformed('"ticket" is not an integer or null');
	}
	if (typeof treeDigest !== "string" || !DIGEST_RE.test(treeDigest)) {
		return malformed('"treeDigest" is not 64 lowercase hex characters');
	}
	if (typeof treeRoot !== "string") return malformed('"treeRoot" is not a string');
	return parsed({
		spike: spike as number | null,
		nonce,
		kind,
		question,
		repo,
		ticket: ticket as number | null,
		treeDigest,
		treeRoot,
	});
};

/** The manifest as it is written: the keys in {@link MANIFEST_KEYS} order, one trailing newline. */
export const renderManifest = (manifest: Manifest): string => {
	const ordered: Record<string, unknown> = {};
	for (const key of MANIFEST_KEYS) ordered[key] = manifest[key];
	return `${JSON.stringify(ordered)}\n`;
};

/** One appended run record. The serialization is pinned: `evidenceDigest` is taken over these bytes. */
export interface EvidenceRecord {
	readonly seq: number;
	readonly command: ReadonlyArray<string>;
	readonly commandExit: number | null;
	readonly timedOut: boolean;
	readonly outBytes: number;
	readonly errBytes: number;
	readonly truncated: boolean;
	readonly outSha256: string;
	readonly errSha256: string;
}

/** The record's keys, in exactly the order every line is serialized in. */
export const EVIDENCE_KEYS: ReadonlyArray<keyof EvidenceRecord> = [
	"seq",
	"command",
	"commandExit",
	"timedOut",
	"outBytes",
	"errBytes",
	"truncated",
	"outSha256",
	"errSha256",
];

/** One line: the keys in order, no whitespace between tokens, a single `\n`. */
export const renderEvidenceLine = (record: EvidenceRecord): string => {
	const ordered: Record<string, unknown> = {};
	for (const key of EVIDENCE_KEYS) ordered[key] = record[key];
	return `${JSON.stringify(ordered)}\n`;
};

const parseEvidenceRecord = (value: Record<string, unknown>): Parsed<EvidenceRecord> => {
	for (const key of EVIDENCE_KEYS) {
		if (!Object.hasOwn(value, key)) return malformed(`the key "${key}" is missing`);
	}
	const {seq, command, commandExit, timedOut, outBytes, errBytes, truncated, outSha256, errSha256} =
		value;
	if (!Number.isInteger(seq) || (seq as number) < 1)
		return malformed('"seq" is not a positive integer');
	if (!Array.isArray(command) || command.some((part) => typeof part !== "string")) {
		return malformed('"command" is not an array of strings');
	}
	if (commandExit !== null && !Number.isInteger(commandExit)) {
		return malformed('"commandExit" is not an integer or null');
	}
	if (typeof timedOut !== "boolean") return malformed('"timedOut" is not a boolean');
	if (!Number.isInteger(outBytes) || !Number.isInteger(errBytes)) {
		return malformed('"outBytes" or "errBytes" is not an integer');
	}
	if (typeof truncated !== "boolean") return malformed('"truncated" is not a boolean');
	if (typeof outSha256 !== "string" || !DIGEST_RE.test(outSha256)) {
		return malformed('"outSha256" is not 64 lowercase hex characters');
	}
	if (typeof errSha256 !== "string" || !DIGEST_RE.test(errSha256)) {
		return malformed('"errSha256" is not 64 lowercase hex characters');
	}
	return parsed({
		seq: seq as number,
		command: command as ReadonlyArray<string>,
		commandExit: commandExit as number | null,
		timedOut,
		outBytes: outBytes as number,
		errBytes: errBytes as number,
		truncated,
		outSha256,
		errSha256,
	});
};

/**
 * The whole log, or the first violation.
 *
 * A file that is **absent** never reaches here: an absent log is `seq` 1 and a **fact**, while a log
 * that exists and cannot be read is a refusal. The two are decided by the caller's probe, not by an
 * empty string arriving here.
 */
export const parseEvidence = (text: string): Parsed<ReadonlyArray<EvidenceRecord>> => {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const records: EvidenceRecord[] = [];
	for (const [index, line] of lines.entries()) {
		const record = asRecord(line);
		if (record === null) return malformed(`line ${index + 1} does not parse`);
		const one = parseEvidenceRecord(record);
		if (one._tag === "Malformed") return malformed(`line ${index + 1}: ${one.reason}`);
		if (one.value.seq !== index + 1) {
			return malformed(
				`line ${index + 1} carries seq ${one.value.seq} — the log is not contiguous from 1`,
			);
		}
		records.push(one.value);
	}
	return parsed(records);
};

/** SHA-256 of `bytes`, as 64 lowercase hex. */
export const sha256Of = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** SHA-256 of `text`'s UTF-8 bytes, as 64 lowercase hex. */
export const sha256OfText = (text: string): string => sha256Of(new TextEncoder().encode(text));

/** What zero bytes digest to — a clean tree's `treeDigest`, and an empty stream's. */
export const EMPTY_SHA256 = sha256OfText("");

/**
 * `treeDigest` over `git status --porcelain=v1 --untracked-files=all --ignored=matching`'s output.
 *
 * Split on `\n`, drop the trailing empty element, sort byte-wise ascending, join with a `\n` after
 * **each** line, and digest that text's UTF-8 bytes. An empty set therefore yields the empty string
 * and digests to {@link EMPTY_SHA256}.
 */
export const treeDigestOf = (statusOutput: string): string => {
	const lines = statusOutput.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const sorted = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return sha256OfText(sorted.map((line) => `${line}\n`).join(""));
};

/** The status lines that differ between two readings of the same tree — what a `17` enumerates. */
export const differingStatusLines = (statusOutput: string): ReadonlyArray<string> => {
	const lines = statusOutput.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/** `evidenceDigest` — the SHA-256 of `evidence.jsonl`'s bytes exactly as they sit on disk. */
export const evidenceDigestOf = (logText: string): string => sha256OfText(logText);
