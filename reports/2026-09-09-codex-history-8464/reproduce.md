# Reproducer reference

Companion to the [compatibility report](../2026-09-09-codex-history-8464.md). This is an
executable evidence specimen, not repository tooling or an adapter implementation. It was run
with Node 26.2.0 and the already installed macOS arm64 codex-cli 0.153.4. It imports only Node
built-ins, including node:sqlite for read-only inspection of its own synthetic databases.
No package install, executable replacement or runtime upgrade is required or authorized.

## Invocation

Copy the JavaScript block below into `probe.mjs` in your allocated scratch directory.
`CODEX_BINARY` must name an already installed 0.153.4 executable; `SCRATCH` must be your
allocated scratch directory. Both output directory arguments must be nonexistent.

```bash
node "$SCRATCH/probe.mjs" "$CODEX_BINARY" "$SCRATCH/default-first"
node "$SCRATCH/probe.mjs" "$CODEX_BINARY" "$SCRATCH/legacy-first" legacy-first
```

Each invocation leaves `trace.json` and all generated state under that new directory.
The child environment is a literal whitelist, never a spread of the parent environment.
HOME, CODEX_HOME, cwd and temporary files are isolated; CLI auth uses files, not the keychain.
There is no preexisting auth/config/session state. The named provider uses the public OpenAI URL
with websockets disabled: no fake endpoint, no server, no model generation. The RPC allowlist
omits all turn, tool and approval operations. Starting/resuming threads may mutate only the
synthetic backend state; SQL inspection is read-only and SQL rows are never manufactured.

The driver records errors instead of replacing them with data. Identity errors, timeouts,
repeated/unbounded cursors or nonzero/signal process exits fail the run. A captured protocol
error is an observation, not an infrastructure success inference. Stop on infrastructure
failure; preserve the failing state and do not switch execution modes.

A/B reverse both new-thread-setting order and full/metadata resume order. Fixture bytes come
from the public versioned serialization/test shapes cited in the report; they contain two
synthetic completed turns. No original/private sessions are used. `default` fixtures carry
the mode the real new-thread response selected, not an invented on-disk mode. Their recorded
SHA-256 hashes before resume bind the original bytes; portable hashes in identity.md bind
the same JSONL after cwd is replaced by `$ROOT`. Absolute paths necessarily vary per run.

C predates the websocket safety adjustment: its invocation is reconstructed by omitting only
the last two `-c` pairs (model_provider and model_providers.history_probe) and running only
the fresh/fresh-restart blocks. It is retained as actual built-in-provider evidence, **not a
recommended rerun**, because thread/start attempts unauthenticated websocket prewarm.

Script SHA-256: `8c750bc293720100a799e19610ec4f022220f9dbc2bccf67b3df93b0cf711692`. All A/B evidence was captured from this exact specimen.

## Driver

