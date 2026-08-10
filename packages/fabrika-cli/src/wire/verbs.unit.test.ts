/**
 * The adapter tier: which exit code each outcome is seated on, and — the assertion this group
 * exists for — that an artifact the verb could not see is **distinguishable** from one it read and
 * found nothing in.
 *
 * Three inputs are driven through `read` and `check` below: a real body with no block, a fd 0 that
 * could not be read, and a fd 0 that carried nothing. A reader that fused any two of them would
 * still pass a test asserting only "it refused"; every case here asserts the *code*, and the last
 * test asserts the three codes are pairwise distinct, which is the property a future edit could
 * quietly lose.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {ANSWER} from "../verb.ts";
import {runCheck} from "./check-verb.ts";
import {
	ABSENT,
	ARTIFACT_UNKNOWN,
	EMPTY_ARTIFACT,
	MALFORMED,
	UNUSABLE_FIELDS,
	WIRE_EXIT_TABLE,
	ZERO_SCOPE,
} from "./codes.ts";
import {runCodes} from "./codes-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {runFormats} from "./formats-verb.ts";
import {runRead} from "./read-verb.ts";
import {registeredFormats} from "./registry.ts";

const KEY = "acceptance-criteria";
const VERDICT = "verdict-marker";

const piped = (text: string): Effect.Effect<StdinRead> => Effect.succeed({_tag: "Text", text});
const noStdin: Effect.Effect<StdinRead> = Effect.succeed({
	_tag: "NoStdin",
	reason: "fd 0 is a TTY — nothing was piped in",
});
const readFailed: Effect.Effect<StdinRead> = Effect.succeed({
	_tag: "Failed",
	reason: "EAGAIN with no data for 30000ms",
});

const CONFORMING = "### Acceptance criteria\n- [ ] one\n- [x] two\n";
const NO_BLOCK = "### What to build\n\nStand up the group. No criteria section here.\n";
const DRIFTED = "### Acceptance Criteria\n- [ ] one\n";

const read = (stdin: Effect.Effect<StdinRead>, format = KEY, json = false) =>
	Effect.runPromise(runRead({format, json, stdin}));
const check = (stdin: Effect.Effect<StdinRead>, format = KEY, json = false) =>
	Effect.runPromise(runCheck({format, json, stdin}));
const emit = (stdin: Effect.Effect<StdinRead>, format = KEY, json = false) =>
	Effect.runPromise(runEmit({format, json, stdin}));

describe("wire read", () => {
	it("prints the criteria on stdout with a positive token, exit 0", async () => {
		const out = await read(piped(CONFORMING));
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(`found\t${KEY}\t2\nopen\tone\nchecked\ttwo\n`);
	});

	it("states the scope it judged on stderr, never on the answer channel", async () => {
		const out = await read(piped(CONFORMING));
		expect(out.stderr.join("\n")).toContain(`judged 4 lines (${CONFORMING.length} bytes)`);
		expect(out.stdout).not.toContain("judged");
	});

	it("seats a PROVEN absent on 3 with nothing on stdout", async () => {
		const out = await read(piped(NO_BLOCK));
		expect(out.code).toBe(ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("absent");
	});

	it("seats a PROVEN malformed on 4, naming the drift and quoting the bytes", async () => {
		const out = await read(piped(DRIFTED));
		expect(out.code).toBe(MALFORMED);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("Acceptance Criteria");
	});

	it("REFUSES an artifact it never saw as UNKNOWN — not as absent", async () => {
		for (const stdin of [noStdin, readFailed]) {
			const out = await read(stdin);
			expect(out.code).toBe(ARTIFACT_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.join("\n")).toContain("UNKNOWN");
		}
	});

	it("refuses an empty artifact on its own code — an empty pipe is not a body with no block", async () => {
		const out = await read(piped("   \n\n"));
		expect(out.code).toBe(EMPTY_ARTIFACT);
		expect(out.stdout).toBe("");
	});

	it("refuses an unregistered --format as zero scope, naming what IS registered", async () => {
		const out = await read(piped(CONFORMING), "no-such-format");
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(KEY);
	});

	it("emits one JSON object under --json", async () => {
		const out = await read(piped(CONFORMING), KEY, true);
		expect(JSON.parse(out.stdout)).toEqual({
			format: KEY,
			outcome: "found",
			fields: ["open\tone", "checked\ttwo"],
		});
	});

	/**
	 * The property, asserted directly rather than left implied by the cases above: a caller that
	 * branches on the exit code can always tell the three apart. Collapsing any pair is what turns an
	 * unread artifact into a clean-looking negative.
	 */
	it("keeps proven-absent, malformed and never-seen on three DIFFERENT codes", async () => {
		const codes = [
			(await read(piped(NO_BLOCK))).code,
			(await read(piped(DRIFTED))).code,
			(await read(noStdin)).code,
			(await read(piped(""))).code,
		];
		expect(new Set(codes).size).toBe(codes.length);
		expect(codes).not.toContain(0);
		expect(codes).not.toContain(1);
		expect(codes).not.toContain(127);
	});
});

