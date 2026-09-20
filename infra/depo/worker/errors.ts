/**
 * The doorman's tagged errors — one file for the whole write path (the
 * `.patterns/effect-errors.md` one-`errors.ts`-per-surface rule). Each is a
 * `Schema.TaggedError` (the phoenix error idiom the `no-data-taggederror`
 * rule enforces): the doorman is a standalone infra worker with no fate wire codec
 * in scope, so these carry no `FateWireCode` annotation — they map to HTTP status
 * in one place (`worker/index.ts`), not to a wire code.
 *
 * The split mirrors the pattern's domain/infra divide: `Unauthorized`,
 * `UnsupportedMediaType`, `PayloadTooLarge`, and `ContentAddressConflict` are
 * domain refusals (the caller did something the doorman must reject → 4xx);
 * `StorageError`, `DigestFailed`, and `RequestBodyUnreadable` are infra (something
 * failed below the domain → a 500 or an `orDie`'d defect).
 */
import * as Schema from "effect/Schema";

/** No/invalid pasaport `apiKey` → 401. Stores nothing. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("depo/Unauthorized", {
	reason: Schema.String,
}) {}

/** Content-type outside the PNG/JPEG/WebP allowlist → 415. */
export class UnsupportedMediaType extends Schema.TaggedError<UnsupportedMediaType>()(
	"depo/UnsupportedMediaType",
	{contentType: Schema.String},
) {}

/** Body over the size cap → 413. */
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()("depo/PayloadTooLarge", {
	size: Schema.Number,
	cap: Schema.Number,
}) {}

/**
 * A second PUT to an existing content-address key whose stored bytes differ from
 * the presented bytes → 409. Write-once immutability: a key never changes content.
 * (A byte-identical re-PUT is NOT this error — it is a benign idempotent success.)
 */
export class ContentAddressConflict extends Schema.TaggedError<ContentAddressConflict>()(
	"depo/ContentAddressConflict",
	{key: Schema.String},
) {}

/** An R2 head/put failed below the domain → 500. Never leaks detail to the caller. */
export class StorageError extends Schema.TaggedError<StorageError>()("depo/StorageError", {
	op: Schema.Literals(["head", "put"]),
	cause: Schema.Defect(),
}) {}

/** `crypto.subtle.digest` rejected while content-addressing — an `orDie`'d defect. */
export class DigestFailed extends Schema.TaggedError<DigestFailed>()("depo/DigestFailed", {
	cause: Schema.Defect(),
}) {}

/** Reading the request body rejected — an `orDie`'d defect. */
export class RequestBodyUnreadable extends Schema.TaggedError<RequestBodyUnreadable>()(
	"depo/RequestBodyUnreadable",
	{cause: Schema.Defect()},
) {}
