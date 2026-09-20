import {Crypto, Effect, FileSystem, Path, Result} from "effect";
import {answer} from "../verb.ts";
import {codexAttribution} from "./codex-attribution.ts";
import {collectCodex} from "./codex-collector.ts";
import {type CodexWork, id, json, object, readCodexSession} from "./codex-records.ts";

export interface CodexHookOptions {
	readonly input: string;
	readonly sessions: string;
	readonly state: string;
	readonly ledger: string;
	readonly repo: string | null;
	readonly work?: CodexWork;
}
const advisory = (notices: ReadonlyArray<string>) =>
	answer(
		JSON.stringify(
			notices.length
				? {systemMessage: `Fabrika usage coverage is incomplete. ${notices.join(" ")}`}
				: {},
		),
	);
const readWork = (value: unknown): CodexWork | undefined => {
	const stored = object(value);
	return typeof stored.issue === "number" &&
		Number.isSafeInteger(stored.issue) &&
		stored.issue > 0 &&
		id(stored.run)
		? {repo: id(stored.repo), issue: stored.issue, run: stored.run as string}
		: undefined;
};
export const runCodexHook = Effect.fn("spend.codexHook")(
	function* (options: CodexHookOptions) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const event = object(json(options.input));
		const thread = id(event.session_id),
			turn = id(event.turn_id);
		if (!thread) return advisory(["Native hook session identity is missing."]);
		const transcript = id(event.transcript_path);
		const read = transcript ? yield* Effect.result(fs.readFileString(transcript)) : null;
		const native = read && Result.isSuccess(read) ? readCodexSession(read.success) : null;
		const rootThread = native?.root ?? thread;
		const association = codexAttribution(event);
		const issue = association.kind === "issue" ? association.issue : null;
		const binding = path.join(
			options.state,
			`${encodeURIComponent(rootThread)}-${encodeURIComponent(turn ?? "unknown")}.json`,
		);
		const active = path.join(options.state, `${encodeURIComponent(rootThread)}.active.json`);
		let work = options.work;
		const cwd = id(event.cwd);
		const dispatch = cwd
			? path.join(options.state, "dispatch", `${encodeURIComponent(cwd)}.json`)
			: null;
		if (!work && dispatch && (yield* fs.exists(dispatch)))
			work = readWork(object(json(yield* fs.readFileString(dispatch))).work);
		const dispatched = work !== undefined;
		const unknown =
			"Fabrika issue association is unresolved. Run an issue read with a literal issue number to resume collection.";
		const ambiguous =
			"Multiple issues in one native turn; existing association retained. Start a new turn for the next issue.";
		if (!dispatched && association.kind === "unresolved") {
			yield* fs.makeDirectory(options.state, {recursive: true});
			const unresolved = JSON.stringify({unresolved: true});
			if (turn) {
				const saved = (yield* fs.exists(binding))
					? object(json(yield* fs.readFileString(binding)))
					: {};
				const previous = readWork(saved) ?? readWork(saved.previous);
				yield* fs.writeFileString(binding, JSON.stringify({unresolved: true, previous}));
			}
			yield* fs.writeFileString(active, unresolved);
		}
		if (issue !== null && turn && !dispatched) {
			const candidate = {repo: options.repo, issue, run: `codex:${rootThread}:${turn}`};
			yield* fs.makeDirectory(options.state, {recursive: true});
			const saved = (yield* fs.exists(binding))
				? object(json(yield* fs.readFileString(binding)))
				: null;
			if (saved?.unresolved === true) {
				const previous = readWork(saved.previous);
				if (previous && previous.issue !== issue) return advisory([ambiguous]);
				yield* fs.writeFileString(binding, JSON.stringify(candidate));
			} else if (saved === null)
				yield* fs.writeFileString(binding, JSON.stringify(candidate), {flag: "wx"});
			const stored = object(json(yield* fs.readFileString(binding)));
			if (stored.issue !== issue) return advisory([ambiguous]);
			const crypto = yield* Crypto.Crypto;
			const temp = `${active}.${yield* crypto.randomUUIDv4}`;
			yield* fs.writeFileString(temp, JSON.stringify(stored));
			yield* fs.rename(temp, active);
		}
		if (!work && turn && !(yield* fs.exists(binding)) && (yield* fs.exists(active))) {
			yield* fs.writeFileString(binding, yield* fs.readFileString(active), {flag: "wx"});
		}
		const expected = id(event.agent_id);
		const childTranscript = id(event.agent_transcript_path);
		const roster = path.join(options.state, `${encodeURIComponent(rootThread)}.children`);
		if (expected) {
			yield* fs.makeDirectory(roster, {recursive: true});
			yield* fs.writeFileString(path.join(roster, encodeURIComponent(expected)), expected);
		}
		const children = (yield* fs.exists(roster))
			? (yield* fs.readDirectory(roster)).map((name) => decodeURIComponent(name))
			: [];
		const bindings: Array<{work: CodexWork; rootTurn?: string}> = work ? [{work}] : [];
		const notices: string[] = !dispatched && association.kind === "unresolved" ? [unknown] : [];
		if (!work && (yield* fs.exists(options.state))) {
			for (const name of yield* fs.readDirectory(options.state)) {
				const prefix = `${encodeURIComponent(rootThread)}-`;
				if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
				const saved = json(yield* fs.readFileString(path.join(options.state, name)));
				if (object(saved).unresolved === true) {
					notices.push(unknown);
					const rootTurn = decodeURIComponent(name.slice(prefix.length, -5));
					bindings.push({
						work: {repo: options.repo, issue: null, run: `codex:${rootThread}:${rootTurn}`},
						rootTurn,
					});
					continue;
				}
				const bound = readWork(saved);
				if (!bound) return advisory(["Saved Fabrika association is unreadable."]);
				bindings.push({work: bound, rootTurn: decodeURIComponent(name.slice(prefix.length, -5))});
			}
		}
		if (!bindings.length && association.kind === "continuation") notices.push(unknown);
		for (const bound of bindings) {
			const result = yield* collectCodex({
				sessions: options.sessions,
				ledger: options.ledger,
				rootThread,
				...bound,
				transcripts: [
					...(transcript ? [transcript] : []),
					...(childTranscript ? [childTranscript] : []),
				],
				expected: children,
			});
			notices.push(...result.notices);
		}
		return advisory([...new Set(notices)]);
	},
	Effect.catch(() =>
		Effect.succeed(
			advisory(["Recording IO failed; retry the hook after storage recovers. Work is unchanged."]),
		),
	),
);
