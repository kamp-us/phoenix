/**
 * `status settings` in-process: which provenance every arm of the config surface renders, and that
 * a key nobody could resolve never renders as the default it did not resolve to.
 */
import {mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {ConfigSource} from "../config/document.ts";
import {CAP_CLEAR_AUTHORS} from "../config/keys/cap-clear-authors.ts";
import {GOVERNED_ROOTS, SHIPPED_GOVERNED_ROOTS} from "../config/keys/governed-roots.ts";
import {PARK_CAUSE} from "../config/keys/park-cause.ts";
import {REVIEW_UI} from "../config/keys/review-ui.ts";
import type {ConfigLayers} from "../config/load.ts";
import {readConfigLayers} from "../config/source.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {readNow} from "./fields.ts";
import {
	runSettings,
	SCREEN_REVIEW_ROW,
	type SettingRow,
	settingRows,
	UNKNOWN_VALUE,
} from "./settings-verb.ts";

const AS_OF = readNow("2026-08-18T00:00:00Z");

/** The tracked file alone — the shape every case below that says nothing about a machine takes. */
const tracked = (source: ConfigSource): ConfigLayers => ({
	tracked: source,
	local: {_tag: "Absent"},
});

const run = (source: ConfigSource, json = false) =>
	runSettings({
		layers: tracked(source),
		rows: settingRows(tracked(source)),
		asOf: AS_OF,
		json,
	});

const rowFor = (rows: ReadonlyArray<SettingRow>, key: string): SettingRow => {
	const found = rows.find((one) => one.key === key);
	if (found === undefined) throw new Error(`no row for ${key}`);
	return found;
};

describe("settingRows", () => {
	it("resolves every key to its shipped default when the repo wrote no config", () => {
		const rows = settingRows(tracked({_tag: "Absent"}));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((one) => one.provenance === "default")).toBe(true);
		const roots = rowFor(rows, GOVERNED_ROOTS);
		expect(roots.provenance === "default" && roots.value).toEqual(SHIPPED_GOVERNED_ROOTS);
	});

	it("marks a key the repo wrote `declared` and leaves its siblings on the default", () => {
		const rows = settingRows(
			tracked({
				_tag: "Text",
				text: `{
				// the roots this repo governs
				"${GOVERNED_ROOTS}": ["docs/adr/", ".fabrika.jsonc"]
			}`,
			}),
		);
		const roots = rowFor(rows, GOVERNED_ROOTS);
		expect(roots.provenance).toBe("declared");
		expect(roots.provenance === "declared" && roots.value).toEqual(["docs/adr/", ".fabrika.jsonc"]);
		expect(rows.filter((one) => one.provenance === "default").length).toBe(rows.length - 1);
	});

	// A driver reads whose park a spent repair budget is here, without opening the config file.
	it("prints parkCause's resolved spent-budget route, shipped and declared", () => {
		const shipped = rowFor(settingRows(tracked({_tag: "Absent"})), PARK_CAUSE);
		expect(shipped.provenance === "default" && shipped.value).toMatchObject({
			repairBudgetSpent: "driver",
		});

		const declared = rowFor(
			settingRows(
				tracked({_tag: "Text", text: `{"${PARK_CAUSE}": {"repairBudgetSpent": "founder"}}`}),
			),
			PARK_CAUSE,
		);
		expect(declared.provenance === "declared" && declared.value).toMatchObject({
			repairBudgetSpent: "founder",
		});
		expect(
			run({_tag: "Text", text: `{"${PARK_CAUSE}": {"repairBudgetSpent": "founder"}}`}).stdout,
		).toContain('"repairBudgetSpent":"founder"');
	});

	it("renders every key unknown when the file exists and could not be read", () => {
		const rows = settingRows(tracked({_tag: "Unreadable", reason: "EISDIR: illegal operation"}));
		expect(rows.every((one) => one.provenance === "unknown")).toBe(true);
		expect(rows.every((one) => one.detail.includes("EISDIR"))).toBe(true);
	});

	it("renders every key unknown when a load refusal names one of them", () => {
		const rows = settingRows(tracked({_tag: "Text", text: `{"${GOVERNED_ROOTS}": ["docs/adr/"]}`}));
		expect(rows.every((one) => one.provenance === "unknown")).toBe(true);
		expect(rows.every((one) => one.detail.includes("cannot un-govern itself"))).toBe(true);
	});

	it("prints a decoded value back in the spelling the file carries", () => {
		const rows = settingRows(
			tracked({
				_tag: "Text",
				text: `{"${CAP_CLEAR_AUTHORS}": ["@octocat", "@acme/founders"]}`,
			}),
		);
		const authors = rowFor(rows, CAP_CLEAR_AUTHORS);
		expect(authors.provenance === "declared" && authors.value).toEqual([
			"@octocat",
			"@acme/founders",
		]);
	});

	it("renders a declared value the surface refuses as unknown, not as the default", () => {
		const rows = settingRows(tracked({_tag: "Text", text: `{"${GOVERNED_ROOTS}": "one root"}`}));
		const roots = rowFor(rows, GOVERNED_ROOTS);
		expect(roots.provenance).toBe("unknown");
		expect(roots).not.toHaveProperty("value");
	});
});

