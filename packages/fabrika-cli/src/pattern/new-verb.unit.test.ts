import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {ALREADY_EXISTS, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {ANCHOR_DECLARATION} from "./doc.ts";
import {type NewOptions, runNew} from "./new-verb.ts";

const options: NewOptions = {
	slug: "worker-queue-retry",
	dir: ".patterns",
	title: null,
	anchor: null,
	json: false,
};

const run = (opts: Partial<typeof options> = {}, fs: FakeFsOptions = {}) => {
	const fake = fakeFs(fs);
	return Effect.runPromise(Effect.provide(runNew({...options, ...opts}), fake.layer)).then(
		(outcome) => ({outcome, written: fake.written}),
	);
};

describe("runNew", () => {
	// The contract's first worked example.
	it("answers the path written and nothing else", async () => {
		const {outcome, written} = await run();
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(".patterns/worker-queue-retry.md\n");
		expect(
			written.get(".patterns/worker-queue-retry.md")?.startsWith("# Worker queue retry\n"),
		).toBe(true);
	});

	// The contract's second worked example.
	it("refuses to overwrite an existing doc", async () => {
		const {outcome, written} = await run(
			{},
			{files: {".patterns/worker-queue-retry.md": "# Already here\n"}},
		);
		expect(outcome.code).toBe(ALREADY_EXISTS);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toBe(
			"pattern new: .patterns/worker-queue-retry.md already exists — refusing to overwrite.",
		);
		expect(written.size).toBe(0);
	});

	// The contract's third and fourth worked examples.
	it("carries the write record through --json, with and without an anchor", async () => {
		expect((await run({json: true})).outcome.stdout).toBe(
			'{"path":".patterns/worker-queue-retry.md","slug":"worker-queue-retry","title":"Worker queue retry","anchored":null}\n',
		);
		expect((await run({json: true, anchor: "acme-queue@4.2.0"})).outcome.stdout).toBe(
			'{"path":".patterns/worker-queue-retry.md","slug":"worker-queue-retry","title":"Worker queue retry","anchored":"acme-queue@4.2.0"}\n',
		);
	});

	it("writes the anchor line in the exact bytes pattern anchor parses", async () => {
		const {written} = await run({anchor: "@nkzw/fate@1.3.1"});
		const line = (written.get(".patterns/worker-queue-retry.md") ?? "")
			.trimEnd()
			.split("\n")
			.at(-1);
		expect(ANCHOR_DECLARATION.exec(line ?? "")?.[1]).toBe("@nkzw/fate@1.3.1");
	});

	// The writer and the reader of that line accept exactly the same strings.
	it("refuses an --anchor that is not <pkg>@<version> as a usage error", async () => {
		const {outcome, written} = await run({anchor: "acme-queue"});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toBe(
			'pattern new: --anchor "acme-queue" is not <pkg>@<version>.',
		);
		expect(written.size).toBe(0);
	});

	it("refuses a slug that is not kebab-case", async () => {
		const {outcome} = await run({slug: "Worker Queue"});
		expect(outcome.code).toBe(1);
		expect(outcome.stdout).toBe("");
	});

	// A failed write is UNKNOWN, deliberately not 1: whether anything landed is exactly what a caller
	// cannot tell, and seating it on 1 would fuse it with a broken binary.
	it("reports a failed write as UNKNOWN rather than as a usage error", async () => {
		const {outcome} = await run({}, {unwritable: [".patterns/worker-queue-retry.md"]});
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.code).not.toBe(1);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("whether anything landed is UNKNOWN");
	});

	// A probe that could not RUN is not "absent": answering absent would license a write over a doc
	// this verb never managed to look at.
	it("refuses a probe it could not perform, and writes nothing", async () => {
		const {outcome, written} = await run({}, {unprobeable: [".patterns/worker-queue-retry.md"]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(written.size).toBe(0);
	});

	it("takes --title verbatim over the derivation", async () => {
		const {written} = await run({title: "Fate (Effect) server"});
		expect(
			written.get(".patterns/worker-queue-retry.md")?.startsWith("# Fate (Effect) server\n"),
		).toBe(true);
	});
});
