/**
 * The capture set: where its bytes live, what its manifest says, and how a later verb re-reads it.
 *
 * `review-ui render` writes the manifest and producer receipt, then signs the receipt with a
 * reviewer-owned capability at a deterministic path outside the evidence set. `review-ui post`
 * derives that path from trusted inputs rather than from the receipt, so set-local bytes cannot
 * nominate their own verification key. A set without those readable records is not a set. The
 * manifest bytes are byte-identical to `render`'s
 * stdout object for the same reason: one document, two channels, so nothing can be true on one and
 * not the other.
 *
 * The set path is **deterministic from the PR and the head**, never a `mktemp -d` nobody recorded
 * (v1 S4: a PASS whose evidence upload failed was unauditable). The `--out` set name is the run's
 * own key inside that directory — two concurrent reviews of one head name different sets and never
 * write each other's bytes (the run-keyed rule #5111 states; a session is not a run).
 */
import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {Effect, FileSystem} from "effect";
import type {PageError} from "../capture/page-errors.ts";
import type {CapAndCount} from "../evidence.ts";
import {isRecord, parseJson} from "../io/json.ts";

/**
 * How many page errors a capture carries in full before the rest become a count (ADR 0308).
 *
 * Raw browser-error text carries no reason vocabulary to histogram, so the collapse is a
 * cap-and-count. Preview capture routes an uncaught `pageerror` before building an entry; the CI
 * producer retains page errors ahead of console errors within this bound so its crash signal cannot
 * disappear into the overflow count.
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
	 * Bounded `pageerror` and `console.error` observations from this render. Their consumer assigns
	 * polarity: page errors are crash evidence while console errors remain advisory. The collapsed
	 * shape is the only one the
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

/** Written only by `review-ui render`; an arbitrary route-shaped manifest does not select preview. */
export const PREVIEW_PROVENANCE_RECEIPT = "preview-provenance.json";

export interface PreviewProvenance {
	readonly schemaVersion: 1;
	readonly source: "review-ui-render";
	readonly repository: string;
	readonly pr: number;
	readonly head: string;
	readonly app: string;
	readonly previewUrl: string;
	readonly manifestSha256: string;
	readonly signature: string;
}

export type UnsignedPreviewProvenance = Omit<PreviewProvenance, "signature">;

const previewProvenancePayload = (value: UnsignedPreviewProvenance): string =>
	JSON.stringify(value);

export const newPreviewCapability = (): string => randomBytes(32).toString("hex");

export const mintPreviewProvenance = (
	fields: Omit<UnsignedPreviewProvenance, "schemaVersion" | "source">,
	capability: string,
): PreviewProvenance => {
	const unsigned: UnsignedPreviewProvenance = {
		schemaVersion: 1,
		source: "review-ui-render",
		...fields,
	};
	return {
		...unsigned,
		signature: createHmac("sha256", capability)
			.update(previewProvenancePayload(unsigned))
			.digest("hex"),
	};
};

export const previewProvenanceCapabilityPath = (
	tmpRoot: string,
	repository: string,
	pr: number,
	head: string,
	set: string,
): string =>
	`${tmpRoot}/fabrika-review-ui-capabilities/${sha256Hex(new TextEncoder().encode(repository))}/${pr}-${head}/${set}.key`;

export const verifyPreviewProvenance = (receipt: PreviewProvenance, key: string): boolean => {
	const {signature, ...unsigned} = receipt;
	const expected = createHmac("sha256", key).update(previewProvenancePayload(unsigned)).digest();
	return (
		/^[0-9a-f]{64}$/.test(signature) && timingSafeEqual(expected, Buffer.from(signature, "hex"))
	);
};

export const parsePreviewProvenance = (text: string): PreviewProvenance | null => {
	const value = parseJson(text);
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.source !== "review-ui-render" ||
		typeof value.repository !== "string" ||
		typeof value.pr !== "number" ||
		typeof value.head !== "string" ||
		typeof value.app !== "string" ||
		typeof value.previewUrl !== "string" ||
		typeof value.manifestSha256 !== "string" ||
		typeof value.signature !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.signature)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		source: "review-ui-render",
		repository: value.repository,
		pr: value.pr,
		head: value.head,
		app: value.app,
		previewUrl: value.previewUrl,
		manifestSha256: value.manifestSha256,
		signature: value.signature,
	};
};

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
