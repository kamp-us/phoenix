/**
 * `status settings` in-process: which provenance every arm of the config surface renders, and that
 * a key nobody could resolve never renders as the default it did not resolve to.
 */
import {describe, expect, it} from "vitest";
import type {ConfigSource} from "../config/document.ts";
import {CAP_CLEAR_AUTHORS} from "../config/keys/cap-clear-authors.ts";
import {GOVERNED_ROOTS, SHIPPED_GOVERNED_ROOTS} from "../config/keys/governed-roots.ts";
import {SURFACE_DISPOSITIONS, SURFACE_REGISTRY} from "../config/keys/surface-dispositions.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {readNow} from "./fields.ts";
import {runSettings, type SettingRow, settingRows, UNKNOWN_VALUE} from "./settings-verb.ts";

const AS_OF = readNow("2026-08-18T00:00:00Z");

const run = (source: ConfigSource, json = false, surfaces = false) =>
	runSettings({source, rows: settingRows(source), asOf: AS_OF, json, surfaces});

const rowFor = (rows: ReadonlyArray<SettingRow>, key: string): SettingRow => {
	const found = rows.find((one) => one.key === key);
	if (found === undefined) throw new Error(`no row for ${key}`);
	return found;
};

describe("settingRows", () => {
	it("resolves every key to its shipped default when the repo wrote no config", () => {
		const rows = settingRows({_tag: "Absent"});
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((one) => one.provenance === "default")).toBe(true);
		const roots = rowFor(rows, GOVERNED_ROOTS);
		expect(roots.provenance === "default" && roots.value).toEqual(SHIPPED_GOVERNED_ROOTS);
	});

	it("marks a key the repo wrote `declared` and leaves its siblings on the default", () => {
		const rows = settingRows({
			_tag: "Text",
			text: `{
				// the roots this repo governs
				"${GOVERNED_ROOTS}": [".decisions/", ".fabrika.jsonc"]
			}`,
		});
		const roots = rowFor(rows, GOVERNED_ROOTS);
		expect(roots.provenance).toBe("declared");
		expect(roots.provenance === "declared" && roots.value).toEqual([
			".decisions/",
			".fabrika.jsonc",
		]);
		expect(rows.filter((one) => one.provenance === "default").length).toBe(rows.length - 1);
	});

	it("renders every key unknown when the file exists and could not be read", () => {
		const rows = settingRows({_tag: "Unreadable", reason: "EISDIR: illegal operation"});
		expect(rows.every((one) => one.provenance === "unknown")).toBe(true);
		expect(rows.every((one) => one.detail.includes("EISDIR"))).toBe(true);
	});

	it("renders every key unknown when a load refusal names one of them", () => {
		const rows = settingRows({_tag: "Text", text: `{"${GOVERNED_ROOTS}": [".decisions/"]}`});
		expect(rows.every((one) => one.provenance === "unknown")).toBe(true);
		expect(rows.every((one) => one.detail.includes("cannot un-govern itself"))).toBe(true);
	});

	it("prints a decoded value back in the spelling the file carries", () => {
		const rows = settingRows({
			_tag: "Text",
			text: `{"${CAP_CLEAR_AUTHORS}": ["@usirin", "@kamp-us/founders"]}`,
		});
		const authors = rowFor(rows, CAP_CLEAR_AUTHORS);
		expect(authors.provenance === "declared" && authors.value).toEqual([
			"@usirin",
			"@kamp-us/founders",
		]);
	});

	it("renders a declared value the surface refuses as unknown, not as the default", () => {
		const rows = settingRows({_tag: "Text", text: `{"${GOVERNED_ROOTS}": "one root"}`});
		const roots = rowFor(rows, GOVERNED_ROOTS);
		expect(roots.provenance).toBe("unknown");
		expect(roots).not.toHaveProperty("value");
	});
});

describe("runSettings", () => {
	it("prints the full default set at exit 0 on a repo with no config", () => {
		const outcome = run({_tag: "Absent"});
		expect(outcome.code).toBe(0);
		const lines = outcome.stdout.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^settings\tresolved\t\d+\t0\t0\t2026-08-18T00:00:00Z$/);
		expect(lines.length).toBe(settingRows({_tag: "Absent"}).length + 1);
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
			source: {_tag: "Absent"},
			rows: [],
			asOf: AS_OF,
			json: false,
			surfaces: false,
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stdout).toBe("");
	});
});

describe("runSettings --surfaces", () => {
	it("prints one row per registered surface, each carrying what the surface is", () => {
		const outcome = run({_tag: "Absent"}, false, true);
		expect(outcome.code).toBe(0);
		const surfaces = outcome.stdout
			.trimEnd()
			.split("\n")
			.filter((one) => one.startsWith("surface\t"));
		expect(surfaces.length).toBe(SURFACE_REGISTRY.length);
		for (const one of surfaces) {
			const [, id, disposition, note] = one.split("\t");
			expect(id).toBeTruthy();
			expect(["fail-loud", "degrade", "bootstrap"]).toContain(disposition);
			expect((note ?? "").length).toBeGreaterThan(0);
		}
	});

	it("relays the whole note, never a clamped one — the note IS the answer here", () => {
		const outcome = run({_tag: "Absent"}, false, true);
		const longest = [...SURFACE_REGISTRY].sort((a, b) => b.note.length - a.note.length)[0];
		expect(outcome.stdout).toContain(`surface\t${longest?.id}\t`);
		expect(outcome.stdout).toContain(longest?.note ?? "");
	});

	it("prints the disposition this repo declared, not the one the registry ships", () => {
		const outcome = run(
			{_tag: "Text", text: `{"${SURFACE_DISPOSITIONS}": {"design-manifest": "degrade"}}`},
			false,
			true,
		);
		expect(outcome.stdout).toContain("surface\tdesign-manifest\tdegrade\t");
	});

	it("appends nothing when --surfaces was not passed", () => {
		expect(run({_tag: "Absent"}).stdout).not.toContain("\nsurface\t");
	});

	it("carries the surfaces under --json only when they were asked for", () => {
		const asked = JSON.parse(run({_tag: "Absent"}, true, true).stdout) as {
			surfaces?: ReadonlyArray<{id: string; note: string}>;
		};
		expect(asked.surfaces?.length).toBe(SURFACE_REGISTRY.length);
		expect(JSON.parse(run({_tag: "Absent"}, true).stdout)).not.toHaveProperty("surfaces");
	});

	it("has no surface rows to print when the key did not resolve — the readout is the refusal", () => {
		const outcome = run(
			{_tag: "Text", text: `{"${SURFACE_DISPOSITIONS}": ["design-manifest"]}`},
			false,
			true,
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
