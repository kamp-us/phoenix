import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs, record} from "../fakes.test-support.ts";
import {type CheckOptions, runCheck} from "./check-verb.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	DIR,
	LANGUAGE_NO_ROWS,
	LANGUAGE_PATH,
	REPO,
	TERMS,
	TERMS_CLEAN,
	TERMS_PATH,
} from "./fixtures.test-support.ts";

const DECISIONS = "/repo/.decisions";

const options: CheckOptions = {
	register: "terms",
	dir: DIR,
	decisions: ".decisions",
	json: false,
	cwd: REPO,
};

const run = (fs: FakeFs, overrides: Partial<CheckOptions> = {}) =>
	Effect.runPromise(Effect.provide(runCheck({...options, ...overrides}), fs.layer));

const withDecisions = (files: Record<string, string | null>, names: ReadonlyArray<string>) =>
	fakeFs({dirs: {[DECISIONS]: [...names]}, files});

const corpus = () =>
	withDecisions(
		{
			[TERMS_PATH]: TERMS,
			[`${DECISIONS}/0044-imge.md`]: record("0044", "superseded by [0144](0144-depo.md)"),
			[`${DECISIONS}/0144-depo.md`]: record("0144", "accepted"),
		},
		["0044-imge.md", "0144-depo.md"],
	);

describe("runCheck", () => {
	it("exits 0 WITH its findings — the informative case is not a failure (#4723)", async () => {
		const out = await run(corpus());
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("defects");
		expect(out.stdout).toContain(
			'duplicate-key\tterms\tProducts (domains)\tpano\talso declared in "Core / shape"',
		);
		expect(out.stdout).toContain(
			'citation-superseded\tterms\tCore / shape\tworker\tcites 0044, status "superseded by [0144](0144-depo.md)"',
		);
	});

	it("decides liveness by the imported predicate, so amended-in-part is not a defect", async () => {
		const io = withDecisions(
			{
				[TERMS_PATH]: TERMS_CLEAN.replace("The internal asset store.", "Cites 0044."),
				[`${DECISIONS}/0044-imge.md`]: record("0044", "amended-in-part by [0144](0144-depo.md)"),
			},
			["0044-imge.md"],
		);
		const out = await run(io);
		expect(out.stdout.split("\n")[0]).toBe("clean");
	});

	it("exits 0 on clean, with the pinned reason on stderr", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS_CLEAN}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("clean\n");
		expect(out.stderr.at(-1)).toBe(
			"glossary check: checked 2 row(s) across 1 register(s); no defect found.",
		);
	});

	it("exits 0 on bootstrap for an absent register", async () => {
		const out = await run(fakeFs({files: {}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("bootstrap\n");
		expect(out.stderr.at(-1)).toContain("bootstrap, not clean");
	});

	// Present-and-empty and absent are different facts and never share a code (ADR 0092).
	it("reds on a register that is present and holds zero rows", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: LANGUAGE_NO_ROWS}}));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`glossary check: ${DIR}/TERMS.md holds 0 rows — refusing to report a clean scan of an empty register (ADR 0092).`,
		);
	});

	it("reports an unresolved decision corpus rather than reporting clean over it", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("citations-unverified\t-\t-\t-\tcannot read .decisions:");
		expect(out.stdout.split("\n")[0]).toBe("defects");
	});

	// #6433: the flag is an override, not the only way to name a corpus.
	it("resolves the corpus from the repo's config when --decisions is absent", async () => {
		const out = await run(corpus(), {decisions: null});
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("cites 0044");
		expect(out.stderr.join("\n")).toContain("citation(s) resolved under .decisions");
	});

	it("leaves citations unverified on a repo that declares it keeps no corpus", async () => {
		const fs = withDecisions(
			{[TERMS_PATH]: TERMS, [`${REPO}/.fabrika.jsonc`]: '{"decisionsDir": null}'},
			[],
		);
		const out = await run(fs, {decisions: null});
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("citations-unverified\t-\t-\t-\t");
		expect(out.stdout).toContain("declines `decisionsDir`");
		// The remedy clause names this verb's own override. `--dir` is the register directory here,
		// so inheriting `adr`'s spelling would send the reader to repoint the registers (#6433).
		expect(out.stdout).toContain("Point --decisions at a corpus to read one anyway.");
		expect(out.stdout).not.toContain("Point --dir");
		// The word a declined corpus must never produce: a dead citation is a claim about a corpus
		// that was read, and this one never was.
		expect(out.stdout).not.toContain("citation-dead");
	});

	it("refuses an unreadable register — the outcome is UNKNOWN, never clean", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}, unreadable: [TERMS_PATH]}));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "clean"');
	});

	it("refuses a malformed term table", async () => {
		const out = await run(
			fakeFs({files: {[TERMS_PATH]: "## S\n\n| Term | Definition | Not |\n| pano | x | |\n"}}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
	});

	it("refuses an off-enum --register", async () => {
		const out = await run(fakeFs({files: {}}), {register: "sozluk"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("reports a key declared in both registers under --register both", async () => {
		const out = await run(
			fakeFs({files: {[TERMS_PATH]: TERMS_CLEAN, [LANGUAGE_PATH]: TERMS_CLEAN}}),
			{register: "both"},
		);
		expect(out.stdout).toContain("cross-register\tlanguage");
	});

	it("carries the counts the outcome is only readable against, in --json", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS_CLEAN}}), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "clean",
			findings: [],
			reason: "checked 2 row(s) across 1 register(s); no defect found",
			scannedRows: 2,
			scannedRegisters: 1,
			citationsResolved: 0,
		});
	});
});
