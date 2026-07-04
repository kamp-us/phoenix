/**
 * depo client's tagged errors — one file for the whole put path (the
 * `.patterns/effect-errors.md` one-`errors.ts`-per-surface rule). Each is a plain
 * `Data.TaggedError`. The set is the client-side image of the doorman's HTTP
 * contract (#1970): every 4xx the doorman can return maps to exactly one error
 * here, so a caller `catch`es a typed failure rather than parsing a status code.
 *
 *   doorman 401 → Unauthorized          doorman 415 → UnsupportedMediaType
 *   doorman 413 → PayloadTooLarge        doorman 409 → ContentAddressConflict
 *
 * Plus two client-local faults with no server counterpart: `MissingCredential`
 * (no apiKey resolved before any request), `FileReadError` (the local file could
 * not be read), and `UploadFailed` (transport failure or an unmapped status).
 */
import * as Data from "effect/Data";

/** No apiKey could be resolved (flag / `KAMPUS_TOKEN` / stored credential all empty). */
export class MissingCredential extends Data.TaggedError("depo/MissingCredential")<{
	readonly reason: string;
}> {}

/** The local file could not be read (missing / unreadable). */
export class FileReadError extends Data.TaggedError("depo/FileReadError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** File extension outside the PNG/JPEG/WebP allowlist — refused before upload (mirrors 415). */
export class UnsupportedFile extends Data.TaggedError("depo/UnsupportedFile")<{
	readonly filename: string;
	readonly ext: string;
}> {}

/** Doorman 401 — the presented apiKey was missing or invalid. Nothing was stored. */
export class Unauthorized extends Data.TaggedError("depo/Unauthorized")<{
	readonly message: string;
}> {}

/** Doorman 415 — the content-type was outside the allowlist. */
export class UnsupportedMediaType extends Data.TaggedError("depo/UnsupportedMediaType")<{
	readonly message: string;
}> {}

/** Doorman 413 — the body exceeded the size cap. */
export class PayloadTooLarge extends Data.TaggedError("depo/PayloadTooLarge")<{
	readonly message: string;
}> {}

/**
 * Doorman 409 — a second upload to an existing content-address key whose stored
 * bytes differ (a sha256 collision the doorman refuses rather than overwrites).
 */
export class ContentAddressConflict extends Data.TaggedError("depo/ContentAddressConflict")<{
	readonly message: string;
}> {}

/** Transport failure, a 5xx, or any status the client does not map — the catch-all. */
export class UploadFailed extends Data.TaggedError("depo/UploadFailed")<{
	readonly status: number | null;
	readonly message: string;
}> {}