```javascript
import {spawn, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	existsSync,
	realpathSync,
} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {join, resolve} from "node:path";
import {createInterface} from "node:readline";

const binary = process.argv[2];
const root = resolve(process.argv[3]);
mkdirSync(root, {recursive: false});
const home = join(root, "home");
mkdirSync(home);
const cwd = join(root, "workspace");
mkdirSync(cwd);
const env = {PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home, TMPDIR: root};
const flags = [
	"-c",
	'cli_auth_credentials_store="file"',
	"-c",
	"features.shell_snapshot=false",
	"-c",
	"features.skip_host_skill_discovery=true",
	"-c",
	'model_provider="history_probe"',
	"-c",
	'model_providers.history_probe={name="History probe",base_url="https://api.openai.com/v1",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
];
const sanitize = (value) =>
	JSON.parse(
		JSON.stringify(value).replaceAll(realpathSync(root), "$ROOT").replaceAll(root, "$ROOT"),
	);
const rows = [];
const record = (row) => {
	rows.push(sanitize(row));
	writeFileSync(join(root, "trace.json"), JSON.stringify(rows, null, 2) + "\n");
};
for (const args of [["--version"], ["features", "list", ...flags]]) {
	const result = spawnSync(binary, args, {env, cwd, encoding: "utf8"});
	if (result.status !== 0) throw new Error(`identity failed: ${result.stderr}`);
	if (args[0] === "--version" && result.stdout.trim() !== "codex-cli 0.153.4")
		throw new Error("requires exact CLI 0.153.4");
	record({kind: "identity", args, stdout: result.stdout, stderr: result.stderr});
}
record({
	kind: "binary",
	sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
	env,
	cwd,
	flags,
});
let serial = 0;
async function server(label, act) {
	const child = spawn(binary, ["app-server", ...flags], {
		env,
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map();
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	child.on("error", (error) => {
		for (const p of pending.values()) p.reject(error);
	});
	const exited = new Promise((resolve) =>
		child.on("exit", (code, signal) => {
			for (const p of pending.values()) p.reject(new Error(`server exited ${code}/${signal}`));
			resolve({code, signal});
		}),
	);
	const lines = createInterface({input: child.stdout});
	lines.on("line", (line) => {
		const message = JSON.parse(line);
		record({server: label, direction: "receive", message});
		if (message.id !== undefined && pending.has(message.id)) {
			const p = pending.get(message.id);
			pending.delete(message.id);
			clearTimeout(p.timer);
			p.resolve(message);
		}
	});
	const allowed = new Set([
		"initialize",
		"config/read",
		"thread/start",
		"thread/read",
		"thread/turns/list",
		"thread/items/list",
		"thread/resume",
		"thread/list",
	]);
	const request = (method, params, cell) => {
		if (!allowed.has(method)) throw new Error(`unsafe method ${method}`);
		const message = {id: ++serial, method, params};
		record({server: label, direction: "send", cell, message});
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(message.id);
				reject(new Error(`timeout ${cell}`));
			}, 20000);
			pending.set(message.id, {resolve, reject, timer});
			child.stdin.write(JSON.stringify(message) + "\n");
		});
	};
	try {
		const init = await request(
			"initialize",
			{
				clientInfo: {name: "public_history_probe", version: "1"},
				capabilities: {experimentalApi: true},
			},
			"initialize",
		);
		if (init.error) throw new Error(JSON.stringify(init.error));
		child.stdin.write(JSON.stringify({method: "initialized", params: {}}) + "\n");
		await act(request);
	} finally {
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
		const status = await exited;
		clearTimeout(timer);
		record({server: label, kind: "exit", ...status, stderr});
		if (status.code !== 0 || status.signal !== null)
			throw new Error(`server did not exit cleanly: ${JSON.stringify(status)}`);
	}
}
const modes = ["default", "legacy", "paginated"];
const ids = {};
const selectedModes = {};
function snapshot(label) {
	const path = join(home, "state_5.sqlite");
	if (!existsSync(path)) return record({kind: "database", label, exists: false});
	const db = new DatabaseSync(path, {readOnly: true});
	record({
		kind: "database",
		label,
		rows: db.prepare("select id, history_mode, rollout_path from threads order by id").all(),
	});
	db.close();
	const historyPath = join(home, "thread_history_1.sqlite");
	if (existsSync(historyPath)) {
		const history = new DatabaseSync(historyPath, {readOnly: true});
		const tables = history
			.prepare("select name from sqlite_master where type='table' order by name")
			.all();
		const projections = tables.some((t) => t.name === "thread_history_projection_state")
			? history.prepare("select * from thread_history_projection_state order by thread_id").all()
			: null;
		record({kind: "projection", label, tables, projections});
		history.close();
	}
}
const open = (mode) => ({
	cwd,
	sandbox: "read-only",
	approvalPolicy: "never",
	...(mode === "default" ? {} : {historyMode: mode}),
});
async function reads(request, id, label) {
	await request("thread/read", {threadId: id, includeTurns: false}, `${label}/metadata`);
	await request("thread/read", {threadId: id, includeTurns: true}, `${label}/history`);
	for (const method of ["thread/turns/list", "thread/items/list"]) {
		for (const direction of ["asc", "desc"]) {
			let cursor;
			const seen = new Set();
			for (let page = 0; page < 10; page++) {
				const reply = await request(
					method,
					{
						threadId: id,
						limit: 1,
						sortDirection: direction,
						...(method === "thread/turns/list" ? {itemsView: "full"} : {}),
						...(cursor ? {cursor} : {}),
					},
					`${label}/${method}/${direction}/${page}`,
				);
				if (reply.error || !reply.result.nextCursor) break;
				cursor = reply.result.nextCursor;
				if (seen.has(cursor)) throw new Error("cursor repeated");
				seen.add(cursor);
				if (page === 9) throw new Error("paging bound exceeded");
			}
		}
	}
}
await server("fresh", async (request) => {
	await request("config/read", {includeLayers: true}, "configuration");
	await request(
		"thread/list",
		{limit: 10, modelProviders: [], sourceKinds: ["cli", "appServer"]},
		"fresh/list-empty",
	);
	for (const mode of modes) {
		const started = await request("thread/start", open(mode), `fresh/${mode}/start`);
		if (started.error) continue;
		ids[mode] = started.result.thread.id;
		selectedModes[mode] = started.result.thread.historyMode;
		snapshot(`fresh/${mode}/before-read`);
		await reads(request, ids[mode], `fresh/${mode}`);
		snapshot(`fresh/${mode}/after-read`);
		await request(
			"thread/resume",
			{threadId: ids[mode], cwd, sandbox: "read-only", approvalPolicy: "never"},
			`fresh/${mode}/resume-full`,
		);
		await request(
			"thread/resume",
			{threadId: ids[mode], excludeTurns: true, cwd, sandbox: "read-only", approvalPolicy: "never"},
			`fresh/${mode}/resume-metadata`,
		);
	}
	const ephemeral = await request(
		"thread/start",
		{...open("default"), ephemeral: true},
		"fresh/ephemeral/start",
	);
	if (ephemeral.result) await reads(request, ephemeral.result.thread.id, "fresh/ephemeral");
	const missing = "ffffffff-ffff-4fff-8fff-ffffffffffff";
	await reads(request, missing, "missing");
	await request("thread/resume", {threadId: missing, cwd}, "missing/resume");
});
snapshot("after-fresh-exit");
await server("fresh-restart", async (request) => {
	for (const mode of modes) {
		if (!ids[mode]) continue;
		await reads(request, ids[mode], `fresh-restart/${mode}`);
		await request(
			"thread/resume",
			{threadId: ids[mode], cwd, sandbox: "read-only", approvalPolicy: "never"},
			`fresh-restart/${mode}/resume`,
		);
	}
});
snapshot("after-fresh-restart");
const fixtureIds = {};
const timestamp = "2026-01-05T12:00:00.000Z";
for (const [index, mode] of modes.entries()) {
	const id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
	fixtureIds[mode] = id;
	const persistedMode = selectedModes[mode];
	if (!persistedMode) throw new Error(`unobserved mode ${mode}`);
	const lines = [];
	const append = (type, payload) =>
		lines.push({
			timestamp,
			...(persistedMode === "paginated" ? {ordinal: lines.length} : {}),
			type,
			payload,
		});
	append("session_meta", {
		id,
		session_id: id,
		timestamp,
		cwd,
		originator: "public_synthetic_fixture",
		cli_version: "0.153.4",
		source: "cli",
		model_provider: "history_probe",
		history_mode: persistedMode,
		base_instructions: {text: "Synthetic persisted evidence. No model generation."},
	});
	for (let n = 1; n <= 2; n++) {
		const turn = `turn-${n}`;
		const start = 1767614400 + n * 10;
		const user = `fixture user ${n}`;
		const assistant = `fixture assistant ${n}`;
		append("event_msg", {
			type: "task_started",
			turn_id: turn,
			started_at: start,
			model_context_window: null,
		});
		append("response_item", {
			type: "message",
			id: `response-user-${n}`,
			role: "user",
			content: [{type: "input_text", text: user}],
		});
		append("event_msg", {
			type: "user_message",
			message: user,
			images: [],
			local_images: [],
			text_elements: [],
		});
		if (persistedMode === "paginated")
			append("event_msg", {
				type: "item_completed",
				thread_id: id,
				turn_id: turn,
				item: {
					type: "UserMessage",
					id: `user-${n}`,
					content: [{type: "text", text: user, text_elements: []}],
				},
				started_at_ms: start * 1000,
				completed_at_ms: start * 1000 + 1,
			});
		append("response_item", {
			type: "message",
			id: `response-assistant-${n}`,
			role: "assistant",
			phase: "final_answer",
			content: [{type: "output_text", text: assistant}],
		});
		if (persistedMode === "paginated")
			append("event_msg", {
				type: "item_completed",
				thread_id: id,
				turn_id: turn,
				item: {
					type: "AgentMessage",
					id: `assistant-${n}`,
					content: [{type: "Text", text: assistant}],
					phase: "final_answer",
				},
				started_at_ms: start * 1000 + 2,
				completed_at_ms: start * 1000 + 3,
			});
		else append("event_msg", {type: "agent_message", message: assistant, phase: "final_answer"});
		append("event_msg", {
			type: "task_complete",
			turn_id: turn,
			last_agent_message: assistant,
			started_at: start,
			completed_at: start + 1,
			duration_ms: 1000,
		});
	}
	const directory = join(home, "sessions", "2026", "01", "05");
	mkdirSync(directory, {recursive: true});
	const path = join(directory, `rollout-2026-01-05T12-00-00-${id}.jsonl`);
	const bytes = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
	writeFileSync(path, bytes);
	record({
		kind: "fixture",
		mode,
		persistedMode,
		path,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		lines,
	});
}
const newModeOrder =
	process.argv[4] === "legacy-first" ? ["legacy", "default"] : ["default", "legacy"];
record({
	kind: "scenario",
	newModeOrder,
	resumeOrder: process.argv[4] === "legacy-first" ? "metadata-first" : "full-first",
});
for (const newThreadMode of newModeOrder) {
	await server(`nonempty-after-new-${newThreadMode}`, async (request) => {
		await request("thread/start", open(newThreadMode), `new-setting/${newThreadMode}/start`);
		await request(
			"thread/list",
			{limit: 20, modelProviders: [], sourceKinds: ["cli", "appServer"]},
			`nonempty/${newThreadMode}/list`,
		);
		snapshot(`nonempty/${newThreadMode}/before-read`);
		for (const mode of modes) {
			const id = fixtureIds[mode];
			const label = `nonempty/${mode}/after-new-${newThreadMode}`;
			await reads(request, id, label);
			const resumeOrder = process.argv[4] === "legacy-first" ? [true, false] : [false, true];
			for (const excludeTurns of resumeOrder)
				await request(
					"thread/resume",
					{threadId: id, cwd, sandbox: "read-only", approvalPolicy: "never", excludeTurns},
					`${label}/resume-${excludeTurns ? "metadata" : "full"}`,
				);
			const resumed = await request(
				"thread/resume",
				{
					threadId: id,
					cwd,
					sandbox: "read-only",
					approvalPolicy: "never",
					excludeTurns: true,
					initialTurnsPage: {limit: 1, sortDirection: "desc", itemsView: "full"},
				},
				`${label}/resume-initial-page`,
			);
			if (resumed.result?.initialTurnsPage?.nextCursor)
				await request(
					"thread/turns/list",
					{
						threadId: id,
						cursor: resumed.result.initialTurnsPage.nextCursor,
						limit: 1,
						sortDirection: "desc",
						itemsView: "full",
					},
					`${label}/resume-initial-next`,
				);
			await reads(request, id, `${label}/post-resume`);
		}
		snapshot(`nonempty/${newThreadMode}/after-read`);
	});
}
record({
	kind: "files",
	names: readdirSync(home, {recursive: true}).filter((path) => !path.startsWith("skills/")),
});
```
