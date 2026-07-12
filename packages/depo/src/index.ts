/**
 * `@kampus/depo` — the depo client library (ADR 0144 decision 5). Server-side
 * products `import` this to upload an asset and get its permanent
 * `https://depo.kamp.us/<sha256>.<ext>` URL, with no CLI in the path.
 *
 * The core (`put` / `putBytes`) talks to the doorman through the `DoormanClient`
 * seam; provide `DoormanClientLive` (over an `HttpClient`) for the real upload, or
 * a stub in a test. `resolveApiKey` is the shared credential-resolution helper.
 */
export {
	DoormanClient,
	type DoormanRequest,
	type DoormanResponse,
	put,
	putBytes,
} from "./client.ts";
export {
	ALLOWED_TYPES,
	type AllowedContentType,
	type AllowedExt,
	contentAddressKey,
	contentTypeForFile,
	PUBLIC_HOST,
	publicUrl,
	sha256Hex,
} from "./domain.ts";
export {
	ContentAddressConflict,
	DigestError,
	FileReadError,
	MissingCredential,
	PayloadTooLarge,
	Unauthorized,
	UnsupportedFile,
	UnsupportedMediaType,
	UploadFailed,
} from "./errors.ts";
export {DOORMAN_URL, DoormanClientLive, resolveApiKey} from "./live.ts";
