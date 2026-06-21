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

	it.each([
		["a bare NotFound (a genuinely missing resource)", {_tag: "NotFound", message: "gone"}],
		["an auth failure", {_tag: "Unauthorized", message: "bad token"}],
		["a config error", {_tag: "ConfigError", message: "missing binding"}],
		["a tagless object", {message: "no tag here"}],
		["a non-object", "BadRequest"],
		["null", null],
	])("fails fast on %s", (_label, err) => {
		expect(isTransientDeployError(err)).toBe(false);
	});
});
