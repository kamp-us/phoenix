import {describe, expect, it} from "vitest";
import {loadConfig} from "./load.ts";
import {unusableReason} from "./unusable.ts";

const text = (value: unknown) => loadConfig({_tag: "Text", text: JSON.stringify(value)});

describe("unusableReason", () => {
	it("answers null for an absent file, which is the shipped-defaults case", () => {
		expect(unusableReason(loadConfig({_tag: "Absent"}))).toBeNull();
	});

	it("answers null for a config every key decodes", () => {
		expect(unusableReason(text({docLeakExempt: [], governedRoots: ["."]}))).toBeNull();
	});

	it("relays a load-time refusal in the refusing key's own words", () => {
		const reason = unusableReason(text({governedRoots: ["src/"]}));
		expect(reason).toContain("governedRoots");
		expect(reason).toContain("un-govern itself");
	});

	it("refuses an unreadable file, and says so rather than naming a key", () => {
		const reason = unusableReason(
			loadConfig({_tag: "Unreadable", reason: "/repo/.fabrika.jsonc: EACCES"}),
		);
		expect(reason).toBe("it could not be read — /repo/.fabrika.jsonc: EACCES");
	});

	it("refuses a document that is not a JSON object", () => {
		expect(unusableReason(loadConfig({_tag: "Text", text: "[1, 2]"}))).toContain(
			"not a JSON object",
		);
	});

	it("refuses a key no decoder accepted, in that key's words", () => {
		const reason = unusableReason(text({triageFacets: "garbage"}));
		expect(reason).toBe("`triageFacets` is not an array");
	});

	it("refuses a malformed key that is not the one carrying refuseLoad", () => {
		expect(unusableReason(text({docLeakExempt: [7]}))).toContain("docLeakExempt");
	});
});
