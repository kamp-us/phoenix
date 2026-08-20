import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {branchRules, repository} from "./fixtures.test-support.ts";
import {landingOf, preferredMethod, readLanding} from "./landing.ts";

/** The rules read is HTTP now; the repository read still shells out to `gh`. */
const RULES = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/rules\/branches\/main$/;
const REPO = /^gh api repos\/o\/r$/;

/** The branch's active rules, as the endpoint serves them. */
const rules = (...types: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: branchRules(...types).stdout,
});

const read = (
	http: ReadonlyArray<readonly [RegExp, HttpReply]>,
	shell: ReadonlyArray<readonly [RegExp, ExecResult]> = [],
) =>
	Effect.runPromise(
		Effect.provide(
			readLanding("o/r", "main"),
			Layer.merge(fakeShell(shell).layer, fakeHttp(http).layer),
		),
	);

describe("preferredMethod", () => {
	it("prefers squash — the only subject `landedOnBase` can anchor on", () => {
		expect(preferredMethod({squash: true, merge: true, rebase: true})).toBe("squash");
	});

	it("falls to the merge commit, then the rebase, as each is disabled", () => {
		expect(preferredMethod({squash: false, merge: true, rebase: true})).toBe("merge");
		expect(preferredMethod({squash: false, merge: false, rebase: true})).toBe("rebase");
	});

	it("names none rather than guessing when the repository permits none", () => {
		expect(preferredMethod({squash: false, merge: false, rebase: false})).toBeNull();
	});
});

describe("landingOf", () => {
	it("names the queue path with no method — the queue owns it", () => {
		expect(landingOf(true, {squash: true, merge: true, rebase: true})).toEqual({
			path: "queue",
			method: null,
		});
	});

	it("names `none` when nothing is permitted — a settings fact, never a method to guess", () => {
		expect(landingOf(false, {squash: false, merge: false, rebase: false})).toEqual({
			path: "none",
			method: null,
		});
	});
});

describe("readLanding", () => {
	it("answers `queue` off the branch's rules, without reading the repository at all", async () => {
		const shell = fakeShell([]);
		const out = await Effect.runPromise(
			Effect.provide(
				readLanding("o/r", "main"),
				Layer.merge(shell.layer, fakeHttp([[RULES, rules("merge_queue", "pull_request")]]).layer),
			),
		);
		expect(out).toEqual({_tag: "Ok", value: {path: "queue", method: null}});
		expect(shell.calls.some((line) => line === "gh api repos/o/r")).toBe(false);
	});

	it("answers `direct` with the preferred method when no queue governs the branch", async () => {
		const out = await read([[RULES, rules("pull_request")]], [[REPO, repository()]]);
		expect(out).toEqual({_tag: "Ok", value: {path: "direct", method: "squash"}});
	});

	it("answers `none` when the repository permits no merge method", async () => {
		const out = await read(
			[[RULES, {status: 200, body: "[]"}]],
			[[REPO, repository({squash: false, merge: false, rebase: false})]],
		);
		expect(out).toEqual({_tag: "Ok", value: {path: "none", method: null}});
	});

	it("fails rather than assuming a regime when the rules read fails", async () => {
		const out = await read([[RULES, {status: 503, body: '{"message":"Service unavailable"}'}]]);
		expect(out._tag).toBe("Failure");
	});

	it("fails rather than assuming a method when the repository read fails", async () => {
		const out = await read([[RULES, {status: 200, body: "[]"}]], [[REPO, errOut("HTTP 503")]]);
		expect(out._tag).toBe("Failure");
	});

	it("fails on a rule payload that is not a list — a shape mismatch is never `no queue`", async () => {
		const out = await read([[RULES, {status: 200, body: '{"message":"Not Found"}'}]]);
		expect(out._tag).toBe("Failure");
	});
});
