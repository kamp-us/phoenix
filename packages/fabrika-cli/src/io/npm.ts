/**
 * The npm registry read — the one leg of adoption that leaves both the machine and GitHub.
 *
 * The disciplines `./gh-api.ts` states hold here too, restated because this module is where a
 * reader lands: **the status is read before the bytes are interpreted** — a 404 body is not a
 * manifest — and **every failure is data**, because a registry that cannot be reached has to refuse
 * the pin rather than answer with a stale guess (#7007).
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {onTransport} from "./gh-api.ts";
import {type Attempt, fail, ok} from "./git.ts";
import {isRecord, parseJson} from "./json.ts";

const REGISTRY_ROOT = "https://registry.npmjs.org";

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
			const outcome = yield* HttpClient.execute(request).pipe(
				Effect.flatMap((response) =>
					Effect.map(response.text, (text) => ({
						_tag: "Response" as const,
						status: response.status,
						text,
					})),
				),
				Effect.catch((error: unknown) =>
					Effect.succeed({_tag: "Unreachable" as const, reason: String(error)}),
				),
			);
			if (outcome._tag === "Unreachable") {
				return fail(`the npm registry could not be reached: ${outcome.reason}`);
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
