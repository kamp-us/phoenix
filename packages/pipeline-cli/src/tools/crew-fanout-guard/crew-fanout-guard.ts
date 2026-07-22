/**
 * `crew-fanout-guard` pure core — assert every mutating roster agent-type is EXPLICITLY
 * CLASSIFIED per crew bridge, so the read-only fanout can't drift into a "bridge runs the
 * pipeline" execution edge (ADR 0189/0196; issue #3606, residual from #3597/#3605).
 *
 * The classification used to be read off each bridge def's `disallowedTools` `Task(<type>)`
 * entries. That mechanism does not exist: an agent-def `disallowedTools` entry is matched by
 * its BASE tool name — the `(specifier)` is IGNORED — and the WHOLE tool is subtracted from
 * the def's `tools:`. So `disallowedTools: ["Task(coder)"]` never denied the `coder`
 * subagent; it deleted `Task`, and this guard was *forcing* the declaration that left all
 * three bridges unable to spawn anything at all (#3764 — no `permissions.deny` spelling
 * blocks a spawn from a def either, so per-subagent deny has no mechanism at this layer).
 * The classification therefore lives in THIS module's own two tables, and the seam law it
 * encodes is carried to each seat as a charter rule in its def's prose.
 *
 * The residual hole the guard still closes is unchanged: a NEW mutating agent-type added to
 * the roster would be silently in-scope for every bridge until someone classified it. Every
 * mutating roster agent-type must appear on a bridge's `BRIDGE_ALLOWLIST` or its
 * `BRIDGE_OUT_OF_SCOPE`; one on neither reds the build.
 *
 * IO-free and total: every decision is a deterministic transform over already-gathered
 * facts (the parsed agent defs). The filesystem boundary (enumerate the agent dirs, read
 * each def) lives in `gate.ts`; this module never touches disk.
 *
 * Fail-closed by construction (ADR 0092): zero roster / zero bridges, a missing bridge
 * def, a stale classification entry, or any unclassified mutating agent-type is a RED
 * verdict — never a vacuous pass.
 */
import {parse as parseYaml} from "yaml";

/**
 * Read-only crew agent-types — write-tool-free by grant (ADR 0196). Excluded from the
 * mutating roster: a bridge spawning one is context hygiene, not an execution edge. A NEW
 * agent-type defaults to MUTATING (it is not on this set), so it must be explicitly
 * allowlisted or denied — the fail-closed default that catches a future roster addition.
 */
export const READ_ONLY_AGENTS: ReadonlySet<string> = new Set(["crew-investigator"]);

/** The three roster-law BRIDGE seats (ADR 0189) whose spawn scope this guard enforces. */
export const BRIDGE_NAMES = [
	"crew-cartographer",
	"crew-chief-of-staff",
	"crew-intake-desk",
] as const;
export type BridgeName = (typeof BRIDGE_NAMES)[number];

/**
 * Each bridge's SANCTIONED spawn allowlist, tracking its charter: the cartographer keeps its
 * Prototype-spike `coder` and ideation-legwork agents; the chief-of-staff spawns nothing (pure
 * verify-and-carry); the intake-desk owns the planning/canon seam (planner/canon/adr) plus its
 * report→triage loop (triager/reporter). See `claude-plugins/pipeline-crew/agents/`.
 */
export const BRIDGE_ALLOWLIST: Record<BridgeName, ReadonlyArray<string>> = {
	"crew-cartographer": ["coder", "planner", "canon", "adr", "triager", "reporter"],
	"crew-chief-of-staff": [],
	"crew-intake-desk": ["planner", "canon", "adr", "triager", "reporter"],
};

/**
 * Each bridge's explicitly OUT-OF-SCOPE mutating agent-types — the other half of the
 * classification, and the reason the guard has teeth: a roster addition on neither table reds
 * the build. This is a seam-law statement, not an enforcement mechanism — the platform offers
 * no per-subagent deny (see the module docblock), so a seat's own charter prose is what holds
 * the line at runtime and this table is what keeps the line from silently going unstated.
 */
