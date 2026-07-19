/**
 * The `guard-content-probe` tool — `pipeline-cli guard-content-probe classify [flags]`
 * (issue #3645, founder ruling #3416).
 *
 *   gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' \
 *     | pipeline-cli guard-content-probe classify --path "$adr"
 *   pipeline-cli guard-content-probe classify --body-file adr.md --path .decisions/0194-x.md
 *
 * The ADR-0164 guard-touching-ADR content probe, shared so the review gate (review-doc /
 * review-code), the driver (via trivial-diff), and ship-it Step 0 classify a guard-touching
 * `.decisions/**` change through ONE verb — not three copies of the grep. Reads ONE ADR's body
 * from stdin (or `--body-file`), reads the canonical `GUARD_ADR_RE` from the local
 * `gh-issue-intake-formats.md` §CP (the single source — never a second inline copy), and prints
 * `guard-touching` / `not-guard-touching` to **stdout** — the word the caller branches on. A
 * human reason goes to **stderr**. Exit code mirrors the decision: **0 on `guard-touching`, 1 on
 * `not-guard-touching`**, so the gate bash can `… guard-content-probe classify && echo BLOCKING`
 * and fail closed.
 *
 * IO here (the thin bin); the whole ADR-0164 predicate lives in `guard-content-probe.ts` (the
 * pure, unit-tested core), the same split `class-probe` / `cp-cardinality` use. The caller owns
 * the `gh api` REST resolution of each `.decisions/**` file's body at the PR head — the
 * integration half this tool never touches. Fail-closed: an unreadable §CP boundary or an
 * unreadable ADR body both classify `guard-touching` (over-route to a cheap human approval,
 * never auto-ship an unproven guard-relaxer).
 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {FORMATS_PATH} from "../codeowners-cp/gate.ts";
import {
	FAILCLOSED_GUARD_ADR_RE,
	parseGuardAdrRe,
	probeGuardContent,
} from "./guard-content-probe.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

const defaultRoot = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return root ?? start;
};

const bodyFileFlag = Flag.string("body-file").pipe(
	Flag.optional,
	Flag.withDescription("read the ADR body from this file (default: stdin)"),
);

const pathFlag = Flag.string("path").pipe(
	Flag.optional,
	Flag.withDescription("the .decisions/** path being classified (labels the human reason only)"),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("repo root to read gh-issue-intake-formats.md §CP from (default: walk up)"),
);

/**
 * Read the ADR body from `--body-file` or stdin. A failed read returns null, which the core
 * classifies guard-touching (fail-closed) — the same posture as an unreadable ADR at head.
 */
const readBody = (bodyFile: Option.Option<string>): string | null => {
	// biome-ignore lint/plugin: best-effort read — a failed read is absorbed into null (⇒ guard-touching, fail-closed), never the E channel; a total helper, not Effect-cosplay.
	try {
		return Option.match(bodyFile, {
			onSome: (path) => readFileSync(path, "utf8"),
			onNone: () => readFileSync(0, "utf8"),
		});
	} catch {
		return null;
	}
};

/** Read local §CP text; null (⇒ fail-closed `GUARD_ADR_RE`) if the file is unreadable. */
const readFormats = (root: string): string | null => {
	// biome-ignore lint/plugin: best-effort read — an unreadable file is absorbed into null (⇒ fail-closed GUARD_ADR_RE), never the E channel; a total helper, not Effect-cosplay.
	try {
		return readFileSync(join(root, FORMATS_PATH), "utf8");
	} catch {
		return null;
	}
};

const classifyCmd = Command.make(
	"classify",
	{bodyFile: bodyFileFlag, path: pathFlag, root: rootFlag},
	Effect.fn(function* ({bodyFile, path, root}) {
		const rootDir = Option.getOrElse(root, () => defaultRoot());
		const formats = readFormats(rootDir);
		const guardRe = formats === null ? FAILCLOSED_GUARD_ADR_RE : parseGuardAdrRe(formats);
		const body = readBody(bodyFile);
		const result = probeGuardContent(body, guardRe);
		const label = Option.getOrElse(path, () => "(stdin ADR)");

		if (formats === null) {
			yield* Effect.sync(() =>
				process.stderr.write(
					`guard-content-probe: could not read ${FORMATS_PATH} under ${rootDir} — using fail-closed GUARD_ADR_RE ('.', match-everything ⇒ §CP).\n`,
				),
			);
		}
		yield* Effect.sync(() =>
			process.stderr.write(
				`guard-content-probe: ${label} → ${result.guardTouching ? "guard-touching (§CP, ADR 0164)" : "not-guard-touching"} [${result.reason}]\n`,
			),
		);
		yield* Console.log(result.guardTouching ? "guard-touching" : "not-guard-touching");
		// Exit code mirrors the decision so the gate bash fails closed: 0 ⇒ §CP, 1 ⇒ ordinary.
		if (!result.guardTouching) return yield* Effect.sync(() => process.exit(1));
	}),
).pipe(
	Command.withDescription(
		"Classify one .decisions/** ADR body as guard-touching (§CP) or not by content (ADR 0164, #3645)",
	),
);

export const guardContentProbeCommand = Command.make("guard-content-probe").pipe(
	Command.withSubcommands([classifyCmd]),
	Command.withDescription(
		"Shared ADR-0164 guard-touching-ADR content probe (review gate + driver + ship-it Step 0; #3645)",
	),
);
