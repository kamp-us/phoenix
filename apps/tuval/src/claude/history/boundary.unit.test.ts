/**
 * The boundary this directory keeps: the mapping is pure, and the Agent SDK reaches it as types
 * only. A runtime SDK import here would put the CLI's spawn on the path of a function the layer
 * calls per message, and an Effect import would make the one testable-without-a-runtime piece of
 * the Claude program need a runtime to test.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const sources = () =>
	readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => ({name, text: readFileSync(join(import.meta.dirname, name), "utf8")}));

const shipped = () => sources().filter(({name}) => !name.endsWith(".unit.test.ts"));

/**
 * Just enough of a captured frame to walk one. Structural rather than `SDKMessage`, because this
 * file's subject is the bytes on disk: a fixture that stopped matching the SDK's union is exactly
 * what a check written against that union could no longer read.
 */
interface AnyFrame {
	readonly event?: {
		readonly type?: string;
		readonly content_block?: {readonly type?: string; readonly id?: unknown};
		readonly delta?: {readonly type?: string; readonly partial_json?: unknown};
	};
	readonly message?: {
		readonly content?: ReadonlyArray<{
			readonly type?: string;
			readonly id?: unknown;
			readonly input?: unknown;
		}>;
	};
}

const importsOf = (text: string) =>
	[...text.matchAll(/(^|\n)import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/g)].map((match) => ({
		specifier: match[3] ?? "",
		typeOnly: match[2] !== undefined,
	}));

