/**
 * `ci pr-body`, ported from `pipeline-cli release-pr-body sanitize` (#6099) — the
 * empty-output-means-no-work contract and the fd-0 taxonomy.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {EMPTY_STDIN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {runPrBody} from "./pr-body-verb.ts";

const run = (read: StdinRead) => Effect.runPromise(runPrBody({stdin: () => read}));

const piped = (text: string): StdinRead => ({_tag: "Text", text});

const POISONED = [
	"<details><summary>fabrika-cli: 0.3.0</summary>",
	"",
	"* a commit whose subject carried a literal <details> tag",
	"",
	"</details>",
].join("\n");

describe("runPrBody", () => {
	it("prints nothing when the body already parses — the caller writes back only on real work", async () => {
		const outcome = await run(
			piped("<details><summary>a: 1.0.0</summary>\n\n* fine\n\n</details>"),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("nothing to write");
	});

	it("strips the brackets off a stray tag and leaves release-please's own two lines exact", async () => {
		const outcome = await run(piped(POISONED));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("<details><summary>fabrika-cli: 0.3.0</summary>");
		expect(outcome.stdout).toContain("</details>");
		expect(outcome.stdout).toContain("a literal details tag");
		expect(outcome.stdout).not.toContain("literal <details> tag");
		expect(outcome.stderr.join("\n")).toContain("neutralized 1 stray HTML tag(s)");
	});

	it("refuses an unreadable pipe as UNKNOWN — never as an already-clean body", async () => {
		const outcome = await run({_tag: "Failed", reason: "EAGAIN with no data for 30000ms"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("refuses a TTY with the piping remedy", async () => {
		const outcome = await run({_tag: "NoStdin", reason: "fd 0 is a TTY — nothing was piped in"});
		expect(outcome.code).toBe(EMPTY_STDIN);
		expect(outcome.stderr.join("\n")).toContain("gh api");
	});

	it("refuses an empty body — there is no body to repair", async () => {
		expect((await run(piped(""))).code).toBe(EMPTY_STDIN);
	});
});
