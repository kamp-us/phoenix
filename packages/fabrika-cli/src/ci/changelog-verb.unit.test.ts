/**
 * `ci changelog`, ported from `pipeline-cli changelog-derive derive` (#6099) — the trust boundary
 * around the entries JSON and the stdout/`--out` split, over a scripted filesystem.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {runChangelog} from "./changelog-verb.ts";
import {MALFORMED_DOCUMENT, PRECONDITION_UNKNOWN} from "./codes.ts";

const ENTRIES = "/repo/entries.json";

const run = (
	files: Readonly<Record<string, string>>,
	over: Partial<Parameters<typeof runChangelog>[0]> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runChangelog({entries: ENTRIES, version: "0.3.1", date: "2026-08-18", out: null, ...over}),
			fakeFs({files}).layer,
		),
	);

const entries = (rows: ReadonlyArray<unknown>) => ({[ENTRIES]: JSON.stringify(rows)});

describe("runChangelog", () => {
	it("renders the section, bucketed by the entries' type:* labels", async () => {
		const outcome = await run(
			entries([
				{issue: 12, pr: 13, title: "Add pano", type: "feature"},
				{issue: 20, title: "Fix the focus steal", type: "bug"},
			]),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("## [0.3.1] — 2026-08-18");
		expect(outcome.stdout).toContain("### Added\n\n- Add pano (#13)");
		expect(outcome.stdout).toContain("### Fixed\n\n- Fix the focus steal (#20)");
	});

	it("surfaces an entry with no recognized type under Uncategorized rather than dropping it", async () => {
		const outcome = await run(entries([{issue: 7, title: "Something", type: "mystery"}]));
		expect(outcome.stdout).toContain("### Uncategorized\n\n- Something (#7)");
	});

	it("renders an empty range as a fact, not an error", async () => {
		const outcome = await run(entries([]));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("_No closed issues in this range._");
	});

	it("writes to --out and keeps stdout empty, with the count on stderr", async () => {
		const fs = fakeFs({files: entries([{issue: 1, title: "One", type: "chore"}])});
		const outcome = await Effect.runPromise(
			Effect.provide(
				runChangelog({
					entries: ENTRIES,
					version: "0.3.1",
					date: "2026-08-18",
					out: "/repo/CHANGELOG.md",
				}),
				fs.layer,
			),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("wrote 1 entry to /repo/CHANGELOG.md");
		expect(fs.written.get("/repo/CHANGELOG.md")).toContain("## [0.3.1] — 2026-08-18");
	});

	it("refuses an unreadable entries file as UNKNOWN, never as an empty range", async () => {
		const outcome = await run({});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("refuses a JSON file that is not a ChangelogEntry[]", async () => {
		const outcome = await run(entries([{issue: "twelve", title: "Add pano"}]));
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(outcome.stdout).toBe("");
	});

	it("refuses a file that is not JSON at all", async () => {
		const outcome = await run({[ENTRIES]: "not json"});
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
	});
});
