import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {afterEach, assert, describe, it} from "@effect/vitest";
import {resumeFolder} from "./AgentSessionHost.ts";

const dirs: Array<string> = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/** A stored session file whose header carries exactly the fields given, opened the way `resume` opens it. */
const storedHeader = (header: Record<string, unknown>) => {
	const dir = mkdtempSync(join(tmpdir(), "tuval-pi-resume-"));
	dirs.push(dir);
	const file = join(dir, "session.jsonl");
	const entry = {
		type: "session",
		version: 3,
		id: "s-1",
		timestamp: "2026-09-26T00:00:00.000Z",
		...header,
	};
	writeFileSync(file, `${JSON.stringify(entry)}\n`);
	return SessionManager.open(file, dir).getHeader();
};

describe("resumeFolder", () => {
	it("resumes in the folder the header records, not the host's project root", () => {
		const header = storedHeader({cwd: "/work/phoenix"});
		assert.strictEqual(resumeFolder(header, "/work/other"), "/work/phoenix");
		assert.strictEqual(resumeFolder(header, undefined), "/work/phoenix");
	});

	it("falls back to the host's project root when the header records no folder, never the process cwd", () => {
		const header = storedHeader({});
		assert.strictEqual(resumeFolder(header, "/work/phoenix"), "/work/phoenix");
		assert.notStrictEqual(resumeFolder(header, "/work/phoenix"), process.cwd());
	});

	it("refuses with no folder when the header records none and the host holds no project root", () => {
		assert.isUndefined(resumeFolder(storedHeader({}), undefined));
		assert.isUndefined(resumeFolder(storedHeader({cwd: ""}), ""));
		assert.isUndefined(resumeFolder(null, undefined));
	});
});
