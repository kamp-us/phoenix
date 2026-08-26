/**
 * The npm registry read — the one leg of adoption that leaves both the machine and GitHub.
 *
 * The disciplines `./gh-api.ts` states hold here too, restated because this module is where a
 * reader lands: **the status is read before the bytes are interpreted** — a 404 body is not a
 * manifest — and **every failure is data**, because a registry that cannot be reached has to refuse
 * the pin rather than answer with a stale guess (#7007).
 */
import {Cause, Duration, Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {onTransport} from "./gh-api.ts";
import {type Attempt, fail, ok} from "./git.ts";
import {isRecord, parseJson} from "./json.ts";

const REGISTRY_ROOT = "https://registry.npmjs.org";

/** The default client-side bound on one npm registry exchange, in seconds. */
const DEFAULT_HTTP_TIMEOUT_SECONDS = 60;

/**
 * The client-side bound on one npm registry exchange, same law as `githubHttpTimeoutSeconds`:
 * `HttpClient.execute` has no timeout of its own, so a stalled transport blocks the pin
 * indefinitely. Override for tests and pathological networks with
 * `FABRIKA_NPM_HTTP_TIMEOUT_SECONDS`.
 */
export const npmHttpTimeoutSeconds = (): number => {
	const raw = process.env.FABRIKA_NPM_HTTP_TIMEOUT_SECONDS;
	const parsed = raw === undefined ? DEFAULT_HTTP_TIMEOUT_SECONDS : Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_SECONDS;
};

/**
 * The current published release of one package — the version its registry `latest` dist-tag names.
 *
 * The transport requirement is erased here the way every adapter in this package erases it, so verb
 * annotations carry no HTTP seat (ADR 0315); a test that provides a scripted client still exercises
 * the seam production runs on.
 */
export const latestPublishedVersion = (packageName: string): Effect.Effect<Attempt<string>> =>
	onTransport(
		Effect.gen(function* () {
			const request = HttpClientRequest.make("GET")(
				`${REGISTRY_ROOT}/${encodeURIComponent(packageName)}/latest`,
			);
			// Read once per exchange: the bound that is applied and the bound a refusal reports must
			// be the same number even if the env moves between the two reads (#7048's standard).
			const boundSeconds = npmHttpTimeoutSeconds();
			const startedAtMs = Date.now();
			const outcome = yield* Effect.catch(
				HttpClient.execute(request).pipe(
					Effect.flatMap((response) =>
						Effect.map(response.text, (text) => ({
							_tag: "Response" as const,
							status: response.status,
							text,
						})),
					),
					// The bound covers the WHOLE exchange — connect through final body byte. Below
					// flatMap(read) it would spare a stalled body stream, which dies exactly as hard
					// as a black-holed connect (#7025 criterion 4).
					Effect.timeout(Duration.seconds(boundSeconds)),
				),
				(error: unknown) =>
					Effect.succeed({
						_tag: "Unreachable" as const,
						reason: Cause.isTimeoutError(error)
							? `${request.method} ${request.url} exceeded its ${boundSeconds}s client-side bound after ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`
							: `the npm registry could not be reached: ${String(error)}`,
					}),
			);
			if (outcome._tag === "Unreachable") {
				return fail(outcome.reason);
			}
			if (outcome.status !== 200) {
				return fail(`the npm registry answered ${outcome.status} for ${packageName}`);
			}
			const body = parseJson(outcome.text);
			if (!isRecord(body) || typeof body.version !== "string") {
				return fail(
					`the npm registry answered 200 for ${packageName} but its body names no version`,
				);
			}
			return ok(body.version);
		}),
	);
