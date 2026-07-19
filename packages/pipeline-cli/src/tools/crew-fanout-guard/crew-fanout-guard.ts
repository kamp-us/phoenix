/**
 * `crew-fanout-guard` pure core — invert the crew read-only-fanout per-bridge spawn
 * DENYLIST into an ENFORCED ALLOWLIST (issue #3606, residual from #3597/#3605).
 *
 * The roster-law boundary (ADR 0189/0196) keeps a read-only fanout from drifting into a
 * "bridge runs the pipeline" execution edge. claude-code's permission model only
 * *subtracts* denied agent-types from the all-active spawnable set — there is no "spawn
 * only X" positive primitive — so each bridge's `disallowedTools` must enumerate every
 * mutating agent-type it may not spawn. The residual hole: a NEW mutating agent-type added
 * to the roster is silently spawnable by every bridge until someone remembers to extend
 * each denylist. This guard closes that structurally: it OWNS the per-bridge sanctioned
 * allowlist and asserts every mutating roster agent-type NOT on a bridge's allowlist is
 * denied — so a future un-allowlisted, un-denied agent-type reds the build.
 *
 * IO-free and total: every decision is a deterministic transform over already-gathered
 * facts (the parsed agent defs). The filesystem boundary (enumerate the agent dirs, read
 * each def) lives in `gate.ts`; this module never touches disk.
 *
 * Fail-closed by construction (ADR 0092): zero roster / zero bridges, a missing bridge
 * def, a stale allowlist entry, or any uncovered mutating agent-type is a RED verdict —
 * never a vacuous pass.
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
 * Each bridge's SANCTIONED spawn allowlist — the enforced source of truth, NOT the def's
 * denylist. Every mutating roster agent-type absent from a bridge's allowlist must appear
 * in that bridge's `disallowedTools` `Task(...)`; a roster addition absent from BOTH reds
 * the build. Encoding the allowlist here (rather than reading it back off the denylist) is
 * what makes it *enforced*: removing a `Task(x)` deny from a bridge def without adding `x`
 * here also reds the build.
 *
 * The allowlists track each bridge's charter: the cartographer keeps its Prototype-spike
 * `coder` and ideation-legwork agents; the chief-of-staff spawns nothing (pure verify-and-
 * carry); the intake-desk owns the planning/canon seam (planner/canon/adr) plus its
 * report→triage loop (triager/reporter). See `claude-plugins/pipeline-crew/agents/`.
 */
export const BRIDGE_ALLOWLIST: Record<BridgeName, ReadonlyArray<string>> = {
	"crew-cartographer": ["coder", "planner", "canon", "adr", "triager", "reporter"],
	"crew-chief-of-staff": [],
	"crew-intake-desk": ["planner", "canon", "adr", "triager", "reporter"],
};

/** One parsed agent def reduced to the two facts the decision needs. */
export interface AgentDef {
	/** The agent-type name (its `name:` frontmatter), e.g. `crew-cartographer`. */
	readonly name: string;
	/** Agent-types this def denies spawning, extracted from `disallowedTools` `Task(<type>)`. */
	readonly disallowedTaskTypes: ReadonlyArray<string>;
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
	/** An allowlist entry names an agent-type not in the roster — policy drift, fail closed. */
	| {
			readonly pass: false;
			readonly reason: "stale-allowlist";
			readonly entries: ReadonlyArray<{readonly bridge: string; readonly agent: string}>;
	  }
	/** A mutating roster agent-type is neither allowlisted nor denied for a bridge — the hole. */
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

/** Pull the agent-type names out of `disallowedTools` `Task(<type>)` entries. */
export const disallowedTaskTypes = (disallowedTools: unknown): ReadonlyArray<string> => {
	if (!Array.isArray(disallowedTools)) return [];
	const out: Array<string> = [];
	for (const entry of disallowedTools) {
		if (typeof entry !== "string") continue;
		const t = /^Task\(([^)]+)\)$/.exec(entry.trim());
		if (t?.[1]) out.push(t[1].trim());
	}
	return out;
};

/** Parse one agent-def markdown into `{name, disallowedTaskTypes}`; null when it has no `name`. */
export const parseAgentDef = (text: string): AgentDef | null => {
	const fm = parseFrontmatter(text);
	if (!fm || typeof fm.name !== "string") return null;
	return {name: fm.name, disallowedTaskTypes: disallowedTaskTypes(fm.disallowedTools)};
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
 * any mutating roster agent-type that a bridge neither allowlists nor denies.
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
	// A stale allowlist entry (an allowlisted agent-type no longer in the roster) means the
	// policy drifted from reality — fail closed so a rename/removal forces an allowlist update.
	const stale: Array<{bridge: string; agent: string}> = [];
	for (const bridge of BRIDGE_NAMES) {
		for (const agent of BRIDGE_ALLOWLIST[bridge]) {
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
		const denied = new Set(bridge.disallowedTaskTypes);
		for (const agent of mutatingRoster) {
			if (allow.has(agent) || denied.has(agent)) continue;
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
			`deny every non-allowlisted mutating roster agent-type ` +
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
			(e) => `  ${e.bridge} allowlists "${e.agent}" (not in the roster)`,
		);
		return (
			`crew-fanout-guard: ${verdict.entries.length} stale allowlist entr` +
			`${verdict.entries.length === 1 ? "y" : "ies"} — an allowlisted agent-type is no longer a ` +
			`known agent def:\n${lines.join("\n")}\n\n` +
			"An allowlist must track the roster. Remove the stale entry from BRIDGE_ALLOWLIST, or restore\n" +
			"the agent def it names."
		);
	}
	const lines = verdict.gaps.map((g) => `  ${g.bridge} neither allowlists nor denies "${g.agent}"`);
	return (
		`crew-fanout-guard: ${verdict.gaps.length} uncovered bridge×agent-type pair` +
		`${verdict.gaps.length === 1 ? "" : "s"} — a mutating roster agent-type is spawnable by a ` +
		`bridge that should scope it out:\n${lines.join("\n")}\n\n` +
		"Every mutating roster agent-type must be either on the bridge's sanctioned allowlist\n" +
		"(BRIDGE_ALLOWLIST in crew-fanout-guard.ts) or denied in the bridge def's `disallowedTools`\n" +
		"`Task(<type>)`. A newly-added mutating agent-type must be classified before it can ship\n" +
		"(ADR 0189/0196 — keep the read-only fanout off the execution edge)."
	);
};
