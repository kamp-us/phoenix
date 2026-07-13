/**
 * depo client's tagged errors — one file for the whole put path (the
 * `.patterns/effect-errors.md` one-`errors.ts`-per-surface rule). Each is a
 * `Schema.TaggedErrorClass` (the repo-wide error constructor — #2736). These are
 * CLI-only and never reach the fate wire, so they carry no `FateWireCode`
 * annotation. The set is the client-side image of the doorman's HTTP contract
 * (#1970): every 4xx the doorman can return maps to exactly one error here (each
 * class documents its own status below), so a caller `catch`es a typed failure
 * rather than parsing a status code.
 */
import * as Schema from "effect/Schema";

/** No apiKey could be resolved (flag / `KAMPUS_TOKEN` / stored credential all empty). */
export class MissingCredential extends Schema.TaggedErrorClass<MissingCredential>()(
	"depo/MissingCredential",
	{reason: Schema.String},
) {}

/** The local file could not be read (missing / unreadable). */
export class FileReadError extends Schema.TaggedErrorClass<FileReadError>()("depo/FileReadError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** File extension outside the PNG/JPEG/WebP allowlist — refused before upload (mirrors 415). */
export class UnsupportedFile extends Schema.TaggedErrorClass<UnsupportedFile>()(
	"depo/UnsupportedFile",
	{filename: Schema.String, ext: Schema.String},
) {}

/** Doorman 401 — the presented apiKey was missing or invalid. Nothing was stored. */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()("depo/Unauthorized", {
	message: Schema.String,
}) {}

/** Doorman 415 — the content-type was outside the allowlist. */
export class UnsupportedMediaType extends Schema.TaggedErrorClass<UnsupportedMediaType>()(
	"depo/UnsupportedMediaType",
	{message: Schema.String},
) {}

/** Doorman 413 — the body exceeded the size cap. */
export class PayloadTooLarge extends Schema.TaggedErrorClass<PayloadTooLarge>()(
	"depo/PayloadTooLarge",
	{message: Schema.String},
) {}

/**
 * Doorman 409 — a second upload to an existing content-address key whose stored
 * bytes differ (a sha256 collision the doorman refuses rather than overwrites).
 */
export class ContentAddressConflict extends Schema.TaggedErrorClass<ContentAddressConflict>()(
	"depo/ContentAddressConflict",
	{message: Schema.String},
) {}

/** The SHA-256 content address could not be computed (`crypto.subtle.digest` rejected). */
export class DigestError extends Schema.TaggedErrorClass<DigestError>()("depo/DigestError", {
	cause: Schema.Unknown,
}) {}

/** Transport failure, a 5xx, or any status the client does not map — the catch-all. */
export class UploadFailed extends Schema.TaggedErrorClass<UploadFailed>()("depo/UploadFailed", {
	status: Schema.NullOr(Schema.Number),
	message: Schema.String,
}) {}
