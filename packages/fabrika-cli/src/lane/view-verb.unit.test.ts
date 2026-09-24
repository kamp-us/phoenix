/**
 * `lane view` — what this verb owns.
 *
 * Reading a lane directory is the vendored viewer's (`lanesFromDisk`) and is covered beside it in
 * `viewer-server.unit.test.ts`: the two-file convention, a directory that is not a lane, a lane
 * emitted and never run. What is this verb's is the refusal when the root cannot be listed, and
 * the sentence a driver reads.
 */
import {createServer} from "node:net";
import {Effect, Fiber} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText, fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";
import {listeningAt, runView} from "./view-verb.ts";

const ROOT = DEFAULT_LANES_ROOT;

describe("lane view — what it refuses", () => {
	it("refuses a root that is there and cannot be listed, rather than serving a short list", async () => {
		const fs = fakeFs({files: {}, dirs: {}, directories: [ROOT], unreadable: [ROOT]});
		const out = await Effect.runPromise(
			Effect.provide(
				runView(
					{
						root: ROOT,
						port: 0,
						parkCause: parkCauseRead(),
						repo: "o/r",
						cwd: "/checkout",
						env: {},
					},
					fakeProver().prove,
				),
				fs.layer,
			),
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("UNKNOWN");
	});
});

/** A port nothing holds right now: `runView` names no URL back, so the test has to pick it. */
const freePort = (): Promise<number> =>
	new Promise((ok, no) => {
		const probe = createServer();
		probe.once("error", no);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => ok(port));
		});
	});

/** Retry the first request until the forked server has bound its port. */
const fetchWhenUp = async (url: string, init?: RequestInit): Promise<Response> => {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, init).catch((cause: unknown) => cause);
		if (res instanceof Response) return res;
		if (attempt >= 50) throw res;
		await new Promise((ok) => setTimeout(ok, 20));
	}
};

describe("lane view — a button press is a `lane transition`", () => {
	it("serves the page and records a posted event through runTransition, refusals in its words", async () => {
		const log = `${ROOT}/42/events.jsonl`;
		const fs = fakeFs({
			files: {[`${ROOT}/42/workflow.json`]: coderTemplateText()},
			dirs: {[ROOT]: ["42"]},
			directories: [ROOT, `${ROOT}/42`],
		});
		const port = await freePort();
		const fiber = Effect.runFork(
			Effect.provide(
				runView(
					{root: ROOT, port, parkCause: parkCauseRead(), repo: "o/r", cwd: "/checkout", env: {}},
					fakeProver().prove,
				),
				fs.layer,
			),
		);
		try {
			const url = `http://127.0.0.1:${port}`;
			expect(await (await fetchWhenUp(`${url}/`)).text()).toContain("<title>fabrika lanes</title>");

			const post = async (event: string) =>
				(await fetch(`${url}/api/transition`, {
					method: "POST",
					body: JSON.stringify({lane: "42", event}),
				}).then((res) => res.json())) as {ok: boolean; stdout: string; stderr: string};

			const recorded = await post("WIP");
			expect(recorded.ok).toBe(true);
			expect(fs.written.get(log)).toContain('"ISSUE.WIP"');

			const refused = await post("PASS");
			expect(refused.ok).toBe(false);
			expect(refused.stderr).toContain("fabrika lane transition");
			expect(fs.written.get(log)?.match(/\n/g)).toHaveLength(1);
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});
});

describe("lane view — what a driver reads", () => {
	it("names the port and what the ordering means", () => {
		expect(listeningAt(5411)).toContain("http://localhost:5411");
		expect(listeningAt(5411)).toContain("needing a person first");
	});
});
