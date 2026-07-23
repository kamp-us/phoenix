/**
 * `worktree-guard` isolation-identity core — resolve WHO this hook invocation is and WHICH
 * worktree it owns, without trusting the process env (#3682).
 *
 * The defect this exists to remove: every worktree-isolation consumer keyed on `$WORKTREE_ROOT`
 * and `$CLAUDE_CODE_AGENT`, and **neither is reliable for a subagent**. `$WORKTREE_ROOT` is
 * written by nothing in this repo and is not injected by the harness, so it reads empty inside a
 * correctly-provisioned worktree; `$CLAUDE_CODE_AGENT` is inherited, so a coder nested under the
 * crew reports its parent's `engineering-manager`. Both were observed misreporting *simultaneously*
 * in a live coder whose worktree was provisioned correctly — the guard layer was disarmed by the
 * key, not by a provisioning failure. See ADR 0199.
 *
 * The authoritative source is the per-subagent sidecar the harness writes next to the transcript
 * (`<transcript-dir>/<session>/subagents/agent-<agentId>.meta.json`), carrying the agent's OWN
 * `worktreePath` + `agentType`. `reap` already trusts this same sidecar for its owner gate (#2798);
 * this core generalizes that one-off read into the shared identity resolution the other hooks need.
 *
 * Pure and IO-free by design: the caller reads the sidecar and runs the git probes, so every
 * precedence rule below is unit-testable without a filesystem or a spawned agent.
 */

/** Where a resolved field came from — carried so an attribution record can be audited, not guessed. */
export type IdentitySource = "sidecar" | "git-plumbing" | "payload" | "env" | "none";

/** The fields this core consumes from the harness's per-subagent `agent-<id>.meta.json` sidecar. */
export interface AgentSidecar {
	readonly worktreePath: string;
	readonly agentType: string;
}

export interface IsolationIdentity {
	readonly worktreeRoot: string;
	readonly worktreeRootSource: IdentitySource;
	readonly agentType: string;
	readonly agentTypeSource: IdentitySource;
}

const TRANSCRIPT_SUFFIX = ".jsonl";

const trimmed = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/**
 * The sidecar path for `agentId`, derived from the hook payload's `transcript_path`.
 *
 * Shape grounded in the real on-disk artifact, not inferred: a transcript at
 * `<dir>/<session>.jsonl` has its per-subagent sidecars under `<dir>/<session>/subagents/`.
 * `null` when the inputs can't name one — an agent id carrying a path separator is rejected
 * rather than escaped, so a malformed payload can never walk the read out of that directory.
 */
export const sidecarPathFor = (args: {
	readonly transcriptPath: string;
	readonly agentId: string;
}): string | null => {
	const transcriptPath = trimmed(args.transcriptPath);
	const agentId = trimmed(args.agentId);
	if (!transcriptPath.endsWith(TRANSCRIPT_SUFFIX) || agentId === "") return null;
	if (agentId.includes("/") || agentId.includes("\\") || agentId.includes("..")) return null;
	const base = transcriptPath.slice(0, -TRANSCRIPT_SUFFIX.length);
	return `${base}/subagents/agent-${agentId}.meta.json`;
};

/**
 * Resolve this run's worktree root + agent type from the strongest evidence available.
 *
 * Precedence is evidence quality, and **the env is last in both chains** — that ordering is the
 * whole point of this core, so a future edit that promotes the env back above the sidecar is
 * re-introducing #3682's defect. `git-plumbing` is trusted for the root only when the probe proved
 * a LINKED worktree (git-dir ≠ common-dir); on the primary checkout the toplevel is the shared
 * tree, which is precisely what must never be reported as an isolated agent's root.
 *
 * Every input is allowed to be absent: an unresolvable field returns `""` with source `"none"`,
 * which is byte-identical to what the env-keyed consumers already see today. Resolution can
 * therefore only ADD evidence, never remove a fallback a caller relies on.
 */
export const resolveIsolationIdentity = (args: {
	readonly sidecar: AgentSidecar | null;
	readonly payloadAgentType?: string;
	readonly envWorktreeRoot?: string;
	readonly envAgentType?: string;
	/** `git rev-parse --show-toplevel`, or `""` when the probe could not run. */
	readonly gitToplevel?: string;
	/** `git rev-parse --absolute-git-dir` ≠ `--git-common-dir` — proof of a linked worktree. */
	readonly isLinkedWorktree?: boolean;
}): IsolationIdentity => {
	const sidecarRoot = trimmed(args.sidecar?.worktreePath);
	const sidecarAgent = trimmed(args.sidecar?.agentType);
	const gitToplevel = trimmed(args.gitToplevel);
	const envRoot = trimmed(args.envWorktreeRoot);
	const payloadAgent = trimmed(args.payloadAgentType);
	const envAgent = trimmed(args.envAgentType);

	const root: {value: string; source: IdentitySource} = sidecarRoot
		? {value: sidecarRoot, source: "sidecar"}
		: args.isLinkedWorktree === true && gitToplevel
			? {value: gitToplevel, source: "git-plumbing"}
			: envRoot
				? {value: envRoot, source: "env"}
				: {value: "", source: "none"};

	const agent: {value: string; source: IdentitySource} = sidecarAgent
		? {value: sidecarAgent, source: "sidecar"}
		: payloadAgent
			? {value: payloadAgent, source: "payload"}
			: envAgent
				? {value: envAgent, source: "env"}
				: {value: "", source: "none"};

	return {
		worktreeRoot: root.value,
		worktreeRootSource: root.source,
		agentType: agent.value,
		agentTypeSource: agent.source,
	};
};
