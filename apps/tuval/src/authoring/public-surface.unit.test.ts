/**
 * The consumer's proof for #8943: a module that reaches the authoring API only through the package
 * specifiers `apps/tuval/package.json` declares — no relative path into `src/` anywhere below this
 * docblock — can write a program, declare a shaped arg, and fill it with a shipped session row.
 *
 * Self-reference is what makes that honest inside this repo: Node and Vite resolve
 * `@kampus/tuval/authoring` from this package's own `name` + `exports`, walking the same map an
 * outside consumer walks, so a subpath missing from the map fails here exactly as it would fail
 * there. `tsc` over this file is the other half — the door has to be typed, not just resolvable.
 *
 * It stays small on purpose. What each authored field *does* is pinned next door
 * (`define-program.unit.test.ts`, `../cron/cron.unit.test.ts`); this file pins only that the names
 * arrive, and that the map opens no door onto a module that is not there.
 */

import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {PromptPayloadSchema, type TurnResult, TurnResultSchema} from "@kampus/tuval/ai-agent/ports";
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
} from "@kampus/tuval/authoring";
import {ClientId, claudeSession, codexSession, WorkspaceId} from "@kampus/tuval/sessions";
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
	it("every declared subpath resolves to a file in this package", () => {
		const root = resolve(import.meta.dirname, "../..");
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
			readonly exports: Readonly<Record<string, string>>;
		};
		expect(Object.keys(manifest.exports)).toEqual([
			"./authoring",
			"./window",
			"./ai-agent/ports",
			"./sessions",
			"./package.json",
		]);
		for (const target of Object.values(manifest.exports)) {
			expect(() => readFileSync(resolve(root, target), "utf8")).not.toThrow();
		}
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
		// A name missing from a door makes tsc reach for the source module by relative path. That
		// path resolves in-tree and does not resolve from a real consumer, where it is TS2742 —
		// which is why the emitted text, not the exit code, is what this pins.
		expect(specifiers.filter((s) => !s.startsWith("@kampus/tuval/"))).toEqual([]);
	});
}, 60_000);
