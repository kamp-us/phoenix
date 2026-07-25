import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";
import {CONTROL_PLANE_RE} from "../control-plane-paths/control-plane-re.ts";
import {CODEOWNERS_PATH, FORMATS_PATH} from "./gate.ts";

// The `codeowners-cp: ` stderr prefix is applied by the COMMAND wiring, not the gate, so it is
// only observable over the real bin — a unit test of the gate reason cannot see it. It was
// silently dropped when the guard moved to the shared fail handler (#3868 review).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

const makeZeroOwnerRepo = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "codeowners-cp-prefix-"));
	const write = (rel: string, content: string) => {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), {recursive: true});
		writeFileSync(p, content, "utf8");
	};
	write(FORMATS_PATH, `CONTROL_PLANE_RE='${CONTROL_PLANE_RE}'`);
	write(CODEOWNERS_PATH, "# only comments\n");
	return dir;
};

describe("codeowners-cp check — the report keeps its tool-name prefix", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("prefixes the stderr report with `codeowners-cp: ` and still exits 1", () => {
		const dir = makeZeroOwnerRepo();
		try {
			const r = spawnSync("node", [BIN, "codeowners-cp", "check", "--root", dir], {
				encoding: "utf8",
			});
			expect(r.stderr).toContain("codeowners-cp: ");
			expect(r.stderr).toContain("ZERO owned entries");
			expect(r.status).toBe(1);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