export const BRIDGE_OUT_OF_SCOPE: Record<BridgeName, ReadonlyArray<string>> = {
	"crew-cartographer": [
		"reviewer",
		"shipper",
		"crew-cartographer",
		"crew-chief-of-staff",
		"crew-engineering-manager",
		"crew-intake-desk",
	],
	"crew-chief-of-staff": [
		"coder",
		"reviewer",
		"shipper",
		"planner",
		"canon",
		"adr",
		"triager",
		"reporter",
		"crew-cartographer",
		"crew-chief-of-staff",
		"crew-engineering-manager",
		"crew-intake-desk",
	],
	"crew-intake-desk": [
		"coder",
		"reviewer",
		"shipper",
		"crew-cartographer",
		"crew-chief-of-staff",
		"crew-engineering-manager",
		"crew-intake-desk",
	],
};

/** One parsed agent def reduced to the one fact the decision needs. */
export interface AgentDef {
	/** The agent-type name (its `name:` frontmatter), e.g. `crew-cartographer`. */
	readonly name: string;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable: a pass
 * never carries a gap list, and each failure shape carries exactly its evidence.
 */
export type CrewFanoutVerdict =
	| {
			readonly pass: true;
			readonly mutatingRoster: ReadonlyArray<string>;
			readonly bridges: ReadonlyArray<string>;
	  }
	/** No agent defs or no bridge defs in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly detail: string}
	/** An expected bridge def is absent — can't verify a bridge whose file vanished. */
	| {
			readonly pass: false;
			readonly reason: "missing-bridge";
			readonly missing: ReadonlyArray<string>;
	  }
	/** A classification entry names an agent-type not in the roster — policy drift, fail closed. */
	| {
			readonly pass: false;
			readonly reason: "stale-allowlist";
			readonly entries: ReadonlyArray<{readonly bridge: string; readonly agent: string}>;
	  }
	/** A mutating roster agent-type is on neither of a bridge's classification tables — the hole. */
	| {
			readonly pass: false;
			readonly reason: "uncovered";
			readonly gaps: ReadonlyArray<{readonly bridge: string; readonly agent: string}>;
	  };

/** Extract the YAML frontmatter block (between the leading `---` fences) and parse it. */
export const parseFrontmatter = (text: string): Record<string, unknown> | null => {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m?.[1]) return null;
	const parsed = parseYaml(m[1]);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
};

/** Parse one agent-def markdown into `{name}`; null when it has no `name`. */
export const parseAgentDef = (text: string): AgentDef | null => {
	const fm = parseFrontmatter(text);
	return fm && typeof fm.name === "string" ? {name: fm.name} : null;
};

/** The facts the pure verdict is computed over — gathered at the filesystem boundary. */
export interface CrewFanoutInput {
	/** Every discovered agent-type name across both agent dirs (the roster). */
	readonly rosterAgents: ReadonlyArray<string>;
	/** The bridge defs actually found on disk, parsed. */
	readonly bridges: ReadonlyArray<AgentDef>;
}

/**
 * Decide the verdict. Fails closed on zero scope, a missing bridge, a stale allowlist, or
 * any mutating roster agent-type that a bridge neither allowlists nor scopes out.
 */
