/**
 * The capture set: where its bytes live, what its manifest says, and how a later verb re-reads it.
 *
 * `review-ui render` writes the manifest and `review-ui post` reads it, so the two never trade a
 * carried variable — a set is whatever its `manifest.json` says it is, and a set without a readable
 * manifest is not a set. The manifest bytes are byte-identical to `render`'s stdout object for the
 * same reason: one document, two channels, so nothing can be true on one and not the other.
 *
 * The set path is **deterministic from the PR and the head**, never a `mktemp -d` nobody recorded
 * (v1 S4: a PASS whose evidence upload failed was unauditable). The `--out` set name is the run's
 * own key inside that directory — two concurrent reviews of one head name different sets and never
 * write each other's bytes (the run-keyed rule #5111 states; a session is not a run).
 */
import {createHash} from "node:crypto";
import {Effect, FileSystem} from "effect";
import type {PageError} from "../capture/page-errors.ts";
import type {CapAndCount} from "../evidence.ts";
import {isRecord, parseJson} from "../io/json.ts";

/**
 * How many page errors a capture carries in full before the rest become a count (ADR 0308).
 *
 * Raw console text carries no reason vocabulary to histogram, so the collapse is a cap-and-count.
 * Three is enough to recognize what a page is complaining about without paying for a dev-mode
 * console's whole tail — and a crash never reaches here at all, because an uncaught `pageerror`
 * routes to the `Crashed` arm before an entry is built.
 */
export const PAGE_ERROR_CAP = 3;

/** One captured surface, as both the stdout object and the manifest record it. */
export interface CaptureEntry {
	readonly surface: string;
	readonly path: string;
	readonly width: number;
	readonly height: number;
	readonly sha256: string;
	/**
	 * Errors thrown into the page during this render — recorded data, never a gate outcome, and so
	 * an evidence-array bounded at {@link PAGE_ERROR_CAP}. The collapsed shape is the only one the
	 * type admits, which is what keeps the stdout object and the manifest file from disagreeing:
	 * they are one serialization, and there is no uncollapsed entry for either to hold.
	 */
	readonly pageErrors: CapAndCount<PageError>;
	/** CI captures prove both browser error channels were readable before the manifest was written. */
	readonly errorCoverage?: {
		readonly pageerror: "readable";
		readonly consoleError: "readable";
	};
}

export interface CaptureManifest {
	readonly set: string;
	readonly pr: number;
	/** The live head the preview was bound to — what `post` refuses to post stale pixels against. */
	readonly head: string;
	readonly previewUrl: string;
	readonly captures: readonly CaptureEntry[];
}

/** A kebab-case set name: the grammar `--out` is held to, so a set name is a safe path segment. */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isKebabSetName = (value: string): boolean => KEBAB.test(value);

/** `<tmp>/fabrika-review-ui/<pr>-<head8>/<set>/` — derived, so the same run re-resolves it. */
export const setDirectory = (tmpRoot: string, pr: number, head: string, set: string): string =>
	`${tmpRoot}/fabrika-review-ui/${pr}-${head.slice(0, 8)}/${set}`;

export const manifestPath = (setDir: string): string => `${setDir}/manifest.json`;

export const sha256Hex = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** The one serialization — `render` prints these bytes and writes these bytes. */
export const serializeManifest = (manifest: CaptureManifest): string => JSON.stringify(manifest);

const isCollapsedPageErrors = (value: unknown): value is CapAndCount<PageError> =>
	isRecord(value) &&
	typeof value.more === "number" &&
	Array.isArray(value.rows) &&
	value.rows.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as PageError).kind === "string" &&
			typeof (entry as PageError).text === "string",
	);

const toEntry = (value: unknown): CaptureEntry | null => {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.surface !== "string" ||
		typeof record.path !== "string" ||
		typeof record.width !== "number" ||
		typeof record.height !== "number" ||
		typeof record.sha256 !== "string" ||
		!isCollapsedPageErrors(record.pageErrors)
	) {
		return null;
	}
	return {
		surface: record.surface,
		path: record.path,
		width: record.width,
		height: record.height,
		sha256: record.sha256,
		pageErrors: record.pageErrors,
	};
};

export type ManifestRead =
	| {readonly _tag: "Manifest"; readonly value: CaptureManifest}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * Parse a manifest, whole. Every rejection is a refusal rather than a default: a set whose captures
 * list half-parsed would post a verdict over evidence it never saw.
 */
export const parseManifest = (text: string): ManifestRead => {
	const parsed = parseJson(text);
	if (!isRecord(parsed)) {
		return {_tag: "Malformed", reason: "not a JSON object"};
	}
	const record = parsed;
	if (
		typeof record.set !== "string" ||
		typeof record.pr !== "number" ||
		typeof record.head !== "string" ||
		typeof record.previewUrl !== "string" ||
		!Array.isArray(record.captures)
	) {
		return {
			_tag: "Malformed",
			reason: "the manifest names no set, pr, head, previewUrl and captures",
		};
	}
	const captures: CaptureEntry[] = [];
	for (const [index, raw] of record.captures.entries()) {
		const entry = toEntry(raw);
		if (entry === null) {
			return {_tag: "Malformed", reason: `capture ${index} is not a capture record`};
		}
		captures.push(entry);
	}
	if (captures.length === 0) {
		return {
			_tag: "Malformed",
			reason: "the manifest records zero captures — a set with no member is not a set",
		};
	}
	return {
		_tag: "Manifest",
		value: {
			set: record.set,
			pr: record.pr,
			head: record.head,
			previewUrl: record.previewUrl,
			captures,
		},
	};
};

export type BytesRead =
	| {readonly _tag: "Bytes"; readonly value: Uint8Array}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * A capture's bytes off disk. Unreadable is its own answer, never an empty buffer — an empty buffer
 * would validate as "zero bytes" and report an invalid capture where the truth is an unread one.
 */
export const readCaptureBytes = (
	path: string,
): Effect.Effect<BytesRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const bytes = yield* fs.readFile(path);
		return {_tag: "Bytes" as const, value: bytes};
	}).pipe(
		Effect.catchTag("PlatformError", (cause) =>
			Effect.succeed<BytesRead>({_tag: "Unreadable", reason: cause.message}),
		),
	);
