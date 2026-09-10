import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Path} from "effect";
import {execCapture} from "../io/exec.ts";
import {readStdin} from "../io/stdin.ts";
import {runCodexHook} from "./codex-hook-verb.ts";

Effect.gen(function* () {
	const path = yield* Path.Path;
	const input = readStdin();
	if (input._tag !== "Text") {
		yield* Console.log(
			JSON.stringify({systemMessage: "Fabrika usage hook input unreadable; work is unchanged."}),
		);
		return;
	}
	const common = yield* execCapture("git", [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!common.ok) {
		yield* Console.log("{}");
		return;
	}
	const home =
		process.env.CODEX_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".codex") : null);
	if (home === null) {
		yield* Console.log(
			JSON.stringify({systemMessage: "Fabrika usage: Codex session location is unknown."}),
		);
		return;
	}
	const state = path.join(common.stdout.trim(), "fabrika-codex-usage");
	const result = yield* runCodexHook({
		input: input.text,
		sessions: path.join(home, "sessions"),
		state,
		ledger: path.join(path.dirname(common.stdout.trim()), ".fabrika", "spend-ledger.jsonl"),
		repo: null,
	});
	yield* Console.log(result.stdout);
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
