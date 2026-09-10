import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {AUDIT_CATALOGS, auditCatalogsKey} from "./audit-catalogs.ts";

const declared = (value: unknown) =>
	resolve(
		loadConfig({_tag: "Text", text: JSON.stringify({[AUDIT_CATALOGS]: value})}),
		auditCatalogsKey,
	);

describe("a repo that declares nothing runs the gate at its shipped coverage", () => {
	it("resolves the empty list for a repo with no config at all", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), auditCatalogsKey);
		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toEqual([]);
	});

	it("resolves the empty list for a config that declares other keys and not this one", () => {
		const resolved = resolve(
			loadConfig({_tag: "Text", text: JSON.stringify({docLeakExempt: ["/CLAUDE.md"]})}),
			auditCatalogsKey,
		);
		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toEqual([]);
	});

	// Empty is the strict answer on a widen-only key, so an explicit `[]` is data, not a disabled
	// gate: the shipped rows are emitted either way.
	it("takes an explicitly declared empty list as declared", () => {
		const resolved = declared([]);
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value).toEqual([]);
	});
});

describe("a declared value is repo-relative markdown paths", () => {
	it("takes the paths the repo wrote, trimmed, in the order written", () => {
		const resolved = declared([" docs/smells.md", "team/extra-smells.md "]);
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value).toEqual(["docs/smells.md", "team/extra-smells.md"]);
	});

	it.each([
		{value: "docs/smells.md", why: "not an array"},
		{value: [42], why: "an entry that is not a string"},
		{value: [""], why: "an empty entry"},
		{value: ["   "], why: "a whitespace-only entry"},
	])("refuses $why, naming the key", ({value}) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(AUDIT_CATALOGS);
	});
});

describe("a path the gate could not read is refused, never repaired", () => {
	it.each([
		{value: ["/etc/smells.md"], fragment: "absolute path"},
		{value: ["../sibling/smells.md"], fragment: "climbs out of the repo"},
		{value: ["docs/smells.txt"], fragment: "not a `.md` file"},
		{value: ["docs/smells.md", "docs/smells.md"], fragment: "twice"},
	])("refuses $value, saying why", ({value, fragment}) => {
		const resolved = declared(value);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(AUDIT_CATALOGS);
		expect(resolved.reason).toContain(fragment);
	});

	// A nested `..` is the same escape as a leading one, and the split-on-slash test is what catches
	// it — a `startsWith("..")` check would not.
	it("refuses a climb buried mid-path", () => {
		const resolved = declared(["docs/../../smells.md"]);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("climbs out of the repo");
	});

	// `..md` ends in `.md` and is still a directory climb; the climb test runs first for that reason.
	it("refuses a climb whose last segment would satisfy the markdown test", () => {
		const resolved = declared(["../smells.md"]);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("climbs out of the repo");
	});
});

describe("the key carries no way to narrow the shipped catalog", () => {
	// Add-only is a property of the decoded shape, not a rule a caller remembers: the value is a
	// list of paths, so there is nothing in it that could name a shipped smell to drop.
	it("decodes to a flat list of paths and nothing else", () => {
		const resolved = declared(["docs/smells.md"]);
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.every((entry) => typeof entry === "string")).toBe(true);
	});

	it("ships an empty default, so no repo inherits another repo's smells", () => {
		expect(auditCatalogsKey.shippedDefault).toEqual([]);
	});

	it("does not refuse the whole load — a bad catalog path disables no gate", () => {
		expect(auditCatalogsKey.refuseLoad).toBeUndefined();
	});
});
