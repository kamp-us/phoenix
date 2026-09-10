import {Effect, FileSystem, Path, Result, Schema} from "effect";
import {type Binding, decodeJson, digest, type Hook} from "./native.ts";

const Saved = Schema.Struct({
	root: Schema.String,
	run: Schema.String,
	repo: Schema.NullOr(Schema.String),
	branch: Schema.NullOr(Schema.String),
	provider: Schema.NullOr(Schema.String),
	transcript: Schema.String,
});
const Child = Schema.Struct({id: Schema.String, path: Schema.String, explicit: Schema.Boolean});

export const inventory = Effect.fn("spend.claude.inventory")(function* (
	directory: string,
	binding: Binding,
	hook: typeof Hook.Type,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = path.join(directory, digest(binding.root));
	yield* fs.makeDirectory(dir, {recursive: true});
	const bindingPath = path.join(dir, "binding.json");
	const saved = yield* Effect.result(
		fs.writeFileString(
			bindingPath,
			JSON.stringify({...binding, transcript: hook.transcript_path}),
			{flag: "wx"},
		),
	);
	if (Result.isFailure(saved) && saved.failure.reason._tag !== "AlreadyExists")
		return yield* saved.failure;
	if (hook.agent_id) {
		const child = {
			id: hook.agent_id,
			explicit: hook.agent_transcript_path !== undefined,
			path:
				hook.agent_transcript_path ??
				path.join(
					hook.transcript_path.replace(/\.jsonl$/, ""),
					"subagents",
					`agent-${hook.agent_id}.jsonl`,
				),
		};
		// The digest excludes prompt text; concurrent identical events publish identical metadata.
		yield* fs.writeFileString(path.join(dir, `${digest(child)}.child.json`), JSON.stringify(child));
	}
	const sessions: Array<{binding: Binding; transcript: string; expected: Map<string, string>}> = [];
	for (const entry of (yield* fs.readDirectory(directory)).sort()) {
		const savedDir = path.join(directory, entry);
		const decoded = decodeJson(
			Saved,
			yield* fs.readFileString(path.join(savedDir, "binding.json")),
		);
		if (Result.isFailure(decoded))
			return yield* Effect.fail("Claude inventory unreadable; retry collection.");
		const expected = new Map<string, string>();
		const explicit = new Set<string>();
		for (const file of (yield* fs.readDirectory(savedDir))
			.filter((name) => name.endsWith(".child.json"))
			.sort()) {
			const child = decodeJson(Child, yield* fs.readFileString(path.join(savedDir, file)));
			if (Result.isFailure(child))
				return yield* Effect.fail("Claude child inventory unreadable; retry collection.");
			if (child.success.explicit || !explicit.has(child.success.id))
				expected.set(child.success.id, child.success.path);
			if (child.success.explicit) explicit.add(child.success.id);
		}
		sessions.push({binding: decoded.success, transcript: decoded.success.transcript, expected});
	}
	return sessions;
});
