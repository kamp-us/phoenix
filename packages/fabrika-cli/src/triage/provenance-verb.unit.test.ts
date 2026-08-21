import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {ANSWER, FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runProvenance} from "./provenance-verb.ts";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;

const options = {
	issue: 4312,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

/** A placeholder operator set — these tests measure the mechanism, never a real login. */
const OPERATOR_ENV = {
	CLAUDE_PIPELINE_REPO: "o/r",
	FABRIKA_OPERATOR_ACCOUNTS: "operator-account",
} as Record<string, string | undefined>;

const issueJson = (body: string, author = "someone-else") =>
	JSON.stringify({
		number: 4312,
		title: "t",
		html_url: "u",
		state: "open",
		labels: [],
		body,
		user: {login: author},
	});

const served = (body: string) => ({status: 200, body});

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runProvenance({...options, ...overrides}), fakeSeams(script).layer),
	);

const AGENT_BODY = "What I observed.\n\n---\n<sub>Filed by an agent · 2026-08-03T05:47:38Z</sub>\n";

describe("runProvenance", () => {
	it("answers `agent` on the footer, on stdout, exit 0", async () => {
		const out = await run([[ISSUE, served(issueJson(AGENT_BODY))]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("agent\n");
	});

	it("answers `human` for a hand-typed body", async () => {
		const out = await run([[ISSUE, served(issueJson("I hit a bug in the retry helper.\n"))]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("human\n");
	});

	it("answers `human` for a PRESENT-but-empty body — a measurement, fail-closed", async () => {
		const out = await run([[ISSUE, served(issueJson("   \n"))]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("human\n");
		expect(out.stderr.join("\n")).toContain("empty body");
	});

	it("REFUSES an unreadable issue as UNKNOWN — never `human`, which a kill acts on", async () => {
		const out = await run([[ISSUE, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("refuses a PROVEN-absent issue on the zero-scope code, apart from the unknown one", async () => {
		const out = await run([[ISSUE, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("puts the --json payload on stdout with the marker and the reason", async () => {
		const out = await run([[ISSUE, served(issueJson(AGENT_BODY))]], {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({outcome: "agent", marker: true});
		expect(out.stderr.join("")).not.toContain('"outcome"');
	});

	it("answers `agent` for a FOOTERLESS filing by a configured operator account (#4619)", async () => {
		const out = await run([[ISSUE, served(issueJson("no footer here\n", "operator-account"))]], {
			env: OPERATOR_ENV,
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("agent\n");
		expect(out.stderr.join("\n")).toContain("operator account");
	});

	it("still answers `human` for a footerless filing by any other author", async () => {
		const out = await run([[ISSUE, served(issueJson("no footer here\n", "cansirin"))]], {
			env: OPERATOR_ENV,
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("human\n");
	});

	it("marks the operator answer in --json, keeping the footer fact separate from it", async () => {
		const out = await run([[ISSUE, served(issueJson("no footer here\n", "operator-account"))]], {
			env: OPERATOR_ENV,
			json: true,
		});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "agent",
			marker: false,
			operator: true,
		});
	});

	it("answers `agent` for an EMPTY body from an operator — the ruling, not the fail-closed default", async () => {
		const out = await run([[ISSUE, served(issueJson("   \n", "operator-account"))]], {
			env: OPERATOR_ENV,
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("agent\n");
	});

	it("refuses when no target repo resolves", async () => {
		const out = await run([[/git remote get-url/, errOut("no origin")]], {env: {}});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("CLAUDE_PIPELINE_REPO");
	});
});
