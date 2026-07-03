/**
 * Runtime-existence guard for the effect value symbols the backend calls (#1672).
 *
 * The forcing fact: effect is pinned to a fast-moving 4.x beta (`effect@4.0.0-beta.92`,
 * `catalog:` in `pnpm-workspace.yaml`) whose surface churns bump-to-bump — the repo has
 * already ridden several coordinated pins (#1578 / #1582 / #1588). A bump that *drops or
 * renames* a value combinator the backend depends on is the live risk this guard covers:
 * it imports every effect submodule the backend uses and asserts each value symbol it
 * calls is still present at runtime, so such a regression fails the `unit` CI gate here
 * (with the exact missing name) instead of throwing `"X is not a function"` in production.
 *
 * On the reported "type↔runtime export skew" (#1672 was filed as an investigation): it does
 * NOT reproduce under the pinned beta.92 + the repo's real typecheck gate. The report's
 * examples — `Effect.dieMessage` / `Effect.zipRight` / `Effect.catchAll` (pre-4.x APIs since
 * removed/renamed: `catchAll`→`catch`, `zipRight`→`andThen`) — are absent from *both*
 * effect's `.d.ts` and its `.js`; the two agree. So `pnpm typecheck` (tsgo `-b
 * tsconfig.worker.json`) correctly rejects a call to them with `TS2339` — verified — and
 * "typecheck is a correctness gate for Effect API existence" holds: a call to an
 * absent-from-both symbol never ships green. The reporter's "typechecks clean" reading was
 * against an earlier effect beta (where those symbols still existed) or a non-gate `tsc`,
 * not this pin's `tsgo`. This test is therefore defense-in-depth for the one residual class
 * typecheck can't see — a future beta shipping a `.d.ts` that declares a value symbol its
 * `.js` omits (a mismatched-artifact bump) — not a fix for a live skew (there is none).
 *
 * Scope note: only *runtime-value* symbols are listed. Type-level references the backend
 * writes in annotations (`Effect.Effect<…>`, `Layer.Layer<…>`, `Schema.Schema<…>`,
 * `Match.ts`, …) live solely in `.d.ts` and are correctly `undefined` at runtime — they are
 * excluded, since asserting their runtime presence would false-fail.
 *
 * Maintenance: the manifest is the backend's effect value surface at authoring time. When a
 * backend module reaches for a new effect combinator, add it to the matching module's list
 * so the bump guard covers it. Regenerate the candidate set by grepping `worker/` for
 * `<Namespace>.<member>` accesses of the imported effect namespaces and keeping those whose
 * `typeof !== "undefined"` under the pinned effect.
 */
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {describe, expect, it} from "vitest";

// Each entry: [module namespace object, its import specifier, the value symbols the backend
// calls from it]. `namespace` is asserted `!== "undefined"` — the precise negative of the
// reported failure mode ("symbol is `undefined` at runtime"), and correct for both function
// and non-function value exports.
const BACKEND_EFFECT_SURFACE: ReadonlyArray<{
	readonly module: string;
	readonly namespace: object;
	readonly symbols: ReadonlyArray<string>;
}> = [
	{
		module: "effect/Config",
		namespace: Config,
		symbols: ["all", "literals", "redacted", "withDefault"],
	},
	{
		module: "effect/Effect",
		namespace: Effect,
		symbols: [
			"all",
			"andThen",
			"as",
			"asVoid",
			"cached",
			"catch",
			"catchCause",
			"catchDefect",
			"catchIf",
			"catchTag",
			"catchTags",
			"die",
			"ensuring",
			"exit",
			"fail",
			"flatMap",
			"flip",
			"fn",
			"forEach",
			"forkChild",
			"gen",
			"ignore",
			"interrupt",
			"log",
			"logError",
			"logWarning",
			"map",
			"mapError",
			"never",
			"onExit",
			"orDie",
			"promise",
			"provide",
			"provideService",
			"result",
			"retry",
			"runPromise",
			"runPromiseExit",
			"runSync",
			"runSyncExit",
			"succeed",
			"suspend",
			"sync",
			"timeout",
			"try",
			"tryPromise",
			"void",
		],
	},
	{
		module: "effect/Layer",
		namespace: Layer,
		symbols: [
			"effect",
			"effectContext",
			"makeMemoMapUnsafe",
			"mergeAll",
			"provide",
			"provideMerge",
			"succeed",
			"unwrap",
		],
	},
	{
		module: "effect/Schema",
		namespace: Schema,
		symbols: [
			"Array",
			"Boolean",
			"Class",
			"Defect",
			"Literal",
			"Literals",
			"NullOr",
			"Number",
			"Record",
			"String",
			"Struct",
			"TaggedErrorClass",
			"Union",
			"Unknown",
			"decodeUnknownEffect",
			"decodeUnknownExit",
			"decodeUnknownOption",
			"decodeUnknownSync",
			"encodeSync",
			"fromJsonString",
			"optional",
			"tag",
		],
	},
	{
		module: "effect/Context",
		namespace: Context,
		symbols: ["Service", "get", "make"],
	},
	{
		module: "effect/Exit",
		namespace: Exit,
		symbols: ["fail", "hasInterrupts", "isFailure", "isSuccess", "succeed"],
	},
	{
		module: "effect/Cause",
		namespace: Cause,
		symbols: ["findErrorOption", "isDieReason", "isFailReason"],
	},
	{
		module: "effect/Option",
		namespace: Option,
		symbols: ["getOrThrow", "isNone", "isSome", "none"],
	},
	{
		module: "effect/Redacted",
		namespace: Redacted,
		symbols: ["value"],
	},
	{
		module: "effect/Data",
		namespace: Data,
		symbols: ["TaggedError", "taggedEnum"],
	},
	{
		module: "effect/Fiber",
		namespace: Fiber,
		symbols: ["await", "join"],
	},
	{
		module: "effect/Schedule",
		namespace: Schedule,
		symbols: ["both", "exponential", "recurs", "while"],
	},
	{
		module: "effect/Queue",
		namespace: Queue,
		symbols: ["dropping", "offer", "shutdown"],
	},
	{
		module: "effect/Stream",
		namespace: Stream,
		symbols: ["drop", "ensuring", "fromQueue", "map", "merge", "tick"],
	},
	{
		module: "effect/Match",
		namespace: Match,
		symbols: ["tagsExhaustive", "type", "valueTags"],
	},
	{
		module: "effect/ConfigProvider",
		namespace: ConfigProvider,
		symbols: ["ConfigProvider", "fromUnknown"],
	},
	{
		module: "effect/ManagedRuntime",
		namespace: ManagedRuntime,
		symbols: ["make"],
	},
	{
		module: "effect/Latch",
		namespace: Latch,
		symbols: ["make"],
	},
	{
		module: "effect/Path",
		namespace: Path,
		symbols: ["layer"],
	},
	{
		module: "effect/FileSystem",
		namespace: FileSystem,
		symbols: ["layerNoop"],
	},
];

describe("effect runtime exports — the backend's effect value surface exists at runtime", () => {
	for (const {module, namespace, symbols} of BACKEND_EFFECT_SURFACE) {
		describe(module, () => {
			for (const symbol of symbols) {
				it(`${symbol} is present at runtime (not typed-but-undefined)`, () => {
					expect(
						typeof Reflect.get(namespace, symbol),
						`${module}.${symbol} is undefined at runtime under the pinned effect — a bump ` +
							`dropped/renamed a value symbol the backend calls; update the call site or the pin.`,
					).not.toBe("undefined");
				});
			}
		});
	}
});
