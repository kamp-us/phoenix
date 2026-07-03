import {assert, describe, it} from "@effect/vitest";
import {parseGitLog, GIT_LOG_RECORD_SEP as RS} from "./gitlog.ts";

describe("parseGitLog", () => {
	it("splits records on the RS separator and peels subject from body", () => {
		const blob =
			`feat(a): first subject\nbody line one\nbody line two${RS}` + `fix(b): second subject\n${RS}`;
		const lines = parseGitLog(blob);
		assert.strictEqual(lines.length, 2);
		assert.strictEqual(lines[0]?.subject, "feat(a): first subject");
		assert.strictEqual(lines[0]?.body, "body line one\nbody line two");
		assert.strictEqual(lines[1]?.subject, "fix(b): second subject");
	});

	it("emits no body when a merge has an empty body", () => {
		const blob = `feat(a): subject only\n${RS}`;
		const lines = parseGitLog(blob);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0]?.subject, "feat(a): subject only");
		assert.isUndefined(lines[0]?.body);
	});

	it("keeps a subject with no trailing newline", () => {
		const blob = `feat(a): terse${RS}`;
		const lines = parseGitLog(blob);
		assert.strictEqual(lines[0]?.subject, "feat(a): terse");
	});

	it("skips empty trailing records", () => {
		const blob = `feat(a): one\n${RS}${RS}`;
		assert.strictEqual(parseGitLog(blob).length, 1);
	});

	it("returns [] for an empty blob", () => {
		assert.deepStrictEqual(parseGitLog(""), []);
	});
});
