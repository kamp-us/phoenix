/**
 * `local-render render` — the skill-/CLI-callable entry (#2963), driven by the
 * write-code inner loop (#2965):
 *
 *   node packages/local-render/src/bin.ts render \
 *     --surface "/sozluk" [--surface "/sozluk:empty" ...] \
 *     --out <dir> \
 *     [--base http://localhost:3000] \
 *     [--flag "pano-draft-save=on" ...] \
 *     [--region "/sozluk=0,0,1280,900" ...] \
 *     [--budget 1400]
 *
 * Renders each composed surface over a running local `alchemy dev` build (start
 * it first with `pnpm dev`), writes the PNG bytes under `--out`, and prints a JSON
 * array of per-surface records `{ surface, route, state, localPath, fileName }` on
 * stdout — the `localPath` the downstream evidence-attach step (#2964) uploads.
 * Mechanical-tooling idiom (`effect/unstable/cli`, pure core + thin bin).
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {parseSurfaceSpec} from "@kampus/design-capture";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {DEFAULT_LOCAL_BASE, parseFlagOverride, parseRegionSpec} from "./plan.ts";
import {renderLocal} from "./render.ts";

const baseFlag = Flag.string("base").pipe(
	Flag.withDefault(DEFAULT_LOCAL_BASE),
	Flag.withDescription(
		"the localhost base the composed dev build serves (default the Vite origin)",
	),
);

const surfaceFlag = Flag.string("surface").pipe(
	Flag.withDescription(
		'a surface to render, "<route>[:state]" (repeatable), e.g. /sozluk or /sozluk:empty',
	),
	Flag.atLeast(1),
);

const outFlag = Flag.string("out").pipe(
	Flag.withDescription("output directory for the captured PNG bytes"),
);

const flagFlag = Flag.string("flag").pipe(
	Flag.withDescription(
		'a dev-override flag, "<key>=on|off" (repeatable) — seeds the phoenix_flag_overrides cookie',
	),
	Flag.atLeast(0),
);

const regionFlag = Flag.string("region").pipe(
	Flag.withDescription('a changed-region crop, "<surface>=x,y,w,h" in CSS px (repeatable)'),
	Flag.atLeast(0),
);

const budgetFlag = Flag.integer("budget").pipe(
	Flag.optional,
	Flag.withDescription("longest-edge downscale budget in device px (default 1400)"),
);

const render = Command.make(
	"render",
	{
		base: baseFlag,
		surface: surfaceFlag,
		out: outFlag,
		flag: flagFlag,
		region: regionFlag,
		budget: budgetFlag,
	},
	Effect.fn(function* ({base, surface, out, flag, region, budget}) {
		const overrides = Object.fromEntries(flag.map(parseFlagOverride));
		const regions = Object.fromEntries(region.map(parseRegionSpec));
		const captured = yield* renderLocal({
			base,
			surfaces: surface.map(parseSurfaceSpec),
			outDir: out,
			overrides,
			regions,
			...(Option.isSome(budget) ? {budget: budget.value} : {}),
		});
		const records = captured.map((c) => ({
			surface: c.surface,
			route: c.route,
			state: c.state,
			localPath: c.localPath,
			fileName: c.fileName,
		}));
		yield* Console.log(JSON.stringify(records, null, 2));
	}),
).pipe(
	Command.withDescription(
		"Render the composed surfaces over a local alchemy dev build and write PNGs",
	),
);

const cli = Command.make("local-render").pipe(
	Command.withSubcommands([render]),
	Command.withDescription(
		"Local render-and-capture harness over an alchemy dev build (#2963, epic #2953)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
