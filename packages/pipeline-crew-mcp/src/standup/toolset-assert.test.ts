/**
 * standup/toolset-assert — the pre-launch declared-vs-actual seat toolset assert (issue #3764). The
 * cases pin the two silent-drop rules against the exact declarations that shipped the live defect (a
 * bridge declaring `Task`/`Grep`/`Glob` + `disallowedTools: ["Task(coder)", …]` booting as
 * `Read`/`Bash`), the fail-closed parse, and the assert's refusal shape. Every case is pure or runs
 * through an injected reader — no def on disk, no launch.
 */
import {fileURLToPath} from "node:url";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {CREW_ROLES} from "../crew/index.ts";
import {
	assertCrewSeatToolsets,
	assertSeatToolset,
	baseToolName,
	CrewSeatDefUnreadableError,
	CrewSeatToolsetMismatchError,
	type DeclaredToolset,
	parseDeclaredToolset,
	readSeatToolsetFromDef,
	resolveDeclaredToolset,
	type SeatToolsetReader,
	seatDefRelativePath,
} from "./toolset-assert.ts";

/** The repo root the shipped crew defs live under — resolved from this file, never a machine path. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const allowlist = (
	tools: readonly string[],
	disallowedTools: readonly string[] = [],
): DeclaredToolset => ({_tag: "allowlist", tools, disallowedTools});

/** The exact intake-desk declaration that booted as `Read`/`Bash` (#3764). */
const LIVE_DEFECT = allowlist(
	["Read", "Bash", "Grep", "Glob", "Task", "mcp___kampus_pipeline-crew-mcp__channel_send"],
	["Task(coder)", "Task(reviewer)", "Task(crew-intake-desk)"],
);

/** A stub reader needs no platform, so its `R` is `never` — the reason the assert is generic over it. */
const readerOf =
	(declared: DeclaredToolset): SeatToolsetReader<never> =>
	() =>
		Effect.succeed(declared);

describe("standup/toolset-assert — baseToolName", () => {
	it("strips a specifier, leaving the CLI's own match key", () => {
		assert.strictEqual(baseToolName("Task(coder)"), "Task");
		assert.strictEqual(baseToolName("Bash(rm:*)"), "Bash");
		assert.strictEqual(baseToolName("Task"), "Task");
	});
});

describe("standup/toolset-assert — resolveDeclaredToolset", () => {
	it("reproduces the live #3764 boot: the def declares six tools, the seat gets two", () => {
		const {granted, ungrantable, selfDenied} = resolveDeclaredToolset(LIVE_DEFECT);
		assert.deepStrictEqual(granted, [
			"Read",
			"Bash",
			"mcp___kampus_pipeline-crew-mcp__channel_send",
		]);
		// rule 2: Grep/Glob name no tool a top-level session is granted on this CLI
		assert.deepStrictEqual(ungrantable, ["Grep", "Glob"]);
		// rule 1: `Task(coder)` matches by BASE name, so the def deletes its own `Task`
		assert.deepStrictEqual(selfDenied, ["Task"]);
	});

	it("keeps `Task` when the def carries no disallowedTools (the engine seat's shape)", () => {
		const {granted, selfDenied} = resolveDeclaredToolset(allowlist(["Task", "Bash", "Read"]));
		assert.deepStrictEqual(granted, ["Task", "Bash", "Read"]);
		assert.deepStrictEqual(selfDenied, []);
	});

	it("subtracts by base name regardless of which tool the specifier scopes", () => {
		const {granted, selfDenied} = resolveDeclaredToolset(
			allowlist(["Read", "Bash", "Task"], ["Bash(rm:*)"]),
		);
		assert.deepStrictEqual(granted, ["Read", "Task"]);
		assert.deepStrictEqual(selfDenied, ["Bash"]);
	});

	it("ignores a disallowedTools entry naming a tool the def never allowlisted", () => {
		const {granted, selfDenied} = resolveDeclaredToolset(
			allowlist(["Read", "Bash", "Task"], ["Write(*)"]),
		);
		assert.deepStrictEqual(granted, ["Read", "Bash", "Task"]);
		assert.deepStrictEqual(selfDenied, []);
	});

	it("exempts MCP tokens from the grantable check — their absence is the channel connect window", () => {
		const {granted, ungrantable} = resolveDeclaredToolset(
			allowlist(["mcp___kampus_pipeline-crew-mcp__channel_claim"]),
		);
		assert.deepStrictEqual(granted, ["mcp___kampus_pipeline-crew-mcp__channel_claim"]);
		assert.deepStrictEqual(ungrantable, []);
	});

	it("has nothing to resolve for a def that declares no allowlist", () => {
		assert.deepStrictEqual(resolveDeclaredToolset({_tag: "inherit"}), {
			granted: [],
			ungrantable: [],
			selfDenied: [],
		});
	});
});

