import {describe, expect, it} from "vitest";
import {errOut, fakeExec, okOut, record, tree} from "../fakes.test-support.ts";
import {BASE_UNFETCHABLE, IN_FLIGHT_UNKNOWN, runResolve, ZERO_SCOPE} from "./resolve-verb.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";
const AMEND_LIST =
	"amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md)";

const base = (overrides: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = []) =>
	fakeExec([
		...overrides,
		[/^git remote$/, okOut("origin\n")],
		[/^git remote get-url origin$/, okOut("https://github.com/kamp-us/phoenix.git\n")],
		[/^git fetch/, okOut("")],
		[/^git rev-parse/, okOut(`${SHA}\n`)],
		[
			/^git ls-tree/,
			okOut(tree("0023-live-views-sse-livedo.md", "0126-ambient.md", "0164-guard.md")),
		],
		[/show .*0023-live-views-sse-livedo\.md$/, okOut(record("0023", AMEND_LIST))],
		[/show .*0126-ambient\.md$/, okOut(record("0126", "accepted"))],
		[/show .*0164-guard\.md$/, okOut(record("0164", "proposed"))],
		[/^gh api --paginate repos\/[^ ]+\/pulls\?/, okOut("4711\n")],
		[/pulls\/4711\/files/, okOut("added\t.decisions/0239-campaign-milestones.md\n")],
	]);

const options = {ids: ["0164"], dir: ".decisions", base: "origin/main", repo: null, json: false};

describe("runResolve", () => {
	it("splits presence from authority: a proposed record is landed, not live", () => {
		const out = runResolve(base(), options);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("landed\t0164-guard.md\tproposed\n");
	});

	it("reports an accepted record as live", () => {
		expect(runResolve(base(), {...options, ids: ["0126"]}).stdout).toBe(
			"live\t0126-ambient.md\taccepted\n",
		);
	});

	it("carries the status verbatim, inline amend links and all", () => {
		expect(runResolve(base(), {...options, ids: ["0023"]}).stdout).toBe(
			`live\t0023-live-views-sse-livedo.md\t${AMEND_LIST}\n`,
		);
	});

	it("reports an id only an open pull request carries as in-flight, with its PR number", () => {
		expect(runResolve(base(), {...options, ids: ["0239"]}).stdout).toBe(
			"in-flight\t0239-campaign-milestones.md\tPR #4711\n",
		);
	});

	it("reports a proven-absent id as absent, on exit 0", () => {
		const out = runResolve(base(), {...options, ids: ["0240"]});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("absent\t-\t-\n");
	});

	it("answers one line per id, in argument order", () => {
		expect(runResolve(base(), {...options, ids: ["0164", "0240"]}).stdout).toBe(
			"landed\t0164-guard.md\tproposed\nabsent\t-\t-\n",
		);
	});

	it("--json is an array so one id and many ids parse identically", () => {
		const one = JSON.parse(runResolve(base(), {...options, json: true}).stdout);
		expect(Array.isArray(one)).toBe(true);
		expect(one).toEqual([
			{
				id: "0164",
				state: "landed",
				file: "0164-guard.md",
				detail: "proposed",
				baseRef: "origin/main",
				baseSha: SHA,
			},
		]);
	});

	it("refuses an unfetchable base — every state is UNKNOWN, never absent", () => {
		const out = runResolve(
			base([[/^git fetch/, errOut("fatal: couldn't find remote ref nonexistent")]]),
			{
				...options,
				base: "origin/nonexistent",
			},
		);
		expect(out.code).toBe(BASE_UNFETCHABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			'adr resolve: cannot fetch origin/nonexistent: fatal: couldn\'t find remote ref nonexistent — every state is UNKNOWN, never "absent".',
		);
	});

	it("refuses when the open pull requests cannot be enumerated — absent is indistinguishable from in-flight", () => {
		const out = runResolve(
			base([[/^gh api --paginate repos\/[^ ]+\/pulls\?/, errOut("HTTP 404")]]),
			options,
		);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("indistinguishable from");
	});

	it("refuses on zero scope", () => {
		const out = runResolve(base([[/^git ls-tree/, okOut("")]]), options);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("refuses an id that is not four zero-padded digits", () => {
		const out = runResolve(base(), {...options, ids: ["0034a"]});
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toBe('adr resolve: id "0034a" is not four zero-padded digits.');
	});

	it("refuses when a requested record cannot be read at the base ref", () => {
		const out = runResolve(
			base([[/show .*0164-guard\.md$/, errOut("fatal: path does not exist")]]),
			options,
		);
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("refuses two records claiming one id rather than picking one", () => {
		const out = runResolve(
			base([[/^git ls-tree/, okOut(tree("0164-a.md", "0164-b.md"))]]),
			options,
		);
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("holds two records for id 0164");
	});
});
