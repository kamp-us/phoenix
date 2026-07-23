import {assert, describe, it} from "@effect/vitest";
import {type AgentSidecar, resolveIsolationIdentity, sidecarPathFor} from "./isolation-identity.ts";

const MAIN = "/Users/dev/code/phoenix";
const WT = `${MAIN}/.claude/worktrees/agent-a7e57067b7e49bc32`;
const TRANSCRIPT = "/Users/dev/.claude/projects/phoenix/f1052399-8e84-45a5-a5bf-bd63d3af99c9.jsonl";

const sidecar = (over: Partial<AgentSidecar> = {}): AgentSidecar => ({
	worktreePath: WT,
	agentType: "coder",
	...over,
});

describe("sidecarPathFor", () => {
	it("derives the per-subagent sidecar from the payload transcript path", () => {
		assert.strictEqual(
			sidecarPathFor({transcriptPath: TRANSCRIPT, agentId: "a7e57067b7e49bc32"}),
			"/Users/dev/.claude/projects/phoenix/f1052399-8e84-45a5-a5bf-bd63d3af99c9/subagents/agent-a7e57067b7e49bc32.meta.json",
		);
	});

	it("returns null when the payload cannot name a sidecar", () => {
		assert.isNull(sidecarPathFor({transcriptPath: "", agentId: "abc"}));
		assert.isNull(sidecarPathFor({transcriptPath: TRANSCRIPT, agentId: ""}));
		assert.isNull(sidecarPathFor({transcriptPath: "/no/suffix", agentId: "abc"}));
	});

	it("rejects a separator-bearing agent id rather than escaping it", () => {
		assert.isNull(sidecarPathFor({transcriptPath: TRANSCRIPT, agentId: "../../etc/passwd"}));
		assert.isNull(sidecarPathFor({transcriptPath: TRANSCRIPT, agentId: "a/b"}));
		assert.isNull(sidecarPathFor({transcriptPath: TRANSCRIPT, agentId: "a\\b"}));
	});
});

describe("resolveIsolationIdentity — the #3682 reproduction", () => {
	it("recovers root AND agent type when BOTH env vars misreport (the live incident)", () => {
		// The observed state inside a correctly-provisioned coder worktree: $WORKTREE_ROOT unset,
		// $CLAUDE_CODE_AGENT carrying the parent crew's value.
		const id = resolveIsolationIdentity({
			sidecar: sidecar(),
			envWorktreeRoot: "",
			envAgentType: "crew-engineering-manager",
		});
		assert.strictEqual(id.worktreeRoot, WT);
		assert.strictEqual(id.worktreeRootSource, "sidecar");
		assert.strictEqual(id.agentType, "coder");
		assert.strictEqual(id.agentTypeSource, "sidecar");
	});

	it("prefers the sidecar over a set-but-stale env root", () => {
		const id = resolveIsolationIdentity({
			sidecar: sidecar(),
			envWorktreeRoot: `${MAIN}/.claude/worktrees/agent-someone-else`,
		});
		assert.strictEqual(id.worktreeRoot, WT);
		assert.strictEqual(id.worktreeRootSource, "sidecar");
	});
});

describe("resolveIsolationIdentity — falling back down the evidence chain", () => {
	it("falls back to git plumbing when the sidecar is unreadable", () => {
		const id = resolveIsolationIdentity({
			sidecar: null,
			gitToplevel: WT,
			isLinkedWorktree: true,
		});
		assert.strictEqual(id.worktreeRoot, WT);
		assert.strictEqual(id.worktreeRootSource, "git-plumbing");
	});

	it("never reports the PRIMARY checkout as a worktree root", () => {
		// git-dir == common-dir ⇒ the toplevel is the shared tree. Reporting it as an isolated
		// agent's root is the exact confusion that lets an edit land in the primary checkout.
		const id = resolveIsolationIdentity({
			sidecar: null,
			gitToplevel: MAIN,
			isLinkedWorktree: false,
		});
		assert.strictEqual(id.worktreeRoot, "");
		assert.strictEqual(id.worktreeRootSource, "none");
	});

	it("uses the env root only as a last resort", () => {
		const id = resolveIsolationIdentity({
			sidecar: null,
			isLinkedWorktree: false,
			envWorktreeRoot: WT,
		});
		assert.strictEqual(id.worktreeRoot, WT);
		assert.strictEqual(id.worktreeRootSource, "env");
	});

	it("prefers the payload agent type over the inherited env one", () => {
		const id = resolveIsolationIdentity({
			sidecar: null,
			payloadAgentType: "coder",
			envAgentType: "crew-engineering-manager",
		});
		assert.strictEqual(id.agentType, "coder");
		assert.strictEqual(id.agentTypeSource, "payload");
	});

	it("degrades to today's env-only answer when nothing better exists", () => {
		const id = resolveIsolationIdentity({
			sidecar: null,
			envWorktreeRoot: WT,
			envAgentType: "coder",
		});
		assert.strictEqual(id.worktreeRootSource, "env");
		assert.strictEqual(id.agentTypeSource, "env");
	});

	it("resolves to empty/none rather than inventing a target", () => {
		const id = resolveIsolationIdentity({sidecar: null});
		assert.strictEqual(id.worktreeRoot, "");
		assert.strictEqual(id.worktreeRootSource, "none");
		assert.strictEqual(id.agentType, "");
		assert.strictEqual(id.agentTypeSource, "none");
	});

	it("treats whitespace-only inputs as absent", () => {
		const id = resolveIsolationIdentity({
			sidecar: sidecar({worktreePath: "   ", agentType: "  "}),
			envWorktreeRoot: "  ",
			envAgentType: " ",
		});
		assert.strictEqual(id.worktreeRootSource, "none");
		assert.strictEqual(id.agentTypeSource, "none");
	});
});
