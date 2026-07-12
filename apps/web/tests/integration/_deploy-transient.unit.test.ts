/**
 * Pins which CF deploy errors `isTransientDeployError` retries vs fails fast on.
 * The retry only ever self-heals an eventually-consistent deploy hiccup; a genuine
 * deploy error (auth, malformed config) must still fall through to a hard failure.
 * `BadRequest` is the #1153 addition: a deploy-time HTTP-400 on a fresh dedicated
 * stage is a propagation transient (re-run clears), distinct from the dep's default
 * non-retryable classification of a 400.
 */

import {describe, expect, it} from "vitest";
import {isTransientDeployError} from "./_deploy-transient.ts";

describe("isTransientDeployError", () => {
	it.each([
		["WorkerNotFound", {_tag: "WorkerNotFound", message: "worker not found"}],
		["InternalServerError", {_tag: "InternalServerError", message: "unknown error"}],
		["UnknownCloudflareError", {_tag: "UnknownCloudflareError", message: "code 10013"}],
		// #1153: the dedicated-stage deploy-time 400 (re-run clears). The serialized
		// signature from the `search-error-vs-empty` main-red was `{retryAfter: undefined,
		// _tag: 'BadRequest'}` — the core `BadRequest` class has no `retryAfter` field.
		["BadRequest", {_tag: "BadRequest", retryAfter: undefined, message: "Bad Request"}],
		// #2638: the CF D1 control-plane rate-limit (code 971 / HTTP 429 / rate-limit message all
		// decode to `_tag: "TooManyRequests"` per `@distilled.cloud/cloudflare` `src/client/api.ts`).
		// A whole-tag transient — core marks the class retryable/throttling — so a bare tag classifies
		// transient regardless of message; the two shapes below pin the code-971 and HTTP-429 paths.
		[
			"TooManyRequests (code 971 envelope)",
			{_tag: "TooManyRequests", message: "Please wait and consider throttling your request speed"},
		],
		["TooManyRequests (HTTP 429)", {_tag: "TooManyRequests", message: "Too Many Requests"}],
	])("retries the transient deploy tag %s", (_label, err) => {
		expect(isTransientDeployError(err)).toBe(true);
	});

	it("retries a NotFound only when the message is the no-versions propagation race", () => {
		expect(
			isTransientDeployError({
				_tag: "NotFound",
				message: "This Worker has no versions, which means this Worker has no content",
			}),
		).toBe(true);
	});

	// #2156: the preview-deploy secret-probe AuthError (a non-2xx probe result) — the merge-group
	// flake that ejected approved PR #2148. Matched on the message, not the bare `AuthError` _tag,
	// so a genuine auth failure (below) still fails fast.
	it.each([
		[
			"a 400-HTML probe result",
			"Edge-preview secret read failed: Secret probe returned 400: <!DOCTYPE html>",
		],
		["a 502 probe result", "Edge-preview secret read failed: Secret probe returned 502"],
	])("retries the transient preview-deploy secret-probe AuthError (%s)", (_label, message) => {
		expect(isTransientDeployError({_tag: "AuthError", message})).toBe(true);
	});

	it.each([
		["a bare NotFound (a genuinely missing resource)", {_tag: "NotFound", message: "gone"}],
		// A real auth failure carries `AuthError` WITHOUT the secret-probe message — it must fail
		// fast, never be swallowed by the #2156 secret-probe retry.
		[
			"a genuine auth failure (AuthError without the secret-probe message)",
			{_tag: "AuthError", message: "invalid API token"},
		],
		["an auth failure", {_tag: "Unauthorized", message: "bad token"}],
		["a config error", {_tag: "ConfigError", message: "missing binding"}],
		["a tagless object", {message: "no tag here"}],
		["a non-object", "BadRequest"],
		["null", null],
	])("fails fast on %s", (_label, err) => {
		expect(isTransientDeployError(err)).toBe(false);
	});
});
