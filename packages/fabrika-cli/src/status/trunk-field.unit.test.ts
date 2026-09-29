import {describe, expect, it} from "vitest";
import {fail, ok} from "../io/git.ts";
import {trunkNamed} from "../io/trunk.ts";
import {readNow} from "./fields.ts";
import {trunkField, UNKNOWN} from "./open-verb.ts";

const AS_OF = readNow("2026-09-29T09:00:00Z");
const DEV = trunkNamed("dev");

const resolved = (originHead: ReturnType<typeof ok<string | null>> | ReturnType<typeof fail>) =>
	trunkField({_tag: "Resolved", repo: "o/r", trunk: DEV, originHead}, AS_OF);

describe("status open's trunk field", () => {
	it("reports the resolved trunk and that origin/HEAD agrees", () => {
		const field = resolved(ok("dev"));
		expect(field.state).toBe("agrees");
		expect(field.detail).toContain("origin/dev");
		expect(field.source).toBe("o/r");
	});

	it("flags a clone whose origin/HEAD names another branch, with the fix", () => {
		const field = resolved(ok("main"));
		expect(field.state).toBe("drifted");
		expect(field.detail).toContain("origin/dev");
		expect(field.detail).toContain("names main");
		expect(field.detail).toContain("git remote set-head origin --auto");
	});

	it("flags a clone that records no origin/HEAD as unset — proven, not unknown", () => {
		expect(resolved(ok(null)).state).toBe("unset");
	});

	it("is unknown when this clone's origin/HEAD cannot be read", () => {
		expect(resolved(fail("git is not there")).state).toBe(UNKNOWN);
	});

	it("is unknown, never a trunk name, when the trunk itself cannot be resolved", () => {
		const field = trunkField({_tag: "Failed", repo: "o/r", reason: "no GitHub token"}, AS_OF);
		expect(field.state).toBe(UNKNOWN);
		expect(field.detail).toContain("no GitHub token");
	});
});
