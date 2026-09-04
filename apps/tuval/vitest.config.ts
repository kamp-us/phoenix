import {defineConfig} from "vitest/config";

// A `unit` project so `vitest --project unit` (the pre-push `unit-changed` leg over `apps/**`)
// resolves here, and an `integration` project beside it now that the app has one. Tuval's
// `integration` is the non-remote half of the tier `.glossary/LANGUAGE.md` defines — a real Pi
// `AgentSession` behind a real loopback socket and a real WebSocket codec, slow but needing no
// cloud credentials (#7544, #7556, #7567).
//
// The browser surface's component tests are `unit` too — a rendered `Desk` could be wrong even if
// every socket behaved perfectly, which is the tier litmus (`.patterns/effect-testing.md`). They
// live in the same project rather than a third one, and each `*.unit.test.tsx` names `jsdom` in its
// own `@vitest-environment` docblock, so the ~490 node-environment tests beside them keep running
// with no DOM and the repo's two tiers stay two.
//
// `execArgv` is top level because Vitest 4 reads per-project fork exec args there (the v4 pool
// rework removed `poolOptions`). Both flags are apps/web's, for reasons that reach here unchanged:
// `--max-old-space-size` caps a runaway passive-update loop into a fast failure instead of a ~5GB
// hang (#1470), and `--no-experimental-webstorage` drops the Node 26 `localStorage` global that
// otherwise shadows jsdom's and reads `undefined` (#7728) — this package's volta pin is Node 26,
// and one of the surface's own assertions is that a drag writes nothing to `localStorage`.
export default defineConfig({
	test: {
		execArgv: ["--max-old-space-size=512", "--no-experimental-webstorage"],
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.unit.test.ts", "src/**/*.unit.test.tsx"],
					pool: "forks",
					sequence: {groupOrder: 0},
				},
			},
			{
				test: {
					name: "integration",
					include: ["src/**/*.integration.test.ts"],
					pool: "forks",
					sequence: {groupOrder: 1},
					testTimeout: 60_000,
				},
			},
		],
	},
});
