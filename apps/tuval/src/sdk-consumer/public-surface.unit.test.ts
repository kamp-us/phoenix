/**
 * The consumer's proof for #8943: a module that reaches the authoring API only through the package
 * specifiers `packages/tuval/package.json` declares — no relative path into `src/` anywhere below
 * this docblock — can write a program, declare a shaped arg, and fill it with a shipped session row.
 *
 * It lives in the app rather than in `@kampus/tuval-sdk` because it fills the arg with the Claude
 * and Codex rows, which are their harness packages' (`@kampus/tuval-claude`, `@kampus/tuval-codex`),
 * and the SDK depends on no harness. Node and Vite resolve
 * `@kampus/tuval-sdk/authoring` through the SDK's own `name` + `exports`, walking the same map an
 * outside consumer walks, so a subpath missing from the map fails here exactly as it would fail
 * there. `tsc` over this file is the other half — the door has to be typed, not just resolvable.
 *
 * It stays small on purpose. What each authored field *does* is pinned next door
 * (`define-program.unit.test.ts`, `args.unit.test.ts`, `shape.unit.test.ts`); this file pins only
 * that the names arrive, and that the map opens no door onto a module that is not there.
 */

import {execFileSync} from "node:child_process";
import {readFileSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, resolve} from "node:path";
import {ClientId, claudeSession, WorkspaceId} from "@kampus/tuval-claude";
import {codexSession} from "@kampus/tuval-codex";
import {
	PromptPayloadSchema,
	type TurnResult,
	TurnResultSchema,
} from "@kampus/tuval-sdk/ai-agent/ports";
import {
	type Answer,
	type AnyProgram,
	type ArrivalEvent,
	defineProgram,
	emit,
	Program,
	port,
	programArgs,
	type Reply,
	type ShapeSource,
	send,
	spawn,
	stop,
	testProgram,
} from "@kampus/tuval-sdk/authoring";
import {Schema} from "effect";
import {describe, expect, it} from "vitest";

/** What the program below asks of the thing it starts, declared over the shared payload vocabulary. */
const agent = Program.shape({in: {prompt: PromptPayloadSchema}, out: {result: TurnResultSchema}});

const args = programArgs("outside-program", {worker: agent});

type State = {readonly asked: string | null; readonly answer: string | null};

const outsideProgram = {
	id: "outside-program",
	ports: {ask: port.in(Schema.String), said: port.out(Schema.String)},
	args,
	init: (): State => ({asked: null, answer: null}),
	update: {
		ask: (s: State, e: ArrivalEvent<"ask", string>): Answer<State> => [
			{...s, asked: e.payload},
			[spawn(args.worker, {on: {result: "result"}})],
		],
		result: (s: State, e: Reply<"result", TurnResult>): Answer<State> => [
			{...s, answer: e.payload.text},
			[emit("said", e.payload.text)],
		],
	},
	commands: {ask: {args: Schema.String, run: (q: string) => send("ask", q)}},
	title: (s: State) => (s.asked === null ? "outside" : `outside · ${s.asked}`),
};

const outside = (fill: {readonly worker: ShapeSource}): AnyProgram =>
	defineProgram({...outsideProgram, fill, label: `outside (${fill.worker.id})`});

const scope = {
	workspace: WorkspaceId.make("tuval/test"),
	client: ClientId.make("tuval/test"),
};

describe("a consumer outside src/ reaches the authoring API through the package specifier", () => {
	it("writes a program and drives it with testProgram, importing nothing by relative path", () => {
		const run = testProgram(outsideProgram)
			.send("ask", "what changed?")
			.event({type: "result", payload: {text: "nothing", items: [], ok: true}});
		expect(run.state).toEqual({asked: "what changed?", answer: "nothing"});
		expect(run.effects).toContainEqual(emit("said", "nothing"));
		// `stop` is on the door because a program that spawns a child ends one; naming it here is
		// what keeps it on the door rather than in a list nothing reads.
		expect(typeof stop).toBe("function");
	});

	it("fills the shaped arg with a shipped session row, which is the config's half", () => {
		// Both rows compose their layer lazily, so this builds the real registration a config builds
		// without a `claude` or `codex` CLI behind it.
		const claude = outside({worker: claudeSession({cwd: "/tmp/tuval-8943", scope})});
		const codex = outside({worker: codexSession({cwd: "/tmp/tuval-8943", scope})});
		expect(claude.label).toBe("outside (claude-session)");
		expect(codex.label).toBe("outside (codex-session)");
	});
});

describe("the exports map opens only doors that exist", () => {
	it("every declared subpath of the SDK resolves to a file in it", () => {
		const manifestPath = createRequire(import.meta.url).resolve("@kampus/tuval-sdk/package.json");
		const root = dirname(manifestPath);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			readonly exports: Readonly<Record<string, string>>;
		};
		expect(Object.keys(manifest.exports)).toEqual([
			"./authoring",
			"./window",
			"./ai-agent/ports",
			"./config",
			"./kernel/*",
			"./package.json",
		]);
		for (const [subpath, target] of Object.entries(manifest.exports)) {
			// A pattern names a directory of modules, not one file; its prefix has to exist.
			const file = subpath.endsWith("/*") ? target.slice(0, target.indexOf("*")) : target;
			expect(() => statSync(resolve(root, file))).not.toThrow();
		}
	});

	it("the app's own map opens no module door, because an app is never imported (#9656)", () => {
		const root = resolve(import.meta.dirname, "../..");
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
			readonly exports: Readonly<Record<string, string>>;
		};
		expect(Object.keys(manifest.exports)).toEqual(["./package.json"]);
	});
});

describe("a consumer can emit declarations for a program that declares args", () => {
	it("names every inferred type through a package specifier, never through src/", () => {
		// `../../test-consumer/` is compiled with `declaration: true` and includes one module, which
		// reaches this package only through the `exports` map. The inferred type of `programArgs(…)`
		// is `ArgRefs<…>` over `ProgramArgRef` / `ArgIdentity` / `Spawnable`, and an exported const
		// of that type is what forces tsc to write those names into the `.d.ts`.
		const pkg = resolve(import.meta.dirname, "../..");
		// The compiler is this package's own `typescript` devDependency, reached through the bin
		// pnpm links beside it — not `npx`, which on a cold runner may go to the network first.
		execFileSync(resolve(pkg, "node_modules/.bin/tsc"), ["-p", "test-consumer/tsconfig.json"], {
			cwd: pkg,
			stdio: "pipe",
		});
		const emitted = readFileSync(
			resolve(pkg, "test-consumer/node_modules/.tmp/dts/test-consumer/program.d.ts"),
			"utf8",
		);
		const specifiers = [...emitted.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1] ?? "");
		expect(specifiers).not.toEqual([]);
		// A name missing from a door makes tsc reach for the source module some other way: by relative
		// path, which does not resolve from a real consumer (TS2742), or through the SDK's unstable
		// `./kernel/*` entry, which an author's published types must not lean on. Either way the
		// emitted text, not the exit code, is what this pins.
		const doors = [
			"@kampus/tuval-sdk/authoring",
			"@kampus/tuval-sdk/window",
			"@kampus/tuval-sdk/ai-agent/ports",
			"@kampus/tuval-claude",
		];
		expect(specifiers.filter((s) => !doors.includes(s))).toEqual([]);
	});
}, 60_000);
