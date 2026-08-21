import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {branchRules, ENV, repositoryServed} from "./fixtures.test-support.ts";
import {landingOf, preferredMethod, readLanding} from "./landing.ts";

const RULES = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/rules\/branches\/main$/;
const REPO = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;

/** A canned `ExecResult` fixture as the body of a 200 — the same payload, off the served seam. */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

const read = (
	script: ReadonlyArray<readonly [RegExp, HttpReply]>,
	spawns: ReadonlyArray<readonly [RegExp, ExecResult]> = [],
	unstartable: ReadonlyArray<RegExp> = [],
) =>
	Effect.runPromise(
		Effect.provide(
			readLanding("o/r", "main", ENV),
			Layer.merge(fakeShell(spawns, undefined, unstartable).layer, fakeHttp(script).layer),
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
		const http = fakeHttp([[RULES, served(branchRules("merge_queue", "pull_request"))]]);
		const out = await Effect.runPromise(
			Effect.provide(readLanding("o/r", "main", ENV), Layer.merge(fakeShell([]).layer, http.layer)),
		);
		expect(out).toEqual({_tag: "Ok", value: {path: "queue", method: null}});
		expect(http.calls.filter((call) => REPO.test(call))).toEqual([]);
	});

	it("answers `direct` with the preferred method when no queue governs the branch", async () => {
		const out = await read([
			[RULES, served(branchRules("pull_request"))],
			[REPO, repositoryServed()],
		]);
		expect(out).toEqual({_tag: "Ok", value: {path: "direct", method: "squash"}});
	});

	it("answers `none` when the repository permits no merge method", async () => {
		const out = await read([
			[RULES, served(okOut("[]"))],
			[REPO, repositoryServed({squash: false, merge: false, rebase: false})],
		]);
		expect(out).toEqual({_tag: "Ok", value: {path: "none", method: null}});
	});

	it("fails rather than assuming a regime when the rules read fails", async () => {
		const out = await read([[RULES, {status: 503, body: '{"message":"unavailable"}'}]]);
		expect(out._tag).toBe("Failure");
	});

	it("fails rather than assuming a method when the repository read fails", async () => {
		const out = await read([
			[RULES, served(okOut("[]"))],
			[REPO, {status: 503, body: '{"message":"unavailable"}'}],
		]);
		expect(out._tag).toBe("Failure");
	});

	it("fails on a rule payload that is not a list — a shape mismatch is never `no queue`", async () => {
		const out = await read([[RULES, served(okOut('{"message":"Not Found"}'))]]);
		expect(out._tag).toBe("Failure");
	});

	it("fails rather than assuming a method when no credential resolves", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				readLanding("o/r", "main", {CLAUDE_PIPELINE_REPO: "o/r"}),
				Layer.merge(
					fakeShell([], undefined, [/^gh auth token$/]).layer,
					fakeHttp([[RULES, served(okOut("[]"))]]).layer,
				),
			),
		);
		expect(out._tag).toBe("Failure");
	});
});
