/**
 * The contract's worked examples, reproduced byte for byte against the **committed** fixtures under
 * `claude-plugins/fabrika/skills/glossary/evals/fixtures/`.
 *
 * In-process rather than through a subprocess: what is under test is the bytes each verb produces
 * over a corpus that does not move, and a spawn per example would buy nothing but cost a cold
 * node+TS load each (`.patterns/subprocess-test-budget.md`). The end-to-end facts a subprocess is
 * the only witness for live in `glossary.cli.test.ts`.
 *
 * The reads are the real filesystem through `NodeServices.layer` — the same layer `run.ts` provides
 * — so a fixture that moves reds here instead of drifting away from the document that pins it.
 */
import {copyFileSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {runAdd} from "./add-verb.ts";
import {runCheck} from "./check-verb.ts";
import {TERM_COLLISION, ZERO_SCOPE} from "./codes.ts";
import {runDrift} from "./drift-verb.ts";
import {runInit} from "./init-verb.ts";
import {runLookup} from "./lookup-verb.ts";
import {runSections} from "./sections-verb.ts";

/** The two fixture directories, repo-relative exactly as the contract's examples spell them. */
const REGISTERS = "claude-plugins/fabrika/skills/glossary/evals/fixtures/registers";
const DECISIONS = "claude-plugins/fabrika/skills/glossary/evals/fixtures/decisions";
const EMPTY = "claude-plugins/fabrika/skills/glossary/evals/fixtures/empty";

/**
 * The verbs resolve a relative `--dir` against the target repo's root, so the package directory is a
 * fine cwd — the root walk finds the same place from anywhere inside the checkout.
 */
const cwd = process.cwd();
/** The checkout root, for the one test that copies a fixture before writing to it. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const run = <A>(effect: Effect.Effect<A, never, NodeServices.NodeServices>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

describe("glossary sections, against the committed fixture register", () => {
	it("names the three sections and their row counts", async () => {
		const out = await run(runSections({register: "terms", dir: REGISTERS, json: false, cwd}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"terms\tCore / shape\t2\nterms\tProducts (domains)\t3\nterms\tIndexing\t1\n",
		);
	});
});

describe("glossary lookup, against the committed fixture register", () => {
	const lookup = (terms: ReadonlyArray<string>) =>
		run(runLookup({terms, register: "terms", dir: REGISTERS, json: false, cwd}));

	it("reports the first `pano` row, leaving the duplication to `check`", async () => {
		expect((await lookup(["pano"])).stdout).toBe("declared\tterms\tCore / shape\tpano\n");
	});

	it("reports `tag` as overlapping `Database (tag)`, never as declared", async () => {
		expect((await lookup(["tag"])).stdout).toBe("collision\tterms\tIndexing\tDatabase (tag)\n");
	});

	it("answers one line per term, in argument order", async () => {
		expect((await lookup(["depo", "capture ledger"])).stdout).toBe(
			"declared\tterms\tProducts (domains)\tdepo\nabsent\t-\t-\t-\n",
		);
	});
});

describe("glossary check, against the committed fixture register and decisions", () => {
	it("finds exactly the two planted defects, on exit 0", async () => {
		const out = await run(
			runCheck({
				register: "terms",
				dir: REGISTERS,
				decisions: DECISIONS,
				json: false,
				cwd,
			}),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`defects
duplicate-key\tterms\tProducts (domains)\tpano\talso declared in "Core / shape"
citation-superseded\tterms\tCore / shape\tworker\tcites 0950, status "superseded by [0951](0951-depo-internal-asset-store.md)"
`,
		);
	});

	/**
	 * The fixture's `LANGUAGE.md` is present and holds no table, so `--register both` — the verb's own
	 * default — reds on zero scope over it while `--register terms` answers. Present-and-empty and
	 * absent are different facts and never share a code (ADR 0092).
	 */
	it("reds on the present-and-empty LANGUAGE register under --register both", async () => {
		const out = await run(
			runCheck({register: "both", dir: REGISTERS, decisions: DECISIONS, json: false, cwd}),
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});
});

describe("glossary drift, against the committed fixtures", () => {
	it("answers bootstrap for a readable directory holding no register", async () => {
		const out = await run(
			runDrift({register: "terms", dir: EMPTY, paths: "", limit: 40, json: false, cwd}),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("bootstrap\n");
	});
});

/**
 * `add` writes, so it runs against a **copy** of the fixture in a temp directory — the committed
 * corpus every example above resolves against must not move. The line number is the derivable half
 * of the contract's example and is what this pins.
 */
describe("glossary add, against a copy of the committed fixture register", () => {
	it("places `capture ledger` as the first row of Products (domains) — line 18", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fabrika-glossary-"));
		copyFileSync(join(REPO_ROOT, REGISTERS, "TERMS.md"), join(dir, "TERMS.md"));
		const before = readFileSync(join(dir, "TERMS.md"), "utf8");

		const out = await run(
			runAdd({
				term: "capture ledger",
				register: "terms",
				section: "Products (domains)",
				definitionFile: "-",
				notFile: null,
				replace: false,
				createSection: false,
				dir,
				json: false,
				cwd,
				stdin: Effect.succeed({
					_tag: "Text" as const,
					text: "The append-only record of one capture run.",
				}),
			}),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`added\t${dir}/TERMS.md\tProducts (domains)\t18\n`);

		const after = readFileSync(join(dir, "TERMS.md"), "utf8").split("\n");
		expect(after[17]).toBe("| capture ledger | The append-only record of one capture run. | |");
		expect([...after.slice(0, 17), ...after.slice(18)]).toEqual(before.split("\n"));
		rmSync(dir, {recursive: true, force: true});
	});
});

describe("glossary init, against the committed fixture register", () => {
	it("refuses to overwrite the register that is already there", async () => {
		const out = await run(runInit({register: "terms", dir: REGISTERS, json: false, cwd}));
		expect(out.code).toBe(TERM_COLLISION);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`glossary init: ${REGISTERS}/TERMS.md already exists — refusing to overwrite a register.`,
		);
	});
});