/** The one derived row: what screen review resolves to, which no single key can say. */
describe("the reviewUi.mode row", () => {
	const ROW = {name: "web", prefix: "src/", mount: "/", command: "pnpm dev --port {{port}}"};
	const modeOf = (config: Record<string, unknown> | null) =>
		rowFor(
			settingRows(
				tracked(config === null ? {_tag: "Absent"} : {_tag: "Text", text: JSON.stringify(config)}),
			),
			SCREEN_REVIEW_ROW,
		);

	it("prints skip as a default for a repo that declares nothing", () => {
		for (const config of [null, {}, {uiSurfaces: []}]) {
			expect(modeOf(config)).toMatchObject({provenance: "default", value: "skip"});
		}
		expect(modeOf(null).detail).toContain("screen review is not set up");
	});

	it("prints preview as a default for a repo that declares rows or rules and no mode", () => {
		expect(modeOf({uiSurfaces: [ROW]})).toMatchObject({provenance: "default", value: "preview"});
		expect(
			modeOf({reviewUi: {whenNoPreview: [{paths: ["**"], mode: "hand-check"}]}}),
		).toMatchObject({provenance: "default", value: "preview"});
	});

	it.each(["preview", "hand-check", "skip"])("prints a declared %s as declared", (mode) => {
		expect(modeOf({uiSurfaces: [ROW], reviewUi: {mode}})).toMatchObject({
			provenance: "declared",
			layer: "tracked",
			value: mode,
		});
	});

	it("sits directly under the reviewUi row, on the line grammar", () => {
		const outcome = run({_tag: "Text", text: JSON.stringify({reviewUi: {mode: "hand-check"}})});
		expect(outcome.code).toBe(0);
		const lines = outcome.stdout.trimEnd().split("\n");
		const at = lines.findIndex((one) => one.startsWith(`setting\t${REVIEW_UI}\t`));
		expect(lines[at + 1]).toMatch(/^setting\treviewUi\.mode\tdeclared\t"hand-check"\t/);
	});

	it("refuses a value outside the three in one sentence naming the allowed ones, and prints no row for it", () => {
		const source: ConfigSource = {_tag: "Text", text: '{"reviewUi": {"mode": "off"}}'};
		const outcome = run(source);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(
			'"reviewUi.mode" is "off", not one of preview, hand-check, skip',
		);
		expect(settingRows(tracked(source)).some((one) => one.key === SCREEN_REVIEW_ROW)).toBe(false);
	});
});

