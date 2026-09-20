import {Effect, Path, Result} from "effect";
import {execCapture} from "../../io/exec.ts";
import {parseOwnerRepo} from "../../io/git.ts";
import type {StdinRead} from "../../io/stdin.ts";
import {answer} from "../../verb.ts";
import {recordUsage} from "../usage-ledger.ts";
import type {UsageRecord} from "../usage-record.ts";
import {discover} from "./discovery.ts";
import {inventory} from "./inventory.ts";
import {
	type Binding,
	common,
	decodeJson,
	digest,
	Hook,
	measurement,
	participant,
	sessionKey,
} from "./native.ts";

const report = (notices: readonly string[]) =>
	answer(JSON.stringify({systemMessage: notices.join("\n").slice(0, 9000)}), notices);

export const runClaudeSpend = Effect.fn("spend.claude.collect")(
	function* (options: {
		readonly stdin: Effect.Effect<StdinRead>;
		readonly env: Readonly<Record<string, string | undefined>>;
	}) {
		const input = yield* options.stdin;
		if (input._tag !== "Text")
			return report(["Claude usage incomplete: hook input unavailable. Task unchanged."]);
		const decoded = decodeJson(Hook, input.text);
		if (Result.isFailure(decoded))
			return report(["Claude usage incomplete: invalid hook payload. Task unchanged."]);
		const hook = decoded.success;
		const path = yield* Path.Path;
		const checkout = yield* execCapture("git", ["-C", hook.cwd, "rev-parse", "--show-toplevel"]);
		const directory = checkout.ok ? checkout.stdout.trim() : hook.cwd;
		const remote = yield* execCapture("git", ["-C", hook.cwd, "remote", "get-url", "origin"]);
		const branch = yield* execCapture("git", ["-C", hook.cwd, "branch", "--show-current"]);
		const binding: Binding = {
			root: hook.session_id,
			run: options.env.FABRIKA_SESSION_ID || hook.session_id,
			repo: options.env.CLAUDE_PIPELINE_REPO || (remote.ok ? parseOwnerRepo(remote.stdout) : null),
			branch: branch.ok ? branch.stdout.trim() || null : null,
			provider: null,
		};
		const notices: string[] = [
			"Claude usage coverage incomplete: lifecycle hooks cannot prove an exhaustive inventory after interruption.",
		];
		const sessions = yield* inventory(path.join(directory, ".fabrika/claude-usage"), binding, hook);
		for (const session of sessions) {
			const found = yield* discover(session.binding.root, session.transcript, session.expected);
			const records: UsageRecord[] = [];
			for (const transcript of found.transcripts) {
				const parent =
					transcript.parentTool === null
						? null
						: (found.parents.get(transcript.parentTool) ?? null);
				let measured = 0;
				let missingUsage = false;
				for (const row of transcript.rows) {
					if (transcript.child !== null && parent === null) continue;
					const record = measurement(row, session.binding, transcript.child, parent);
					if (record === null) {
						if (row.type === "assistant") missingUsage = true;
						continue;
					}
					records.push(record);
					measured++;
				}
				if (transcript.state !== "read" || measured === 0 || transcript.malformed || missingUsage) {
					const state =
						transcript.state !== "read"
							? transcript.state
							: transcript.malformed
								? "unreadable"
								: "usage-missing";
					records.push(participant(session.binding, transcript.child, parent, state));
					notices.push(
						`Claude usage incomplete: ${sessionKey(session.binding.root, transcript.child)} ${state}.`,
					);
				}
			}
			const matched = new Set(found.transcripts.map((transcript) => transcript.parentTool));
			for (const [tool, owner] of found.parents) {
				if (matched.has(tool)) continue;
				const fields = {
					...common(session.binding, null, null),
					kind: "participant" as const,
					participant: `${session.binding.root}/tool/${tool}`,
					state: "expected" as const,
					agent: {
						session: null,
						nativeSession: null,
						rootSession: session.binding.root,
						parent: {kind: "known" as const, session: owner},
					},
				};
				records.push({...fields, recordId: digest(fields)});
				notices.push(
					`Claude usage incomplete: native Agent call ${tool} has no matched child transcript.`,
				);
			}
			const coverage = {
				...common(session.binding, null, null),
				kind: "coverage" as const,
				state: "partial" as const,
				discovery: found.enumerated ? ("enumerated" as const) : ("unknown" as const),
				participants: found.transcripts
					.map((item) => sessionKey(session.binding.root, item.child))
					.sort(),
			};
			records.push({...coverage, recordId: digest([coverage, records.map((row) => row.recordId)])});
			for (const record of records) {
				const result = yield* recordUsage(
					path.join(directory, ".fabrika/spend-ledger.jsonl"),
					record,
				);
				if (result.status === "failed") notices.push(result.notice);
			}
		}
		return report(notices);
	},
	Effect.catchCause(() =>
		Effect.succeed(
			report([
				"Claude usage incomplete: collector failed. Task unchanged; retry the hook payload.",
			]),
		),
	),
);
