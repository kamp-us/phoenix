/**
 * `table setup` then `table sync` on one in-memory project shaped like a hand-built board: Origin
 * carries `founder idea` and lacks `hand-start`. Sync refuses on the missing option until setup adds
 * it, and setup adding it is what lets sync run.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, unconfigured} from "../fakes.test-support.ts";
import {fakeProjects} from "../io/projects-fake.test-support.ts";
import {NOT_SET_UP} from "./codes.ts";
import {runSetup} from "./setup-verb.ts";
import {runSync, syncBoard} from "./sync-verb.ts";

const REPO = "acme/widgets";

const unexpected = (what: string) => () =>
	Effect.die(`sync reached ${what}, which an empty table never needs`);

/** The shipped board's project acts, with no issue on the table for the repository reads to answer. */
const boardOn: typeof syncBoard = {
	...syncBoard,
	node: unexpected("an issue read"),
	comments: unexpected("a comment read"),
	merged: unexpected("a pull request read"),
	add: unexpected("an add"),
};

describe("table sync after table setup on a board whose Origin lacks hand-start", () => {
	it("refuses on the missing option before setup and runs once setup added it", async () => {
		const github = fakeProjects({repo: REPO});
		const layer = Layer.mergeAll(unconfigured, fakeShell([]).layer, github.layer);
		const setup = () =>
			Effect.runPromise(Effect.provide(runSetup({repo: REPO, cwd: "/repo", env: {}}), layer));
		const sync = () =>
			Effect.runPromise(
				Effect.provide(
					runSync({repo: REPO, cwd: "/repo", env: {}, issues: [], board: boardOn}),
					layer,
				),
			);

		expect((await setup()).code).toBe(0);
		const origin = github.projects[0]?.fields.find((field) => field.name === "Origin");
		if (origin?.options === undefined) throw new Error("no Origin field");
		origin.options = [
			...origin.options.filter((option) => option.name !== "hand-start"),
			{id: "o_founder", name: "founder idea", color: "PINK", description: ""},
		];

		const refused = await sync();
		expect(refused.code).toBe(NOT_SET_UP);
		expect(refused.stderr.join("\n")).toContain('the Origin option "hand-start"');

		const reconciled = await setup();
		expect(reconciled.code, reconciled.stderr.join("\n")).toBe(0);
		expect(JSON.parse(reconciled.stdout).changes).toEqual([
			'field Origin: added the option(s) "hand-start"',
		]);

		const synced = await sync();
		expect(synced.code, synced.stderr.join("\n")).toBe(0);
		expect(JSON.parse(synced.stdout).answer).toBe("unchanged");
		expect(origin.options.map((option) => option.name)).toContain("founder idea");
	});
});
