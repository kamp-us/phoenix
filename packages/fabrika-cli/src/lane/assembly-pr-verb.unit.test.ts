/** `lane assembly-pr` — the board read, the two fields, and the seats each refusal takes. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {issuePayload, NOT_FOUND, served} from "../build/fixtures.test-support.ts";
import {fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {runAssemblyPr} from "./assembly-pr-verb.ts";
import {LANE_UNREADABLE, NOT_AN_EPIC} from "./codes.ts";

const ISSUE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/8070$/;
const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;

const PITCH = "## Pitch\n\n**Problem.** The desk had no door to a running session.\n";

const epic = (overrides: Record<string, unknown> = {}): HttpReply =>
	served(
		issuePayload({
			number: 8070,
			title: "The desk opens one of the operator's existing sessions",
			body: PITCH,
			labels: [{name: "type:epic"}],
			...overrides,
		}),
	);

const run = (field: string, script: ReadonlyArray<readonly [RegExp, HttpReply]>) =>
	Effect.runPromise(
		Effect.provide(
			runAssemblyPr({epic: 8070, field, repo: null, env: ENV}),
			Layer.mergeAll(fakeShell([]).layer, fakeHttp(script).layer),
		),
	);

describe("lane assembly-pr", () => {
	it("answers the epic's own title under a feat(epic): prefix", async () => {
		const out = await run("title", [[ISSUE, epic()]]);

		expect(out.code).toBe(0);
		expect(out.stdout).toBe("feat(epic): The desk opens one of the operator's existing sessions\n");
	});

	it("answers the About section derived from the pitch's Problem paragraph", async () => {
		const out = await run("about", [[ISSUE, epic()]]);

		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"## About this epic\n\n> Epic #8070: The desk had no door to a running session.\n",
		);
	});

	it("prints no section and says why when the epic carries no pitch", async () => {
		const out = await run("about", [[ISSUE, epic({body: "## Summary\n\nNothing.\n"})]]);

		expect(out.code).toBe(0);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("carries no `## Pitch` section");
	});

	it("quotes a Problem paragraph naming a classification instead of rewording it", async () => {
		const body = "## Pitch\n\n**Problem.** This is control-plane work on a type:epic at p1.\n";
		const out = await run("about", [[ISSUE, epic({body})]]);

		expect(out.code).toBe(0);
		expect(out.stdout).toContain("> Epic #8070: This is control-plane work on a type:epic at p1.");
	});

	it("refuses an issue carrying no type:epic, naming the label", async () => {
		const out = await run("title", [[ISSUE, epic({labels: [{name: "type:feature"}]})]]);

		expect(out.code).toBe(NOT_AN_EPIC);
		expect(out.stderr.join(" ")).toContain("type:epic");
	});

	it("refuses a field outside the two it declares, before any board read", async () => {
		const out = await run("body", []);

		expect(out.code).toBe(FAILED);
		expect(out.stderr.join(" ")).toContain("--field is one of title, about");
	});

	it("is UNKNOWN, never a title, when the epic cannot be read", async () => {
		const out = await run("title", [[ISSUE, {status: 500, body: "boom"}]]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("refuses an epic the board proves absent", async () => {
		const out = await run("title", [[ISSUE, NOT_FOUND]]);

		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("proven absent or closed");
	});
});
