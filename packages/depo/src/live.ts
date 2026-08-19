/**
 * The live wiring behind the `DoormanClient` seam — the real `PUT` to the doorman
 * host, and the apiKey resolution the bin depends on (ADR 0045 decision 3). Kept
 * out of `client.ts` so the core stays pure and the network layer is the only
 * thing a unit test substitutes.
 *
 * The doorman's write host is `up.depo.kamp.us` (its read domain, `depo.kamp.us`,
 * is a zero-compute R2 public-read and is never called here — ADR 0144 decisions
 * 3/4). The apiKey is presented as `Authorization: Bearer <key>`; the doorman
 * accepts that or `x-api-key` (#1970 `worker/index.ts`).
 */
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {DoormanClient} from "./client.ts";
import {MissingCredential, UploadFailed} from "./errors.ts";

export const DOORMAN_URL = "https://up.depo.kamp.us/";

/**
 * Only a TRANSPORT fault lowers into `UploadFailed` (status `null`); every HTTP *status*
 * is handed back verbatim for the core to map. `HttpClient` comes from context, so the
 * bin provides `FetchHttpClient.layer` at the run boundary.
 */
export const DoormanClientLive = Layer.effect(DoormanClient)(
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient;
		return DoormanClient.of({
			send: (req) =>
				http
					.execute(
						HttpClientRequest.put(DOORMAN_URL, {
							headers: {
								authorization: `Bearer ${req.apiKey}`,
								"content-type": req.contentType,
							},
							body: HttpBody.uint8Array(req.body, req.contentType),
						}),
					)
					.pipe(
						Effect.flatMap((res) =>
							res.text.pipe(
								Effect.map((body) => ({status: res.status, body})),
								Effect.catch(() => Effect.succeed({status: res.status, body: ""})),
							),
						),
						Effect.catch((cause) =>
							Effect.fail(
								new UploadFailed({
									status: null,
									message: `doorman request failed: ${String(cause)}`,
								}),
							),
						),
					),
		});
	}),
);

const storedCredentialPath = (): string =>
	join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kampus", "token");

/**
 * Resolve the pasaport apiKey in ADR 0045's precedence. A blank result at every rung
 * fails `MissingCredential` — the CLI never sends an empty bearer the doorman would 401.
 */
export const resolveApiKey = (
	explicit?: string | undefined,
): Effect.Effect<string, MissingCredential> =>
	Effect.gen(function* () {
		const fromFlag = explicit?.trim();
		if (fromFlag) return fromFlag;

		const fromEnv = process.env.KAMPUS_TOKEN?.trim();
		if (fromEnv) return fromEnv;

		const fromFile = yield* Effect.tryPromise({
			try: () => readFile(storedCredentialPath(), "utf8"),
			catch: () => null,
		}).pipe(
			Effect.map((text) => text.trim()),
			Effect.orElseSucceed(() => ""),
		);
		if (fromFile) return fromFile;

		return yield* new MissingCredential({
			reason:
				"no apiKey — pass --token, set KAMPUS_TOKEN, or store one at ~/.config/kampus/token (ADR 0045)",
		});
	});
