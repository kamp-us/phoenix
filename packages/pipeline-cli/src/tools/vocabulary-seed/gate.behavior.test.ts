/**
 * The done-test, crossed end to end: seeding a BARE repo makes `vocabulary-preflight check` pass
 * (#4341 AC 4).
 *
 * This is the acceptance criterion that proves the feature, so it is exercised rather than argued —
 * the real `applySeed` and the real `checkVocabulary` run against one shared fake repo. Only the
 * two boundaries are substituted: `gh` (a `ChildProcessSpawner` holding the repo's label universe
 * in a Set, which the creates actually mutate) and the filesystem (an in-memory map). Everything
 * between — the diff, the create calls, the 422 handling, the scaffold, the preflight's judgement —
 * is the shipped code path.
 */
import {describe, expect, it} from "@effect/vitest";
import {Effect, Exit, FileSystem, Layer, Path, PlatformError, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {checkVocabulary} from "../vocabulary-preflight/gate.ts";
import {RepoLabels} from "../vocabulary-preflight/github.ts";
import {REQUIRED_LABELS} from "../vocabulary-preflight/vocabulary.ts";
import {applySeed, planSeed} from "./gate.ts";
import {layer as seederLayer} from "./github.ts";
import {isAlreadyExists} from "./seed.ts";

const REPO = "adopter/fresh";
const ROOT = "/repo";

const enc = new TextEncoder();
const stream = (s: string) => Stream.fromArray([enc.encode(s)]);

const argValue = (args: ReadonlyArray<string>, key: string): string | undefined => {
	const hit = args.find((a) => a.startsWith(`${key}=`));
	return hit?.slice(key.length + 1);
};

/**
 * A `gh` that owns `universe` as live state: `GET .../labels` reports it, `POST .../labels` adds to
 * it and 422s with GitHub's real `already_exists` body on a name it already holds. Modelling the
 * 422 rather than asserting the tool never provokes one is the point — idempotency has to hold
 * against the server's actual behaviour, not against a pre-read that might be stale.
 */
const ghWithUniverse = (
	universe: Set<string>,
	created: Array<string>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const isPost = args.includes("-X") && args[args.indexOf("-X") + 1] === "POST";
				let stdout = "";
				let exitCode = 0;
				if (isPost) {
					const name = argValue(args, "name") ?? "";
					if (universe.has(name)) {
						stdout = JSON.stringify({
							message: "Validation Failed",
							errors: [{resource: "Label", code: "already_exists", field: "name"}],
						});
						exitCode = 1;
					} else {
						universe.add(name);
						created.push(name);
						stdout = JSON.stringify({name});
					}
				} else {
					stdout = JSON.stringify([[...universe].map((name) => ({name}))]);
				}
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: stream(stdout),
					stderr: stream(exitCode === 0 ? "" : "gh: Validation Failed (HTTP 422)"),
					all: stream(stdout),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);

/** An in-memory filesystem over a map, so the ROADMAP write is observable without touching disk. */
const memoryFs = (files: Map<string, string>) =>
	FileSystem.layerNoop({
		exists: (path: string) => Effect.succeed(files.has(path)),
		readFileString: (path: string) => {
			const contents = files.get(path);
			return contents === undefined
				? Effect.fail(
						PlatformError.systemError({
							_tag: "NotFound",
							module: "FileSystem",
							method: "readFileString",
							pathOrDescriptor: path,
						}),
					)
				: Effect.succeed(contents);
		},
		writeFileString: (path: string, data: string) =>
			Effect.sync(() => {
				files.set(path, data);
			}),
	});

const platform = (files: Map<string, string>) => Layer.merge(memoryFs(files), Path.layer);

const preflight = (universe: Set<string>, files: Map<string, string>) =>
	checkVocabulary(ROOT).pipe(
		Effect.provideService(RepoLabels, {
			list: () => Effect.succeed([...universe]),
			presence: () => Effect.succeed({_tag: "present" as const}),
		}),
		Effect.provide(platform(files)),
	);

/** One merged layer per run: the seeder over its stub `gh`, plus the in-memory platform. */
const seedLayers = (
	gh: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
	files: Map<string, string>,
) => Layer.merge(seederLayer(REPO).pipe(Layer.provide(gh)), platform(files));

const seed = (universe: Set<string>, files: Map<string, string>, created: Array<string>) =>
	applySeed(ROOT).pipe(Effect.provide(seedLayers(ghWithUniverse(universe, created), files)));

describe("the observable done-test: seed a bare repo, then the preflight passes (#4341)", () => {
	it("goes RED before the seed and GREEN after it, in one run", async () => {
		const universe = new Set<string>();
		const files = new Map<string, string>();
		const created: Array<string> = [];

		// RED: a bare repo has no labels and no ROADMAP.md — both unmet prerequisites.
		expect(Exit.isFailure(await Effect.runPromise(Effect.exit(preflight(universe, files))))).toBe(
			true,
		);

		await Effect.runPromise(seed(universe, files, created));

		// GREEN: the same preflight, over the state the seed left behind.
		expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(preflight(universe, files))))).toBe(
			true,
		);

		for (const label of REQUIRED_LABELS) expect(universe.has(label)).toBe(true);
		expect(files.has(`${ROOT}/ROADMAP.md`)).toBe(true);
	});

	it("is idempotent — a second run creates nothing and does not error", async () => {
		const universe = new Set<string>();
		const files = new Map<string, string>();
		const first: Array<string> = [];
		const second: Array<string> = [];

		await Effect.runPromise(seed(universe, files, first));
		const roadmap = files.get(`${ROOT}/ROADMAP.md`);
		await Effect.runPromise(seed(universe, files, second));

		expect(first.length).toBeGreaterThan(0);
		expect(second).toEqual([]);
		expect(files.get(`${ROOT}/ROADMAP.md`)).toBe(roadmap);
	});

	it("finishes a PARTIALLY-seeded repo, creating only the gap", async () => {
		const universe = new Set<string>(["p0", "type:bug"]);
		const files = new Map<string, string>();
		const created: Array<string> = [];

		await Effect.runPromise(seed(universe, files, created));

		expect(created).not.toContain("p0");
		expect(created).toContain("p1");
		expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(preflight(universe, files))))).toBe(
			true,
		);
	});

	it("never overwrites a ROADMAP.md the repo already maintains", async () => {
		const universe = new Set<string>();
		const files = new Map<string, string>([
			[
				`${ROOT}/ROADMAP.md`,
				"# Roadmap\n\n## Arcs\n\n| Arc | Milestone | State |\n| --- | --- | --- |\n| Ours | #7 | active |\n",
			],
		]);

		await Effect.runPromise(seed(universe, files, []));

		expect(files.get(`${ROOT}/ROADMAP.md`)).toContain("| Ours | #7 | active |");
	});

	it("survives a label that appears between the read and the create (the real 422 path)", async () => {
		const universe = new Set<string>();
		const files = new Map<string, string>();
		// The plan is computed off an empty universe; a concurrent operator lands `p0` before the
		// creates run, so the create for `p0` hits the server's real 422 rather than the pre-read.
		const gh = ghWithUniverse(universe, []).pipe(
			Layer.tap(() => Effect.sync(() => universe.add("p0"))),
		);
		const planned = applySeed(ROOT).pipe(Effect.provide(seedLayers(gh, files)));
		await expect(Effect.runPromise(planned)).resolves.toBeUndefined();
		expect(isAlreadyExists("already_exists")).toBe(true);
	});

	it("plan writes nothing at all", async () => {
		const universe = new Set<string>();
		const files = new Map<string, string>();
		await Effect.runPromise(
			planSeed(ROOT).pipe(Effect.provide(seedLayers(ghWithUniverse(universe, []), files))),
		);
		expect(universe.size).toBe(0);
		expect(files.size).toBe(0);
	});
});