describe("wire check", () => {
	it("answers a verdict token without the fields, exit 0", async () => {
		const out = await check(piped(CONFORMING));
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(`conforms\t${KEY}\t2\n`);
		expect(out.stdout).not.toContain("one");
	});

	it("states the scope it judged on EVERY path, including the refusals", async () => {
		for (const artifact of [CONFORMING, NO_BLOCK, DRIFTED]) {
			const out = await check(piped(artifact));
			expect(out.stderr.join("\n")).toContain(`against format ${KEY}`);
		}
	});

	it("reds on zero scope rather than passing vacuously (ADR 0092)", async () => {
		const out = await check(piped(CONFORMING), "no-such-format");
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("seats absent on 3 and malformed on 4, matching `read`", async () => {
		expect((await check(piped(NO_BLOCK))).code).toBe(ABSENT);
		expect((await check(piped(DRIFTED))).code).toBe(MALFORMED);
	});

	it("refuses an unseen artifact as UNKNOWN", async () => {
		expect((await check(readFailed)).code).toBe(ARTIFACT_UNKNOWN);
	});
});

describe("wire emit", () => {
	it("composes the block from the fields and round-trips through `read`", async () => {
		const out = await emit(piped("first\n[x] second\n"));
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe("### Acceptance criteria\n\n- [ ] first\n- [x] second\n");

		const back = await read(piped(out.stdout));
		expect(back.code).toBe(ANSWER);
		expect(back.stdout).toBe(`found\t${KEY}\t2\nopen\tfirst\nchecked\tsecond\n`);
	});

	it("refuses fields that compose nothing, rather than emitting an empty block", async () => {
		const out = await emit(piped("[x]\n"));
		expect(out.code).toBe(UNUSABLE_FIELDS);
		expect(out.stdout).toBe("");
	});

	it("refuses an unseen fd 0 as UNKNOWN and an empty one on its own code", async () => {
		expect((await emit(noStdin)).code).toBe(ARTIFACT_UNKNOWN);
		expect((await emit(piped("\n")))?.code).toBe(EMPTY_ARTIFACT);
	});
});

describe("wire formats", () => {
	it("derives one row per registered format — no parallel hand-written list", () => {
		const out = runFormats({json: false});
		const lines = out.stdout.trimEnd().split("\n");
		expect(lines[0]).toBe(`formats\t${registeredFormats.length}`);
		expect(lines).toHaveLength(registeredFormats.length + 1);
		for (const [index, format] of registeredFormats.entries()) {
			expect(lines[index + 1]?.startsWith(`${format.key}\t`)).toBe(true);
		}
	});

	it("lists the founding format with its producers and consumers", () => {
		const out = runFormats({json: true});
		expect(JSON.parse(out.stdout).formats).toContainEqual({
			key: KEY,
			purpose: expect.any(String),
			producers: expect.arrayContaining(["triage"]),
			consumers: expect.arrayContaining(["review"]),
		});
	});

	it("lists the verdict marker with its owner module's producers and consumers", () => {
		const out = runFormats({json: true});
		expect(JSON.parse(out.stdout).formats).toContainEqual({
			key: VERDICT,
			purpose: expect.any(String),
			producers: expect.arrayContaining(["review"]),
			consumers: expect.arrayContaining(["ship"]),
		});
	});
});

/**
 * The seam's own test: a second format reaches every verb through its registry row alone.
 *
 * If any assertion here needed a branch in `read-verb.ts` / `check-verb.ts` / `emit-verb.ts` to
 * pass, the registry would not be the landing surface it claims to be — so these cases are as much
 * about the adapter as about the marker.
 */
describe("a second format on the same seam", () => {
	const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";
	const MARKER = `review-code: PASS @ ${HEAD} — merge-ready\n`;

	it("answers a conforming marker through the SAME read verb, exit 0", async () => {
		const out = await read(piped(MARKER), VERDICT);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).toBe(
			`found\t${VERDICT}\t4\nnamespace\treview-code\npolarity\tPASS\nsha\t${HEAD}\nclause\tmerge-ready\n`,
		);
	});

	it("seats a comment with no marker on ABSENT and a drifted marker on MALFORMED", async () => {
		expect((await read(piped("looks good to me\n"), VERDICT)).code).toBe(ABSENT);
		expect((await read(piped("review-code: PASS — merge-ready\n"), VERDICT)).code).toBe(MALFORMED);
	});

	it("refuses an artifact it never saw as UNKNOWN rather than as an unreviewed PR", async () => {
		expect((await read(readFailed, VERDICT)).code).toBe(ARTIFACT_UNKNOWN);
		expect((await read(piped("  \n"), VERDICT)).code).toBe(EMPTY_ARTIFACT);
	});

	it("checks and emits on the same taxonomy, and `emit` round-trips through `read`", async () => {
		expect((await check(piped(MARKER), VERDICT)).code).toBe(ANSWER);
		const composed = await emit(
			piped(`namespace: review-code\npolarity: PASS\nsha: ${HEAD}\nclause: merge-ready\n`),
			VERDICT,
		);
		expect(composed.code).toBe(ANSWER);
		expect(composed.stdout).toBe(MARKER);
		expect((await read(piped(composed.stdout), VERDICT)).code).toBe(ANSWER);
	});

	it("refuses fields that compose no bound marker, on the shared UNUSABLE_FIELDS code", async () => {
		const out = await emit(
			piped("namespace: review-code\npolarity: PASS\nclause: merge-ready\n"),
			VERDICT,
		);
		expect(out.code).toBe(UNUSABLE_FIELDS);
		expect(out.stdout).toBe("");
	});
});

describe("wire codes", () => {
	it("prints one `<code>\\t<meaning>` line per row and always exits 0", () => {
		const out = runCodes({json: false});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.trimEnd().split("\n")).toHaveLength(WIRE_EXIT_TABLE.length);
	});

	it("allocates no code twice — a shared code is a fused meaning", () => {
		const codes = WIRE_EXIT_TABLE.map((row) => row.code);
		expect(new Set(codes).size).toBe(codes.length);
	});
});
