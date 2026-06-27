/**
 * Pins which `/fate/live` warmup responses `isLiveWarmupNotReady` keeps retrying vs treats as
 * terminal. The CF edge-placeholder 404 (HTML, route not propagated) is the #1058 addition: it
 * is a "not ready yet" signal alongside the cold-start 503, distinguished from a legitimate
 * worker JSON 404/auth response so the warmup doesn't retry forever on a real 404.
 */

import {describe, expect, it} from "vitest";
import {isLiveWarmupNotReady} from "./_fate-live-warmup.ts";

describe("isLiveWarmupNotReady", () => {
	it.each([
		["the cold-start 503 LIVE_UNAVAILABLE envelope", 503, "application/json"],
		["a 503 with no declared body type", 503, ""],
		["the CF edge-placeholder 404 (HTML, route not propagated)", 404, "text/html; charset=UTF-8"],
		["a CF placeholder 404 with a bare text/html type", 404, "text/html"],
		["a CF edge 5xx served as an HTML page", 521, "text/html"],
		// #1058: the edge can serve a placeholder 404 with no content-type — treat it as not-ready
		// rather than terminal, since a terminal answer is only a JSON one the worker rendered.
		["a placeholder 404 with no content-type at all", 404, ""],
	])("keeps retrying %s", (_label, status, contentType) => {
		expect(isLiveWarmupNotReady(status, contentType)).toBe(true);
	});

	it.each([
		[
			"a legitimate worker JSON 404 (worker reached — do not retry forever)",
			404,
			"application/json",
		],
		["a worker JSON 401 auth response", 401, "application/json; charset=utf-8"],
		["a worker JSON 403 auth response", 403, "application/json"],
	])("treats %s as terminal", (_label, status, contentType) => {
		expect(isLiveWarmupNotReady(status, contentType)).toBe(false);
	});
});
