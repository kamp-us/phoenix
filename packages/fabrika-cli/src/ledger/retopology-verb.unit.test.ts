/**
 * `ledger retopology`: the descope rewrite, its idempotent no-op, every refusal arm, and the bytes
 * outside the block proven untouched across a splice.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {emitMachine} from "../lane/emit.ts";
import {
	BAD_SECTIONS,
	CLAIM_NOT_MINE,
	EPIC_MOVED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	REGION_UNRESOLVABLE,
	TOPOLOGY_INVALID,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {CLAIMED, env, epic, subIssues, TOKEN} from "./fixtures.test-support.ts";
import {runRetopology} from "./retopology-verb.ts";

const EPIC_READ = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues/;
const PATCH = /^PATCH https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const PATCHED: HttpReply = {status: 200, body: "{}"};

const ENVELOPE = [
	"<!-- fabrika:enriched issue=4300 mode=rewrite -->",
	"<details>",
	"<summary>Original report (verbatim)</summary>",
	"",
	"## Summary",
	"",
	"The lane wedges on a descope.",
	"",
	"</details>",
].join("\n");
const PLAN = "## Plan (plan-epic)\n\n### Summary\n\nA plan nothing here may touch.\n";
const AMENDMENT = "---\n\n**Amendment 2026-09-01** — a line filed below the block.\n";

/**
 * A planned epic body in the layout `ledger write` leaves: the brief, the preserved envelope, then
 * the plan and its topology appended below both, and a dated amendment under a thematic break.
 */
const body = (topology: string, tail = AMENDMENT): string =>
	`An epic brief about the moderation queue.\n\n${ENVELOPE}\n\n${PLAN}\n${topology}\n${tail}`;

/** The block a descope leaves stale: it still names the child the board has unlinked. */
const STALE =
	"## Dependencies\n\n- phase 1: #4301\n- phase 2: #4302, #4303\n- #4302 requires: #4301\n- #4303 requires: #4301\n";
const REPAIRED = "## Dependencies\n\n- phase 1: #4301\n- phase 2: #4303\n- #4303 requires: #4301\n";

const STALE_BODY = body(STALE);
const REPAIRED_BODY = body(REPAIRED);
const LIVE = subIssues({number: 4301}, {number: 4303});

const happy = (
	options: {before?: string; after?: string; live?: HttpReply; patch?: HttpReply} = {},
): ReadonlyArray<Scripted> => [
	[once(EPIC_READ), epic({body: options.before ?? STALE_BODY})],
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	...CLAIMED,
	[SUBS, options.live ?? LIVE],
	[PATCH, options.patch ?? PATCHED],
	[EPIC_READ, epic({body: options.after ?? REPAIRED_BODY})],
];

const run = (script: ReadonlyArray<Scripted> = happy(), digest = bodyDigest(STALE_BODY)) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(
			runRetopology({
				number: 4300,
				bodyDigest: digest,
				token: TOKEN,
				repo: null,
				cwd: "/repo",
				env,
			}),
			Layer.mergeAll(seams.layer, fakeFs({files: {}}).layer),
		),
	).then((outcome) => ({outcome, seams}));
};

/** What the one PATCH carried as its body, or `null` when none was issued. */
const patchedBody = (seams: {
	requests: ReadonlyArray<string>;
	bodies: ReadonlyArray<string>;
}): string | null => {
	const index = seams.requests.findIndex((line) => PATCH.test(line));
	if (index === -1) return null;
	return (JSON.parse(seams.bodies[index] as string) as {body: string}).body;
};