describe("runSettings", () => {
	it("prints the full default set at exit 0 on a repo with no config", () => {
		const outcome = run({_tag: "Absent"});
		expect(outcome.code).toBe(0);
		const lines = outcome.stdout.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^settings\tresolved\t\d+\t0\t0\t2026-08-18T00:00:00Z$/);
		expect(lines.length).toBe(settingRows(tracked({_tag: "Absent"})).length + 1);
		for (const one of lines.slice(1)) expect(one).toMatch(/^setting\t\S+\tdefault\t/);
	});

	it("refuses on 11 with NOTHING on stdout when the config could not be read", () => {
		const outcome = run({_tag: "Unreadable", reason: "EACCES: permission denied"});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.some((one) => one.includes("resolve UNKNOWN"))).toBe(true);
		expect(
			outcome.stderr
				.filter((one) => one.startsWith(`setting\t`))
				.every((one) => one.includes(`\tunknown\t${UNKNOWN_VALUE}\t`)),
		).toBe(true);
	});

	it("never prints a resolved row beside a refusal", () => {
		const outcome = run({_tag: "Unreadable", reason: "EACCES"});
		expect(outcome.stderr.some((one) => one.includes("\tdefault\t"))).toBe(false);
	});

	it("emits the result object under --json, values decoded rather than re-stringified", () => {
		const outcome = run({_tag: "Absent"}, true);
		expect(outcome.code).toBe(0);
		const parsed = JSON.parse(outcome.stdout) as {
			outcome: string;
			settings: ReadonlyArray<{key: string; provenance: string; value: unknown; asOfKind: string}>;
		};
		expect(parsed.outcome).toBe("resolved");
		const roots = parsed.settings.find((one) => one.key === GOVERNED_ROOTS);
		expect(roots?.provenance).toBe("default");
		expect(roots?.value).toEqual(SHIPPED_GOVERNED_ROOTS);
		expect(roots?.asOfKind).toBe("read-now");
	});

	it("refuses zero scope rather than answering over an empty config surface", () => {
		const outcome = runSettings({
			layers: tracked({_tag: "Absent"}),
			rows: [],
			asOf: AS_OF,
			json: false,
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stdout).toBe("");
	});
});

/**
 * The two arms that turn on what a real directory holds, read off one through the adapter's own
 * reader. The unreadable case is a **directory** named `.fabrika.jsonc` rather than a chmod'd file:
 * `EISDIR` is raised for every user, where a permission bit is not a fault for root and the case
 * would silently pass as `Absent` in a container that runs as one.
 */
describe("runSettings over a real directory", () => {
	let base = "";

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "fabrika-settings-"));
		mkdirSync(join(base, "no-file"));
		mkdirSync(join(base, "unreadable", ".fabrika.jsonc"), {recursive: true});
	});

	afterAll(() => {
		if (base !== "") rmSync(base, {recursive: true, force: true});
	});

	const settingsAt = (root: string) =>
		Effect.runPromise(
			Effect.provide(
				Effect.map(readConfigLayers(root), (layers) =>
					runSettings({
						layers,
						rows: settingRows(layers),
						asOf: AS_OF,
						json: false,
					}),
				),
				NodeServices.layer,
			),
		);

	it("prints the full default set at exit 0 where no config was written", async () => {
		const outcome = await settingsAt(join(base, "no-file"));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout.split("\n")[0]).toMatch(/^settings\tresolved\t\d+\t0\t0\t/);
		expect(outcome.stdout).toMatch(/^setting\tgovernedRoots\tdefault\t/m);
		expect(outcome.stdout).not.toContain("\tdeclared\t");
	});

	it("refuses on 11 with NOTHING on stdout when the config exists and cannot be read", async () => {
		const outcome = await settingsAt(join(base, "unreadable"));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("resolve UNKNOWN");
		expect(outcome.stderr.join("\n")).toMatch(/^setting\tgovernedRoots\tunknown\tUNKNOWN\t/m);
	});
});
