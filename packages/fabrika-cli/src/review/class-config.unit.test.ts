import {describe, expect, it} from "vitest";
import type {ConfigSource} from "../config/document.ts";
import {SHIPPED_GOVERNED_ROOTS} from "../config/keys/governed-roots.ts";
import {type ConfigAt, classConfigOf, uiDerivationLine} from "./class-config.ts";
import {partitionWithUi, shipNamespacesOf, touchesGovernanceRoot} from "./classes.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const text = (config: unknown): ConfigSource => ({_tag: "Text", text: JSON.stringify(config)});
const at = (side: "head" | "base", source: ConfigSource): ConfigAt => ({
	side,
	sha: side === "head" ? HEAD : BASE,
	source,
});
const surface = (name: string, prefix: string, mount: string) => ({
	name,
	prefix,
	mount,
	command: "pnpm dev --port {{port}}",
});
const read = (head: ConfigSource, base: ConfigSource) =>
	classConfigOf("v", "the classes are UNKNOWN.", at("head", head), at("base", base));

describe("classConfigOf", () => {
	it("takes the union of the two commits' roots, prefixes and subsystems, each once", () => {
		const cart = {pattern: "src/**", subsystem: "cart", constraint: "cents"};
		const out = read(
			text({
				governedRoots: ["src/", ".fabrika.jsonc"],
				uiSurfaces: [surface("web", "apps/shop/", "/")],
				reviewSubsystems: [cart],
			}),
			text({
				governedRoots: ["lib/", ".fabrika.jsonc"],
				uiSurfaces: [surface("web", "apps/shop/", "/"), surface("desk", "apps/desk/", "/desk")],
				reviewSubsystems: [cart],
			}),
		);
		expect(out._tag).toBe("Config");
		if (out._tag !== "Config") return;
		expect(out.config.governedRoots).toEqual(["src/", ".fabrika.jsonc", "lib/"]);
		expect(out.config.uiPrefixes).toEqual(["apps/shop/", "apps/desk/"]);
		expect(out.config.subsystems).toEqual([cart]);
	});

	it("reads a commit with no config as that commit's shipped defaults", () => {
		const out = read({_tag: "Absent"}, text({uiSurfaces: [surface("web", "apps/shop/", "/")]}));
		expect(out._tag).toBe("Config");
		if (out._tag !== "Config") return;
		expect(out.config.governedRoots).toEqual(SHIPPED_GOVERNED_ROOTS);
		expect(out.config.uiPrefixes).toEqual(["apps/shop/"]);
		expect(out.config.notes.governedRoots).toContain(`at the head ${HEAD}, the shipped`);
	});

	it("governs a plugin tree only for a repo that declares it — the shipped roots name none", () => {
		const pluginFile = ["claude-plugins/fabrika/skills/ship/SKILL.md"];
		const undeclared = read({_tag: "Absent"}, {_tag: "Absent"});
		const declaring = text({governedRoots: ["claude-plugins/", ".fabrika.jsonc"]});
		const declared = read(declaring, declaring);
		expect([undeclared._tag, declared._tag]).toEqual(["Config", "Config"]);
		if (undeclared._tag !== "Config" || declared._tag !== "Config") return;
		expect(touchesGovernanceRoot(pluginFile, undeclared.config.governedRoots)).toBe(false);
		expect(touchesGovernanceRoot(pluginFile, declared.config.governedRoots)).toBe(true);
	});

	it("refuses naming the commit whose config does not decode, whatever the other says", () => {
		const out = read(text({}), text({governedRoots: []}));
		expect(out).toMatchObject({
			_tag: "Refused",
			reason: expect.stringContaining(`.fabrika.jsonc at the base ${BASE} is refused`),
		});
	});

	it("refuses naming the commit whose config could not be read", () => {
		const out = read({_tag: "Unreadable", reason: "fatal: bad object"}, text({}));
		expect(out._tag).toBe("Refused");
		if (out._tag !== "Refused") return;
		expect(out.message).toBe(
			`v: .fabrika.jsonc at the head ${HEAD} is refused — fatal: bad object, so the classes are UNKNOWN.`,
		);
	});
});

describe("classConfigOf, over screen review", () => {
	const SCREEN = ["apps/shop/page.tsx"];
	const owed = (head: ConfigSource, base: ConfigSource) => {
		const out = read(head, base);
		if (out._tag !== "Config") throw new Error(out.message);
		return {
			config: out.config,
			namespaces: shipNamespacesOf(
				partitionWithUi(SCREEN, out.config.governedRoots, out.config.uiPrefixes),
			),
		};
	};
	const rows = {uiSurfaces: [surface("web", "apps/shop/", "/")]};

	it("owes no review-ui over a screen file at skip, and keeps the text review whole", () => {
		const skip = text({...rows, reviewUi: {mode: "skip"}});
		const {config, namespaces} = owed(skip, skip);
		expect(config.screenReview).toMatchObject({mode: "skip", skippedScreens: ["apps/shop/"]});
		expect(config.uiPrefixes).toEqual([]);
		expect(namespaces).toEqual(["review-code"]);
		expect(uiDerivationLine("v", config)).toContain("v: screen review is not set up");
	});

	it("resolves a repo that declares nothing to skip on both commits", () => {
		const {config, namespaces} = owed({_tag: "Absent"}, text({}));
		expect(config.screenReview).toMatchObject({mode: "skip", skippedScreens: []});
		expect(namespaces).toEqual(["review-code"]);
	});

	it("leaves a repo with rows and no mode owing review-ui, as before the key existed", () => {
		const {config, namespaces} = owed(text(rows), text(rows));
		expect(config.screenReview).toMatchObject({mode: "preview", skippedScreens: []});
		expect(namespaces).toEqual(["review-code", "review-ui"]);
		expect(uiDerivationLine("v", config)).toContain("v: ui derived over 1 prefix(es)");
	});

	it("raises the ui class off a `reviewUi.screens` path, with no row", () => {
		const handCheck = text({reviewUi: {mode: "hand-check", screens: ["apps/shop/"]}});
		const {config, namespaces} = owed(handCheck, handCheck);
		expect(config.screenReview.mode).toBe("hand-check");
		expect(namespaces).toEqual(["review-code", "review-ui"]);
	});

	it("does not let a head switch off the screen review its merge base declares", () => {
		const {config, namespaces} = owed(text({...rows, reviewUi: {mode: "skip"}}), text(rows));
		expect(config.screenReview.mode).toBe("preview");
		expect(namespaces).toEqual(["review-code", "review-ui"]);
	});

	it("judges a head that turns screen review on by the mode it turns on", () => {
		const {config, namespaces} = owed(
			text({reviewUi: {mode: "hand-check", screens: ["apps/shop/"]}}),
			{_tag: "Absent"},
		);
		expect(config.screenReview.mode).toBe("hand-check");
		expect(namespaces).toEqual(["review-code", "review-ui"]);
	});

	it("still says a rules-only repo declares no row, since it is not at skip", () => {
		const rulesOnly = text({reviewUi: {whenNoPreview: [{paths: ["**"], mode: "hand-check"}]}});
		const {config} = owed(rulesOnly, rulesOnly);
		expect(config.screenReview.mode).toBe("preview");
		expect(uiDerivationLine("v", config)).toContain("declares no `uiSurfaces` rows");
	});
});