describe("runRetopology", () => {
	it("drops the descoped child from its phase and from every requires list naming it", async () => {
		const {outcome, seams} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "rewritten",
			epic: 4300,
			children: 2,
			phases: 2,
			dropped: {count: 1, rows: ["#4302"]},
			verified: true,
		});
		const written = patchedBody(seams) ?? "";
		expect(written).toContain("- phase 2: #4303");
		expect(written).not.toContain("#4302");
	});

	it("leaves every byte outside the block where it was — plan, envelope and amendment", async () => {
		const {seams} = await run();
		const written = patchedBody(seams) ?? "";
		expect(written).toBe(REPAIRED_BODY);
		expect(written).toContain(PLAN);
		expect(written).toContain(ENVELOPE);
		expect(written).toContain(AMENDMENT);
	});

	it("refuses a Dependencies heading that resolves inside the preserved brief envelope", async () => {
		const inside = [
			"An epic brief about the moderation queue.",
			"",
			"<!-- fabrika:enriched issue=4300 mode=rewrite -->",
			"<details>",
			"<summary>Original report (verbatim)</summary>",
			"",
			"## Dependencies",
			"",
			"- phase 1: #4301",
			"",
			"## Notes",
			"",
			"</details>",
			"",
		].join("\n");
		const {outcome, seams} = await run(
			happy({before: inside, live: subIssues({number: 4301})}),
			bodyDigest(inside),
		);
		expect(outcome.code).toBe(REGION_UNRESOLVABLE);
		expect(patchedBody(seams)).toBeNull();
	});

	it("issues no PATCH when the block already names exactly the live children", async () => {
		const {outcome, seams} = await run(happy({before: REPAIRED_BODY}), bodyDigest(REPAIRED_BODY));
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({answer: "unchanged", verified: true});
		expect(patchedBody(seams)).toBeNull();
	});

	it("leaves a body a plain `lane emit` emits — the wedge is over", async () => {
		const {seams} = await run();
		const repaired = patchedBody(seams) ?? "";
		const links = [4301, 4303].map(
			(number) => ({number, state: "open", stateReason: null}) as const,
		);
		expect(emitMachine(4300, repaired, links)).toMatchObject({_tag: "Emitted", children: 2});
	});

	it("closes, unlinks and comments on nothing", async () => {
		const {seams} = await run();
		expect(seams.requests.filter((line) => /^DELETE|\/comments$/.test(line))).toEqual([]);
		expect(seams.bodies.some((body) => body.includes("state_reason"))).toBe(false);
	});

	it("reads no run directory, so a cleared plan run is not a refusal", async () => {
		// The fake filesystem holds no run.json and no manifest; the happy path above still answers.
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
	});

	it("refuses a body carrying no readable Dependencies block", async () => {
		const bare = "An epic brief about the moderation queue.\n";
		const {outcome} = await run(happy({before: bare}), bodyDigest(bare));
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses an epic with no live sub-issue links", async () => {
		const {outcome} = await run(happy({live: subIssues()}));
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses a topology line that does not parse", async () => {
		const broken = body("## Dependencies\n\n- phase one: #4301\n");
		const {outcome} = await run(happy({before: broken}), bodyDigest(broken));
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.join("\n")).toContain("does not parse");
	});

	it("reports a long dropped list whole on stderr the same way its stdout answer does", async () => {
		const many = body(
			"## Dependencies\n\n- phase 1: #4301\n- phase 2: #9901, #9902, #9903, #9904, #9905, #9906, #9907\n",
		);
		const {outcome} = await run(
			happy({
				before: many,
				after: body("## Dependencies\n\n- phase 1: #4301\n"),
				live: subIssues({number: 4301}),
			}),
			bodyDigest(many),
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "rewritten",
			dropped: {
				count: 7,
				rows: ["#9901", "#9902", "#9903", "#9904", "#9905", "#9906", "#9907"],
			},
		});
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain("dropping 7 ref(s): #9901, #9902, #9903, #9904, #9905, #9906, #9907.");
	});

	it("reports the dropped list whole on the emptied refusal too", async () => {
		const foreign = body(
			"## Dependencies\n\n- phase 1: #9901, #9902, #9903, #9904, #9905, #9906, #9907\n",
		);
		const {outcome} = await run(happy({before: foreign}), bodyDigest(foreign));
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		const stderr = outcome.stderr.join("\n");
		expect(stderr).toContain("#9901, #9902, #9903, #9904, #9905, #9906, #9907");
	});

	it("refuses a live child the block places in no phase", async () => {
		const {outcome} = await run(
			happy({live: subIssues({number: 4301}, {number: 4303}, {number: 4400})}),
		);
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.join("\n")).toContain("#4400");
	});

	it("refuses a topology every one of whose refs is outside the live child list", async () => {
		const foreign = body("## Dependencies\n\n- phase 1: #9998, #9999\n");
		const {outcome} = await run(happy({before: foreign}), bodyDigest(foreign));
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.join("\n")).toContain("#9999");
	});

	it("refuses a child the block places in two phases", async () => {
		const twice = body("## Dependencies\n\n- phase 1: #4301, #4303\n- phase 2: #4303\n");
		const {outcome} = await run(happy({before: twice}), bodyDigest(twice));
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
	});

	it("refuses a cycle over what survives the drop", async () => {
		const cyclic = body(
			"## Dependencies\n\n- phase 1: #4301, #4303\n- #4301 requires: #4303\n- #4303 requires: #4301\n",
		);
		const {outcome} = await run(happy({before: cyclic}), bodyDigest(cyclic));
		expect(outcome.code).toBe(TOPOLOGY_INVALID);
		expect(outcome.stderr.join("\n")).toContain("cycle");
	});

	it("refuses two Dependencies headings — the region has no single meaning", async () => {
		const twoBlocks = `${body(STALE, "")}\n## Dependencies\n\n- phase 1: #4301\n`;
		const {outcome} = await run(happy({before: twoBlocks}), bodyDigest(twoBlocks));
		expect(outcome.code).toBe(REGION_UNRESOLVABLE);
	});

	it("refuses a body that moved since the digest was taken", async () => {
		const {outcome, seams} = await run(happy(), "0123456789ab");
		expect(outcome.code).toBe(EPIC_MOVED);
		expect(patchedBody(seams)).toBeNull();
	});

	it("refuses a --body-digest that is not 12 lowercase hex before any read", async () => {
		const {outcome, seams} = await run(happy(), "NOPE");
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(seams.log).toEqual([]);
	});

	it("refuses a target that is not a type:epic", async () => {
		const {outcome} = await run([
			[once(EPIC_READ), epic({body: STALE_BODY, labels: [{name: "type:feature"}]})],
		]);
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses when this lane does not hold the claim", async () => {
		const {outcome} = await run([
			[once(EPIC_READ), epic({body: STALE_BODY})],
			[/^git rev-parse --path-format=absolute/, GIT_DIRS],
			[/comments\?/, {status: 200, body: "[]"}],
		]);
		expect(outcome.code).toBe(CLAIM_NOT_MINE);
	});

	it("is UNKNOWN when the child list cannot be read, and writes nothing", async () => {
		const {outcome, seams} = await run(happy({live: {status: 500, body: "boom"}}));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(patchedBody(seams)).toBeNull();
	});

	it("is UNKNOWN when the PATCH cannot be confirmed", async () => {
		const {outcome} = await run(happy({patch: {status: 500, body: "boom"}}));
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses a body that does not read back as composed", async () => {
		const {outcome} = await run(happy({after: `${REPAIRED_BODY}\nsomething else landed.\n`}));
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