describe("the Claude history mapping is pure", () => {
	it("imports no Effect and no transport", () => {
		const banned = /^(effect$|effect\/|@effect\/|ws$|node:net|node:http|node:child_process)/;
		const offenders = shipped().flatMap(({name, text}) =>
			importsOf(text)
				.filter((one) => banned.test(one.specifier))
				.map((one) => `${name}: ${one.specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("imports the Agent SDK as types only", () => {
		const sdk = shipped().flatMap(({name, text}) =>
			importsOf(text)
				.filter((one) => one.specifier.startsWith("@anthropic-ai/"))
				.map((one) => ({name, ...one})),
		);
		expect(sdk.length).toBeGreaterThan(0);
		expect(sdk.filter((one) => !one.typeOnly)).toEqual([]);
	});

	it("reaches no other Claude slice and no agent directory but ports and history", () => {
		const allowed = [/^\.\//, /^\.\.\/\.\.\/ai-agent\/(ports|history|events)/];
		const offenders = shipped().flatMap(({name, text}) =>
			importsOf(text)
				.map((one) => one.specifier)
				.filter((specifier) => specifier.startsWith("."))
				.filter((specifier) => !allowed.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("keeps every fixture the tests name, so none can be quietly dropped", () => {
		const fixtures = readdirSync(join(import.meta.dirname, "fixtures"))
			.filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
			.map((name) => name.replace(/\.jsonl?$/, ""))
			.sort();
		expect(fixtures).toEqual([
			"agent-a1b2c3d4e5f60718a",
			"agent-a1b2c3d4e5f60718a.meta",
			"assistant-turn",
			"compact-boundary",
			"error-result",
			"informational-notice",
			"init",
			"interrupted-assistant",
			"oversized-tool-turn",
			"permission-denied",
			"resumed-init",
			"session-messages",
			"streaming-turn",
			"subagent-turn",
			"thinking-turn",
			"tool-turn",
			"two-subagent-turn",
			"unknown-message",
		]);
	});

	/**
	 * The two operator roots, in every form a sanitizer can leave one in.
	 *
	 * The separator is a class rather than a slash, because the CLI keys a project directory by
	 * rewriting every separator to `-`; the leading one is optional, because a path cut across
	 * streamed deltas leaves the second half without it. That is three axes over two roots, and
	 * `private` optional on the second gives the eight forms the case below enumerates — one of which
	 * (`-var-folders-…`, the second root slug-encoded without its `private` segment) fell through the
	 * first widening (#8474 review round 2).
	 *
	 * **This is a scan for two known roots, not a proof that no operator path is left.** A fragment
	 * cut past both root names matches nothing here, and no widening of this pattern will change
	 * that: there is no root name left in it to match. The reassembly check below is the one that
	 * catches that shape, and only where the fragment sits in a delta run with a settled block to
	 * disagree with (#8474 review round 1).
	 */
	const operatorRoots = /[/-]?(private[/-])?var[/-]folders[/-]|[/-]?Users[/-]/;

	it("carries no operator path in a fixture, in any of the forms a root is left in", () => {
		const dir = join(import.meta.dirname, "fixtures");
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
			.filter((name) => operatorRoots.test(readFileSync(join(dir, name), "utf8")));
		expect(offenders).toEqual([]);
	});

	/**
	 * The scan's own coverage, as a case rather than as a sentence in a docblock — `PROVENANCE.md`
	 * tells a capture author which forms are covered, and an enumeration nothing checks is how that
	 * claim came to be true of one root and half-true of the other.
	 */
	it("matches both operator roots in all eight forms", () => {
		const forms = [
			"/Users/someone/notes",
			"Users/someone/notes",
			"/private/var/folders/ab/cd/T/run",
			"private/var/folders/ab/cd/T/run",
			"-Users-someone-notes",
			"Users-someone-notes",
			"-private-var-folders-ab-cd-T-run",
			"-var-folders-ab-cd-T-run",
		];
		expect(forms.filter((form) => !operatorRoots.test(form))).toEqual([]);
		// The flip side: a fragment with no root name in it is what the scan cannot see, and the
		// reassembly check below is why that gap is survivable.
		expect(operatorRoots.test("xvxk83q4c0000gn/T/tu")).toBe(false);
	});

	/**
	 * A streamed tool call is written twice — delta by delta, and again whole on the frame that
	 * settles it — so the two copies are each other's check. A sanitizer that rewrites one delta of a
	 * split path and leaves its neighbour leaves a fixture whose halves disagree, which is a leak in
	 * the half nothing reads today and a lie in the golden property the corpus rests on.
	 */
	const deltaRuns = (frames: ReadonlyArray<AnyFrame>) => {
		const runs: Array<{id: string; parts: Array<string>}> = [];
		let open: {id: string; parts: Array<string>} | null = null;
		for (const frame of frames) {
			const event = frame.event;
			if (event === undefined) continue;
			if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
				open = {id: String(event.content_block.id), parts: []};
				runs.push(open);
			} else if (event.delta?.type === "input_json_delta") {
				open?.parts.push(String(event.delta.partial_json ?? ""));
			} else if (event.type === "content_block_stop") {
				open = null;
			}
		}
		return runs;
	};

	const settledInputs = (frames: ReadonlyArray<AnyFrame>) => {
		const inputs = new Map<string, unknown>();
		for (const frame of frames) {
			for (const block of frame.message?.content ?? []) {
				if (block.type === "tool_use") inputs.set(String(block.id), block.input);
			}
		}
		return inputs;
	};

	it("reassembles every streamed tool call to the input its settled block carries", () => {
		const dir = join(import.meta.dirname, "fixtures");
		let checked = 0;
		const offenders: Array<string> = [];
		for (const name of readdirSync(dir).filter((one) => one.endsWith(".json"))) {
			const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (!Array.isArray(parsed)) continue;
			const frames = parsed as ReadonlyArray<AnyFrame>;
			const settled = settledInputs(frames);
			for (const run of deltaRuns(frames)) {
				const whole = settled.get(run.id);
				if (whole === undefined || run.parts.length === 0) continue;
				checked += 1;
				if (JSON.stringify(JSON.parse(run.parts.join(""))) !== JSON.stringify(whole)) {
					offenders.push(`${name}: ${run.id}`);
				}
			}
		}
		expect(offenders).toEqual([]);
		// Fail closed: a corpus whose streamed captures stopped carrying tool calls would otherwise
		// pass this by checking nothing.
		expect(checked).toBeGreaterThan(0);
	});
});
