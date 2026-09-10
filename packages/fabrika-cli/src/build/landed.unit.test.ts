import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {GATEWAY, GH_TOKEN_ENV, served} from "./fixtures.test-support.ts";
import {landedRefs, readAssembly} from "./landed.ts";

describe("landedRefs", () => {
	it("reads every issue a message claims to land, subject and body alike", () => {
		expect([
			...landedRefs(["feat(guide): the front door (#6004)\n\nPart of #5817", "chore: nothing"]),
		]).toEqual([6004, 5817]);
	});

	// The merge `lane integrate` makes is the only commit the assembly seat itself authors, and
	// `build commit`'s foreign-ref refusal never reads it — so it is the live entry path for a
	// false landing.
	it("reads the child out of integrate's merge commit", () => {
		expect([
			...landedRefs(["Merge branch 'build/6008-focus-steal-c4367b0b' into epic/4300"]),
		]).toEqual([6008]);
	});

	it("is empty for a branch that carries no commit", () => {
		expect(landedRefs([]).size).toBe(0);
	});

	// `issueRefsIn` read both of these as landings, so the discharge subtracted an edge whose blocker
	// was never built and the next child built against missing code.
	it("does not read a landing from an incidental mention", () => {
		expect(landedRefs(["refactor(tracer): rework the helper; does not touch #6008"]).size).toBe(0);
	});

	it("does not read a landing from a negating mention", () => {
		expect(landedRefs(["chore: revert the commit that would have closed #6008"]).size).toBe(0);
	});

	// Recognition failure never admits: an unknown shape leaves the edge as the board reads it.
	it("does not read a landing from a shape the rule does not recognise", () => {
		expect(landedRefs(["wip: halfway through #6008"]).size).toBe(0);
	});

	it("does not read a bare number as a reference", () => {
		expect(landedRefs(["fix: closes issue 210"]).size).toBe(0);
	});
});

const TIP = "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567";
const BASE = "0123456789abcdef0123456789abcdef01234567";

const TRUNK = /^GET https:\/\/api\.github\.com\/repos\/o\/r$/;

const script: ReadonlyArray<Scripted> = [
	[/^git rev-parse --verify --quiet epic\/4300\^\{commit\}$/, okOut(`${TIP}\n`)],
	[TRUNK, served({default_branch: "main"})],
	[/^git merge-base origin\/main /, okOut(`${BASE}\n`)],
	[/^git log /, okOut(`${TIP}\x1ffeat: landed (#210)\x1e`)],
];

describe("readAssembly", () => {
	/**
	 * The bound is the finding this module was repaired for: a one-dot walk sweeps in the whole trunk
	 * history the assembly branch was cut from, where a commit that predates the epic and closes its
	 * own number would discharge an edge this run never built.
	 */
	it("walks only what the branch adds over its merge base with the trunk", async () => {
		const seams = fakeSeams(script);
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read).toMatchObject({_tag: "Read", branch: "epic/4300", baseRef: "origin/main"});
		expect(seams.calls.some((line) => line.endsWith(`${BASE}..${TIP}`))).toBe(true);
		expect(read._tag === "Read" ? [...read.landed] : []).toEqual([210]);
	});

	/**
	 * The range bound and the landing rule are independent halves of one invariant, so a commit the
	 * run itself put on the branch still discharges nothing unless it says it landed the work.
	 */
	it("carries no landing off an in-range commit that only mentions a number", async () => {
		const seams = fakeSeams([
			...script.slice(0, 3),
			[
				/^git log /,
				okOut(`${TIP}\x1frefactor(tracer): rework the helper; does not touch #210\x1e`),
			],
		] as ReadonlyArray<Scripted>);
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read).toMatchObject({_tag: "Read", commits: 1});
		expect(read._tag === "Read" ? read.landed.size : -1).toBe(0);
	});

	/**
	 * The common ancestor lies beyond the graft boundary, so `git merge-base` names none. The read
	 * stays Unreadable — the point is that its reason carries the remedy.
	 */
	const beyondBoundary = (shallow: ExecResult): ReadonlyArray<Scripted> => [
		script[0] as Scripted,
		[TRUNK, served({default_branch: "main"})],
		[/^git merge-base origin\/main /, errOut("git merge-base exited 1")],
		[/^git rev-parse --is-shallow-repository$/, shallow],
	];

	it("names the shallow clone and `git fetch --unshallow origin` when no merge base is reachable", async () => {
		const seams = fakeSeams(beyondBoundary(okOut("true\n")));
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read).toMatchObject({_tag: "Unreadable", branch: "epic/4300"});
		const reason = read._tag === "Unreadable" ? read.reason : "";
		expect(reason).toContain("this clone is shallow");
		expect(reason).toContain("git fetch --unshallow origin");
		// The probe proves shallowness, not causation — git's own words stay, or a non-boundary
		// failure loses the one piece of evidence that corrects the hypothesis.
		expect(reason).toContain("git merge-base exited 1");
		expect(seams.calls.some((line) => line.startsWith("git log"))).toBe(false);
	});

	it("keeps git's own reason when the clone is not shallow", async () => {
		const seams = fakeSeams(beyondBoundary(okOut("false\n")));
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read).toMatchObject({
			_tag: "Unreadable",
			reason: "no merge base with origin/main: git merge-base exited 1",
		});
	});

	// A probe that cannot answer names an unreadable read no more precisely — and never less.
	it("keeps git's own reason when the shallow probe itself fails", async () => {
		const seams = fakeSeams(beyondBoundary(errOut("rev-parse blew up")));
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read).toMatchObject({
			_tag: "Unreadable",
			reason: "no merge base with origin/main: git merge-base exited 1",
		});
	});

	it("is Unreadable when the trunk cannot be named — never a partial discharge", async () => {
		const seams = fakeSeams([script[0] as Scripted, [TRUNK, GATEWAY]]);
		const read = await Effect.runPromise(
			Effect.provide(readAssembly(GH_TOKEN_ENV, "o/r", 4300), seams.layer),
		);
		expect(read._tag).toBe("Unreadable");
		expect(seams.calls.some((line) => line.startsWith("git log"))).toBe(false);
	});
});