describe("standup/toolset-assert — parseDeclaredToolset", () => {
	it("parses the flow-sequence frontmatter every crew def writes", () => {
		const parsed = parseDeclaredToolset(
			[
				"---",
				"name: crew-intake-desk",
				'tools: ["Read", "Bash", "Task"]',
				'disallowedTools: ["Task(coder)"]',
				"---",
				"",
				"body",
			].join("\n"),
		);
		assert.deepStrictEqual(parsed, allowlist(["Read", "Bash", "Task"], ["Task(coder)"]));
	});

	it("reads a def with no disallowedTools as an empty deny list", () => {
		const parsed = parseDeclaredToolset(
			["---", "name: crew-engineering-manager", 'tools: ["Task", "Bash"]', "---", "", "body"].join(
				"\n",
			),
		);
		assert.deepStrictEqual(parsed, allowlist(["Task", "Bash"], []));
	});

	it("reads a def with no `tools:` as inheriting the CLI default toolset", () => {
		const parsed = parseDeclaredToolset(["---", "name: some-agent", "---", "", "body"].join("\n"));
		assert.deepStrictEqual(parsed, {_tag: "inherit"});
	});

	it("fails closed on a `tools:` present in a shape it does not parse", () => {
		// A block sequence is valid YAML the CLI would honour — but an unparsed declaration is exactly
		// the silent degradation the assert exists to catch, so refusing beats skipping.
		assert.strictEqual(
			parseDeclaredToolset(["---", "name: a", "tools:", '  - "Read"', "---", "", "b"].join("\n")),
			null,
		);
	});

	it("fails closed on a def with no frontmatter at all", () => {
		assert.strictEqual(parseDeclaredToolset("just a body"), null);
	});
});

describe("standup/toolset-assert — assertSeatToolset", () => {
	it("refuses the live #3764 declaration, naming both rules and every dropped tool", () =>
		Effect.runSync(
			Effect.gen(function* () {
				const err = yield* Effect.flip(assertSeatToolset("intake-desk", "def.md", LIVE_DEFECT));
				assert.instanceOf(err, CrewSeatToolsetMismatchError);
				assert.strictEqual(err.role, "intake-desk");
				assert.deepStrictEqual(err.ungrantable, ["Grep", "Glob"]);
				assert.deepStrictEqual(err.selfDenied, ["Task"]);
				assert.include(err.reason, "Grep");
				assert.include(err.reason, "Task");
				assert.include(err.reason, "disallowedTools");
			}),
		));

	it("passes a declaration whose every name resolves", () =>
		Effect.runSync(
			assertSeatToolset(
				"intake-desk",
				"def.md",
				allowlist(["Read", "Bash", "Task", "mcp___kampus_pipeline-crew-mcp__channel_send"]),
			),
		));
});

describe("standup/toolset-assert — assertCrewSeatToolsets", () => {
	it("names the seat's own def path in a refusal", () =>
		Effect.runSync(
			Effect.gen(function* () {
				const err = yield* Effect.flip(
					assertCrewSeatToolsets("/repo", ["chief-of-staff"], readerOf(LIVE_DEFECT)),
				);
				assert.instanceOf(err, CrewSeatToolsetMismatchError);
				assert.strictEqual(err.defPath, seatDefRelativePath("chief-of-staff"));
				assert.include(err.defPath, "crew-chief-of-staff.md");
			}),
		));

	it("proceeds over every seat when each declaration resolves", () =>
		Effect.runSync(
			assertCrewSeatToolsets(
				"/repo",
				["intake-desk", "engineering-manager"],
				readerOf(allowlist(["Read", "Bash", "Task"])),
			),
		));

	it("propagates an unreadable def rather than skipping the seat", () =>
		Effect.runSync(
			Effect.gen(function* () {
				const failing: SeatToolsetReader<never> = (_root, role) =>
					Effect.fail(
						new CrewSeatDefUnreadableError({role, defPath: "def.md", reason: "cannot read"}),
					);
				const err = yield* Effect.flip(assertCrewSeatToolsets("/repo", ["cartographer"], failing));
				assert.instanceOf(err, CrewSeatDefUnreadableError);
				assert.strictEqual(err.role, "cartographer");
			}),
		));

	// The regression the whole module exists for: every SHIPPED crew def must boot the seat with the
	// toolset it declares. This reads the real defs off disk, so a def edit that reintroduces `Grep`,
	// `Glob`, or a self-denying `disallowedTools` reds here rather than at a live stand-up.
	it.effect("every shipped crew def declares a toolset that resolves intact", () =>
		assertCrewSeatToolsets(REPO_ROOT, [...CREW_ROLES], readSeatToolsetFromDef).pipe(
			Effect.provide(NodeServices.layer),
		),
	);

	// #3761: the discovery tool `channel_kinds` must be CALLABLE from every sending seat, not just
	// served — the def's `tools:` allowlist is the hard gate, so its token must be present (MCP tokens
	// are exempt from the grantable check, so a listed token lands in `granted`). Reads the real defs:
	// a seat that drops the token — the exact defect that left channel_kinds present-but-uncallable in
	// every seat — reds here rather than at a live stand-up.
	it.effect(
		"every shipped crew seat can call channel_kinds (its token is in the granted set)",
		() =>
			Effect.gen(function* () {
				for (const role of CREW_ROLES) {
					const declared = yield* readSeatToolsetFromDef(REPO_ROOT, role);
					const {granted} = resolveDeclaredToolset(declared);
					assert.include(
						granted,
						"mcp___kampus_pipeline-crew-mcp__channel_kinds",
						`crew-${role} must list the channel_kinds allowlist token so the discovery tool is callable`,
					);
				}
			}).pipe(Effect.provide(NodeServices.layer)),
	);
});
