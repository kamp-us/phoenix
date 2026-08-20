/**
 * The depo client core — content-address a body, present the apiKey, call the doorman,
 * return the public URL. The whole write path (ADR 0144 decision 5), imported directly by
 * server-side products. The network sits behind the `DoormanClient` seam so the core
 * unit-tests end to end with no live worker.
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

export interface DoormanRequest {
	readonly apiKey: string;
	readonly contentType: AllowedContentType;
	readonly body: Uint8Array;
}

export interface DoormanResponse {
	readonly status: number;
	/** A JSON `{key,url}` on 2xx, a plain reason on 4xx. */
	readonly body: string;
}

/**
 * All status→error mapping lives in the core (`putBytes`), never in this seam, so the seam
 * stays a dumb transport a test can replace with a canned response.
 */
export interface DoormanClientService {
	readonly send: (req: DoormanRequest) => Effect.Effect<DoormanResponse, UploadFailed>;
}

export class DoormanClient extends Context.Service<DoormanClient, DoormanClientService>()(
	"depo/DoormanClient",
) {}

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
 * `contentType` is already allowlisted by the caller, so a 415 here means the server's
 * allowlist and the client's disagree. On 2xx the doorman's `{url}` and the client-derived
 * `publicUrl(key)` are equal by construction (the key IS `<sha256>.<ext>`), so a test can
 * rely on the URL with no live worker.
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
