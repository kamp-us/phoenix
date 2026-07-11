/**
 * `checkSettingsEnv` over a fake repo dir — the filesystem-seam test (#855, #2495).
 * The pure verdict is covered in `settings-env-guard.unit.test.ts`; this crosses the
 * IO gate over a real temp dir, asserting the exit-code contract (a clean settings
 * file succeeds; a `${...}` offender or a missing/unparseable settings.json all fail)
 * from observable outcomes — never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkSettingsEnv, IoError} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "settings-env-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const writeSettings = (settings: unknown) => {
	mkdirSync(join(root, ".claude"), {recursive: true});
	writeFileSync(
		join(root, ".claude", "settings.json"),
		JSON.stringify(settings, null, "\t"),
		"utf8",
	);
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;
const isIoError = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof IoError;

describe("checkSettingsEnv — IO gate", () => {
	it("SUCCEEDS on a settings.json whose env values are all literal", () => {
		writeSettings({env: {CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL: "otlp"}});
		return run(checkSettingsEnv(root)).then((exit) => expect(Exit.isSuccess(exit)).toBe(true));
	});

	it("SUCCEEDS on a settings.json with no env block (the post-#2495 phoenix shape)", () => {
		writeSettings({enabledPlugins: {"kampus-pipeline@kampus": false}, hooks: {}});
		return run(checkSettingsEnv(root)).then((exit) => expect(Exit.isSuccess(exit)).toBe(true));
	});

	it("FAILS CheckFailed on an env value carrying an unexpanded brace token (the #2495 regression)", () => {
		// `$\{...}` builds the literal ${CLAUDE_PROJECT_DIR} token without a plain-string
		// placeholder (biome noTemplateCurlyInString) — it is exactly the #2495 value.
		writeSettings({
			env: {KAMPUS_PIPELINE_DATA: `$\{CLAUDE_PROJECT_DIR}/.claude/.pipeline-cli-data`},
		});
		return run(checkSettingsEnv(root)).then((exit) => expect(isCheckFailed(exit)).toBe(true));
	});

	it("FAILS IoError (fail-closed, ADR 0092) when settings.json is missing", () =>
		run(checkSettingsEnv(root)).then((exit) => expect(isIoError(exit)).toBe(true)));

	it("FAILS IoError (fail-closed) when settings.json is not valid JSON", () => {
		mkdirSync(join(root, ".claude"), {recursive: true});
		writeFileSync(join(root, ".claude", "settings.json"), "{ not json", "utf8");
		return run(checkSettingsEnv(root)).then((exit) => expect(isIoError(exit)).toBe(true));
	});
});
