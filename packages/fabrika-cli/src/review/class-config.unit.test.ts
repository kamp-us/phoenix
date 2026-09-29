import {describe, expect, it} from "vitest";
import type {ConfigSource} from "../config/document.ts";
import {SHIPPED_GOVERNED_ROOTS} from "../config/keys/governed-roots.ts";
import {type ConfigAt, classConfigOf} from "./class-config.ts";

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
