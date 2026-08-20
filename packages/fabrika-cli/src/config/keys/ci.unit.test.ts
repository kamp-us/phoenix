import {describe, expect, it} from "vitest";
import {producerFor} from "../ci-producer.ts";
import {loadConfig, resolve} from "../load.ts";
import {CI, ciKey, SHIPPED_CI} from "./ci.ts";

const declared = (config: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[CI]: config})}), ciKey);

describe("the shipped default is phoenix's CI surface", () => {
	it("resolves refuse and ci.yml for a repo with no config at all", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), ciKey);
		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value).toEqual({noProducer: "refuse", gateWorkflow: "ci.yml"});
	});

	it("falls to the shipped value for each sub-key the repo leaves out", () => {
		const resolved = declared({noProducer: "degrade"});
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.gateWorkflow).toBe(SHIPPED_CI.gateWorkflow);
	});
});

describe("an off-vocabulary or malformed value is refused at load", () => {
	it("refuses a noProducer outside refuse | degrade", () => {
		const resolved = declared({noProducer: "ignore"});
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not one of refuse, degrade");
	});

	it.each([null, 3, ["refuse"]])("refuses a non-string noProducer (%p)", (value) => {
		expect(declared({noProducer: value})._tag).toBe("Malformed");
	});

	it("refuses a sub-key this module does not own, rather than dropping it", () => {
		const resolved = declared({noProducerr: "degrade"});
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("is not a CI setting");
	});

	it("refuses a gateWorkflow given as a path — a silently-basenamed value is a false accept", () => {
		const resolved = declared({gateWorkflow: ".github/workflows/build.yml"});
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("bare workflow filename");
	});

	it("refuses an empty gateWorkflow", () => {
		expect(declared({gateWorkflow: "  "})._tag).toBe("Malformed");
	});

	it("takes a bare filename", () => {
		const resolved = declared({gateWorkflow: "build.yml"});
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.gateWorkflow).toBe("build.yml");
	});
});

describe("producerFor", () => {
	const at = (workflows: number, config: unknown) =>
		producerFor("verb", "o/r", workflows, declared(config));

	it("is Present on any workflow at all — existence is the whole test", () => {
		expect(at(1, {})._tag).toBe("Present");
		expect(at(1, {noProducer: "degrade"})._tag).toBe("Present");
	});

	it("refuses zero workflows under the shipped default", () => {
		const answer = at(0, {});
		expect(answer._tag).toBe("Refused");
		if (answer._tag !== "Refused") return;
		expect(answer.reason).toContain("zero workflows — no CI producer");
	});

	it("reports the fact, never a green, under degrade", () => {
		const answer = at(0, {noProducer: "degrade"});
		expect(answer._tag).toBe("OptedOut");
		if (answer._tag !== "OptedOut") return;
		expect(answer.note).not.toContain("green");
	});

	it("is Unknown on a config that never decoded — never the shipped default", () => {
		expect(at(0, {noProducer: "ignore"})._tag).toBe("Unknown");
	});

	it("is Unknown on a config nobody could read", () => {
		const unreadable = resolve(loadConfig({_tag: "Unreadable", reason: "EACCES"}), ciKey);
		expect(producerFor("verb", "o/r", 0, unreadable)._tag).toBe("Unknown");
	});
});
