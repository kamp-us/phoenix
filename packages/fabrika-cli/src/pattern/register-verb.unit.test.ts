import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {
	DOC_ABSENT,
	INDEX_UNPARSEABLE,
	OFF_VOCABULARY,
	READBACK_MISMATCH,
	SECTION_AMBIGUOUS,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {FIXTURES, THREE_SECTIONS_INDEX} from "./fixtures.test-support.ts";
import {readBackCarries} from "./register.ts";
import {runRegister} from "./register-verb.ts";

const DIR = `${FIXTURES}/three-sections`;
const INDEX = `${DIR}/index.md`;

const options = {
	slug: "cache-invalidation",
	section: "Index — services",
	topic: "Cache keys and invalidation order",
	readWhen: "Touching a cached read",
	dir: DIR,
	json: false,
};

const tree = (extra: Readonly<Record<string, string | null>> = {}): FakeFsOptions => ({
	files: {
		[INDEX]: THREE_SECTIONS_INDEX,
		[`${DIR}/cache-invalidation.md`]: "# Cache invalidation\n",
		[`${DIR}/worker-queue-retry.md`]: "# Worker queue retry\n",
		...extra,
	},
});

const run = (opts: Partial<typeof options> = {}, fs: FakeFsOptions = tree()) => {
	const fake = fakeFs(fs);
	return Effect.runPromise(Effect.provide(runRegister({...options, ...opts}), fake.layer)).then(
		(outcome) => ({outcome, written: fake.written}),
	);
};

describe("runRegister", () => {
	it("inserts one row under the named section and proves nothing else moved", async () => {
		const {outcome, written} = await run({slug: "worker-queue-retry"});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`inserted\t${INDEX}\tIndex — services\n`);
		const after = written.get(INDEX) ?? "";
		expect(after.split("\n").length).toBe(THREE_SECTIONS_INDEX.split("\n").length + 1);
		expect(after).toContain(
			"| [worker-queue-retry.md](./worker-queue-retry.md) | Cache keys and invalidation order | Touching a cached read |",
		);
		// The two tables this verb did not name survive verbatim.
		expect(after).toContain(
			"| [tracing-span-names.md](./tracing-span-names.md) | Span naming convention | Naming a new span |",
		);
	});

	// The contract's second worked example, byte for byte. The `present:` list is EVERY section
	// carrying a table, in document order, never truncated — a caller correcting a flag needs the
	// whole set, so its next invocation is a correction rather than a guess.
	it("names every section carrying a table when --section matches none", async () => {
		const {outcome, written} = await run({
			section: "Nonexistent Section",
			topic: "x",
			readWhen: "y",
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toBe(
			`pattern register: no section "Nonexistent Section" in ${INDEX} (present: Index — services, Index — edge, Index — observability).`,
		);
		expect(written.size).toBe(0);
	});

	// The contract's third worked example. Registering twice is a no-op, not an error.
	it("answers `already` at exit 0 without writing when the row is there", async () => {
		const {outcome, written} = await run();
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`already\t${INDEX}\tIndex — services\n`);
		expect(written.size).toBe(0);
	});

	// The flag is right and the index is what needs disambiguating, so it is a different code from 10.
	it("refuses a section name matching more than one heading", async () => {
		const doubled = `${THREE_SECTIONS_INDEX}\n## Index — services\n\n| Doc | Topic | Read when |\n|---|---|---|\n| [x.md](./x.md) | a | b |\n`;
		const {outcome, written} = await run({slug: "worker-queue-retry"}, tree({[INDEX]: doubled}));
		expect(outcome.code).toBe(SECTION_AMBIGUOUS);
		expect(outcome.stderr.at(-1)).toContain("matches 2 headings");
		expect(written.size).toBe(0);
	});

	// The doc lands even when the index cannot take its row — which is why `new` and `register` are
	// separable in the first place.
	it("refuses an absent index while naming the doc as written and unregistered", async () => {
		const {outcome} = await run({slug: "worker-queue-retry"}, tree({[INDEX]: null}));
		expect(outcome.code).toBe(INDEX_UNPARSEABLE);
		expect(outcome.stderr.at(-1)).toBe(
			`pattern register: ${INDEX} is absent — the doc at ${DIR}/worker-queue-retry.md is written and unregistered; front-door bootstraps the index.`,
		);
	});

	it("refuses an index holding no parseable table on the same code", async () => {
		const {outcome} = await run(
			{slug: "worker-queue-retry"},
			tree({[INDEX]: "# Patterns\n\nNothing yet.\n"}),
		);
		expect(outcome.code).toBe(INDEX_UNPARSEABLE);
		expect(outcome.stderr.at(-1)).toContain("holds no parseable markdown table");
	});

	// A row pointing at a file that does not exist is a dead link a link gate reds later and a reader
	// hits sooner, so the target is proven first.
	it("refuses to register a row pointing at nothing", async () => {
		const {outcome, written} = await run(
			{slug: "worker-queue-retry"},
			tree({
				[`${DIR}/worker-queue-retry.md`]: null,
			}),
		);
		expect(outcome.code).toBe(DOC_ABSENT);
		expect(outcome.stderr.at(-1)).toBe(
			`pattern register: no doc at ${DIR}/worker-queue-retry.md — refusing to register a row pointing at nothing.`,
		);
		expect(written.size).toBe(0);
	});

	it("reports a failed write as UNKNOWN rather than as a usage error", async () => {
		const {outcome} = await run(
			{slug: "worker-queue-retry"},
			{
				...tree(),
				unwritable: [INDEX],
			},
		);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.code).not.toBe(1);
		expect(outcome.stdout).toBe("");
	});

	it("emits the same facts through --json", async () => {
		const {outcome} = await run({slug: "worker-queue-retry", json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "inserted",
			path: INDEX,
			slug: "worker-queue-retry",
			section: "Index — services",
			row: "| [worker-queue-retry.md](./worker-queue-retry.md) | Cache keys and invalidation order | Touching a cached read |",
		});
	});

	it("refuses a slug that is not kebab-case", async () => {
		const {outcome, written} = await run({slug: "Worker Queue"});
		expect(outcome.code).toBe(1);
		expect(written.size).toBe(0);
	});
});

/**
 * The read-back's own predicate, asserted directly.
 *
 * `fakeFs` stores exactly what it is handed, so a write that lands somewhere else cannot be scripted
 * through it — the state the `9` branch fires on is unreachable at this seam. The property is
 * therefore asserted where it IS decidable: over {@link readBackCarries}, the predicate the branch
 * consults, plus the seat's distinctness from the write's. A write that landed and does not match is
 * an artifact that exists and needs a human, which is neither a success nor a failed write.
 */
describe("the read-back is not decorative", () => {
	it("is false for a row that is not under the section it claims", () => {
		expect(readBackCarries(THREE_SECTIONS_INDEX, "cache-invalidation", "Index — edge")).toBe(false);
		expect(readBackCarries(THREE_SECTIONS_INDEX, "cache-invalidation", "Index — services")).toBe(
			true,
		);
	});

	it("seats a mismatch on its own code, never on the write's", () => {
		expect(READBACK_MISMATCH).not.toBe(WRITE_UNKNOWN);
	});
});
