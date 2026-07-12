/**
 * The depo client core — content-address a body, present the apiKey, call the
 * doorman, and return the public URL. This is the whole write path (ADR 0144
 * decision 5), and it is the surface server-side products `import` directly (no
 * CLI). The network is behind the `DoormanClient` seam so the core unit-tests end
 * to end with the seam substituted and no live worker (`.patterns/effect-testing.md`
 * unit tier).
 *
 * `putBytes` is the seam-testable core (bytes in); `put(path)` is the fs-reading
 * wrapper the bin calls. The mapping from the doorman's HTTP status to a typed
 * failure is the acceptance contract (#1970):
 *   201/200 → success (created / benign idempotent re-PUT), URL returned
 *   401 → Unauthorized   415 → UnsupportedMediaType
 *   413 → PayloadTooLarge   409 → ContentAddressConflict   else → UploadFailed
 */
import {readFile} from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
	type AllowedContentType,
	contentAddressKey,
	contentTypeForFile,
	publicUrl,
} from "./domain.ts";
import {
	ContentAddressConflict,
	type DigestError,
	FileReadError,
	PayloadTooLarge,
	Unauthorized,
	UnsupportedMediaType,
	UploadFailed,
} from "./errors.ts";

/** The one PUT the doorman exposes and its outcome — the seam the core is tested against. */
export interface DoormanRequest {
	readonly apiKey: string;
	readonly contentType: AllowedContentType;
	readonly body: Uint8Array;
}

export interface DoormanResponse {
	readonly status: number;
	/** The response body text — a JSON `{key,url}` on 2xx, a plain reason on 4xx. */
	readonly body: string;
}

/**
 * The doorman HTTP seam. Its `send` performs the single `PUT` to the doorman host
 * and hands back the raw status + body; all status→error mapping lives in the core
 * (`putBytes`), never in the seam, so the seam is a dumb transport a test can
 * replace with a canned response. `DoormanClientLive` (`live.ts`) implements it
 * over `HttpClient`; the bin provides that layer, a test provides a stub.
 */
export interface DoormanClientService {
	readonly send: (req: DoormanRequest) => Effect.Effect<DoormanResponse, UploadFailed>;
}

export class DoormanClient extends Context.Service<DoormanClient, DoormanClientService>()(
	"depo/DoormanClient",
) {}

/** The doorman's `{key,url}` success body. */
interface DoormanSuccessBody {
	readonly key: string;
	readonly url: string;
}

const parseSuccess = (body: string): DoormanSuccessBody | null => {
	// biome-ignore lint/plugin: a malformed doorman body is a benign null ("not a success body" → fall back to the client-derived URL), not a failure to lift into E — wrapping this JSON.parse guard in Effect.try only to re-collapse the error to null is noise.
	try {
		const parsed = JSON.parse(body) as Partial<DoormanSuccessBody>;
		if (typeof parsed.key === "string" && typeof parsed.url === "string") {
			return {key: parsed.key, url: parsed.url};
		}
		return null;
	} catch {
		return null;
	}
};

/**
 * Upload already-read bytes: content-address, call the doorman, map the status.
 * The `contentType` must already be an allowlisted type (the caller resolved it
 * from the filename via `contentTypeForFile`), so a 415 here means the server's
 * allowlist and the client's disagree — still mapped to `UnsupportedMediaType`.
 *
 * On 2xx the returned URL is the doorman's own `{url}` when present, else the
 * client re-derives `https://depo.kamp.us/<key>` from the content address — the
 * two are equal by construction (the key IS `<sha256>.<ext>`), so a caller can
 * rely on the URL with no live worker in a test.
 */
export const putBytes = (input: {
	readonly apiKey: string;
	readonly contentType: AllowedContentType;
	readonly body: Uint8Array;
}): Effect.Effect<
	string,
	| DigestError
	| Unauthorized
	| UnsupportedMediaType
	| PayloadTooLarge
	| ContentAddressConflict
	| UploadFailed,
	DoormanClient
> =>
	Effect.gen(function* () {
		const key = yield* contentAddressKey(input.body, input.contentType);
		const client = yield* DoormanClient;
		const res = yield* client.send({
			apiKey: input.apiKey,
			contentType: input.contentType,
			body: input.body,
		});

		if (res.status === 200 || res.status === 201) {
			const parsed = parseSuccess(res.body);
			return parsed?.url ?? publicUrl(key);
		}
		if (res.status === 401) {
			return yield* new Unauthorized({message: res.body || "unauthorized"});
		}
		if (res.status === 415) {
			return yield* new UnsupportedMediaType({message: res.body || "unsupported media type"});
		}
		if (res.status === 413) {
			return yield* new PayloadTooLarge({message: res.body || "payload too large"});
		}
		if (res.status === 409) {
			return yield* new ContentAddressConflict({message: res.body || "content-address conflict"});
		}
		return yield* new UploadFailed({
			status: res.status,
			message: res.body || `unexpected status ${res.status}`,
		});
	});

/**
 * Upload a file by path: resolve its content-type from the extension (refusing a
 * non-image before any network call), read the bytes, then `putBytes`. This is the
 * bin's entry point and the server-side `import` surface — it returns the permanent
 * `https://depo.kamp.us/<sha256>.<ext>` URL.
 */
export const put = (input: {readonly path: string; readonly apiKey: string}) =>
	Effect.gen(function* () {
		const filename = input.path.split("/").pop() ?? input.path;
		const contentType = yield* contentTypeForFile(filename);
		const body = yield* Effect.tryPromise({
			try: () => readFile(input.path),
			catch: (cause) => new FileReadError({path: input.path, cause}),
		}).pipe(Effect.map((buf) => new Uint8Array(buf)));
		return yield* putBytes({apiKey: input.apiKey, contentType, body});
	});