export const judge = (input: CrewFanoutInput): CrewFanoutVerdict => {
	if (input.rosterAgents.length === 0) {
		return {pass: false, reason: "zero-scope", detail: "no agent defs discovered"};
	}
	if (input.bridges.length === 0) {
		return {pass: false, reason: "zero-scope", detail: "no bridge defs discovered"};
	}

	const found = new Set(input.bridges.map((b) => b.name));
	const missing = BRIDGE_NAMES.filter((n) => !found.has(n));
	if (missing.length > 0) {
		return {pass: false, reason: "missing-bridge", missing};
	}

	const rosterSet = new Set(input.rosterAgents);
	// A stale classification entry (an agent-type on either table but no longer in the roster)
	// means the policy drifted from reality — fail closed so a rename/removal forces an update.
	const stale: Array<{bridge: string; agent: string}> = [];
	for (const bridge of BRIDGE_NAMES) {
		for (const agent of [...BRIDGE_ALLOWLIST[bridge], ...BRIDGE_OUT_OF_SCOPE[bridge]]) {
			if (!rosterSet.has(agent)) stale.push({bridge, agent});
		}
	}
	if (stale.length > 0) {
		return {pass: false, reason: "stale-allowlist", entries: stale};
	}

	const mutatingRoster = [...rosterSet].filter((a) => !READ_ONLY_AGENTS.has(a)).sort();

	const gaps: Array<{bridge: string; agent: string}> = [];
	for (const bridge of input.bridges) {
		if (!(bridge.name in BRIDGE_ALLOWLIST)) continue;
		const allow = new Set(BRIDGE_ALLOWLIST[bridge.name as BridgeName]);
		const outOfScope = new Set(BRIDGE_OUT_OF_SCOPE[bridge.name as BridgeName]);
		for (const agent of mutatingRoster) {
			if (allow.has(agent) || outOfScope.has(agent)) continue;
			gaps.push({bridge: bridge.name, agent});
		}
	}
	if (gaps.length > 0) {
		return {pass: false, reason: "uncovered", gaps};
	}

	return {pass: true, mutatingRoster, bridges: input.bridges.map((b) => b.name).sort()};
};

/** Render the human-readable report for a verdict (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: CrewFanoutVerdict): string => {
	if (verdict.pass) {
		return (
			`crew-fanout-guard: all ${verdict.bridges.length} crew bridge(s) [${verdict.bridges.join(", ")}] ` +
			`classify every mutating roster agent-type ` +
			`(${verdict.mutatingRoster.length} in the mutating roster: ${verdict.mutatingRoster.join(", ")})`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`crew-fanout-guard: ${verdict.detail} — fail-closed (ADR 0092). ` +
			"Is the repo root correct, or did the crew agent-def layout change?"
		);
	}
	if (verdict.reason === "missing-bridge") {
		return (
			`crew-fanout-guard: ${verdict.missing.length} expected crew bridge def(s) absent: ` +
			`${verdict.missing.join(", ")} — fail-closed (a bridge whose def vanished can't be verified). ` +
			"Restore the def or update BRIDGE_NAMES in crew-fanout-guard.ts."
		);
	}
	if (verdict.reason === "stale-allowlist") {
		const lines = verdict.entries.map(
			(e) => `  ${e.bridge} classifies "${e.agent}" (not in the roster)`,
		);
		return (
			`crew-fanout-guard: ${verdict.entries.length} stale classification entr` +
			`${verdict.entries.length === 1 ? "y" : "ies"} — a classified agent-type is no longer a ` +
			`known agent def:\n${lines.join("\n")}\n\n` +
			"A classification must track the roster. Remove the stale entry from BRIDGE_ALLOWLIST /\n" +
			"BRIDGE_OUT_OF_SCOPE, or restore the agent def it names."
		);
	}
	const lines = verdict.gaps.map(
		(g) => `  ${g.bridge} neither allowlists nor scopes out "${g.agent}"`,
	);
	return (
		`crew-fanout-guard: ${verdict.gaps.length} unclassified bridge×agent-type pair` +
		`${verdict.gaps.length === 1 ? "" : "s"} — a mutating roster agent-type has no stated scope ` +
		`for a bridge:\n${lines.join("\n")}\n\n` +
		"Every mutating roster agent-type must be on the bridge's sanctioned allowlist\n" +
		"(BRIDGE_ALLOWLIST) or its explicit out-of-scope list (BRIDGE_OUT_OF_SCOPE), both in\n" +
		"crew-fanout-guard.ts. A newly-added mutating agent-type must be classified before it can\n" +
		"ship (ADR 0189/0196 — keep the read-only fanout off the execution edge)."
	);
};
