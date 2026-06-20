import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (verb: string, input: unknown): Promise<RunResult> =>
	new Promise((resolve) => {
		const child = execFile("node", [BIN, verb], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
		child.stdin?.end(JSON.stringify(input));
	});

const SCHEMA = {required: ["issue", "prUrl", "notes"]};
const OK = {issue: 742, prUrl: "u", notes: "n"};
const BAD = {issue: 742};

describe("decide CLI — exit-code routing", () => {
	it("exits 0 (accept) on a conforming payload", async () => {
		const {code} = await run("decide", {payload: OK, schema: SCHEMA, retryCount: 0});
		assert.strictEqual(code, 0);
	}, 30_000);

	it("exits 2 (retry) on a miss with budget remaining, carrying the rich diff", async () => {
		const {code, stdout} = await run("decide", {payload: BAD, schema: SCHEMA, retryCount: 0});
		assert.strictEqual(code, 2);
		assert.include(stdout, "prUrl");
		assert.include(stdout, "notes");
	}, 30_000);

	it("exits 1 (fail) on a miss at the cap", async () => {
		const {code} = await run("decide", {payload: BAD, schema: SCHEMA, retryCount: 2});
		assert.strictEqual(code, 1);
	}, 30_000);
});

describe("prompt CLI — schema section", () => {
	it("renders the schema section with every required field", async () => {
		const {code, stdout} = await run("prompt", {schema: SCHEMA, example: OK});
		assert.strictEqual(code, 0);
		assert.include(stdout, "issue");
		assert.include(stdout, "prUrl");
		assert.include(stdout, "StructuredOutput");
	}, 30_000);
});
