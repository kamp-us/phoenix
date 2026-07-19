/**
 * The declared manifest for `adoption-lint` — the tool-owned decisions the crew
 * corpus must CITE rather than re-derive, plus the self-linted exemptions.
 *
 * This is the extension seam for epic #3258: each sibling verb-child that extracts
 * a recurring envelope into a shared verb appends its decision here AND migrates
 * its consumers same-commit (the #3254 rule), drawing the corresponding
 * `grandfathered` entries below down to zero. The lint refuses to let that pile
 * GROW — a NEW file re-deriving a declared decision without citing the verb and
 * without a declared exemption reds the build.
 *
 * Seeded with the canonical #3254 example — `verdict read`, whose ADR-0058
 * SHA-bound marker-resolution three skills hand-copy (#2102). The remaining
 * envelope decisions (claim, apply-triage, create, post-verdict, graduate) arrive
 * with their sibling children (#3262–#3266), each with its own consumer migration.
 */
import type {Exemption, OwnedDecision} from "./adoption-lint.ts";

/**
 * The tool-owned decisions the corpus must cite by contract.
 *
 * `verdict read` owns the ADR-0058 SHA-bound verdict-marker resolution — resolve
 * the latest (PR, gate) verdict, author-gated to write+ collaborators (ADR 0055),
 * bound to the PR's current head. Its fingerprint is the co-occurrence of the
 * marker regex, the write+ ACL permission loop, and a latest-wins resolution — the
 * three tells that mark a hand-copy of the procedure rather than an incidental
 * mention. A file that cites `pipeline-cli verdict` is compliant.
 */
export const DECISIONS: ReadonlyArray<OwnedDecision> = [
	{
		verb: "verdict read",
		signature: [
			/review-\((?:code|doc|skill)/, // the gate-marker namespace regex
			/collaborators\/[^/]*\/?permission|collaborators\//, // the write+ ACL loop (ADR 0055)
			/sort_by\(|\blast\b/, // the latest-wins resolution
		],
		citation: /pipeline-cli\s+verdict\b/,
		reason:
			"re-derives the ADR-0058 SHA-bound verdict-marker resolution that `pipeline-cli verdict read` owns, instead of citing the verb (#3254 / #2102)",
	},
	{
		// `tracker apply-triage` owns the label-transition envelope (#3263): add the
		// type/priority/status classification then remove the needs-triage queue label. The
		// fingerprint is the co-occurrence of all three tells — adding a `type:` label, setting
		// `status:triaged`, and deleting the `status:needs-triage` queue label — so an incidental
		// `labels[]=type:` (e.g. creating a child issue in plan-epic) is not a false finding. A
		// file that cites `pipeline-cli tracker apply-triage` is compliant.
		verb: "tracker apply-triage",
		signature: [
			/labels\[\]=type:/, // adds a type label
			/labels\[\]=status:triaged/, // sets the triaged status
			/labels\/status:needs-triage/, // removes the needs-triage queue label
		],
		citation: /pipeline-cli\s+tracker\s+apply-triage\b/,
		reason:
			"re-derives the label-transition envelope that `pipeline-cli tracker apply-triage` owns (add type/priority/status, remove needs-triage), instead of citing the verb (#3263 / #3254)",
	},
];

/**
 * The self-linted exemptions. Not a blanket skip (#3254): a `mirror` must be a real,
 * non-importable execution surface still in scope; a `grandfathered` entry must
 * *still* re-derive its verb (once its sibling child migrates the consumer, the
 * entry goes stale and the lint fails until it is removed).
 *
 * `drive-issue.js` is the sole legitimate mirror: the orchestrator is a runtime
 * `.js` surface that cannot import the TS verb core, so it must inline what a
 * skill would cite. `heal-ci` and `write-code` are the two current `verdict read`
 * re-derivers named in #3254 — grandfathered here until #3265 (post-verdict)
 * extracts the verb and migrates them same-commit.
 */
export const EXEMPTIONS: ReadonlyArray<Exemption> = [
	{
		kind: "mirror",
		path: ".claude/workflows/drive-issue.js",
		reason:
			"the orchestrator is a runtime .js surface that cannot import the TS verb core — it mirrors by necessity (#3254; the sole legitimate mirror)",
	},
	{
		kind: "grandfathered",
		path: "skills/heal-ci/SKILL.md",
		verb: "verdict read",
		reason: "existing `verdict read` re-derivation — migrate to `pipeline-cli verdict` with #3265",
	},
	{
		kind: "grandfathered",
		path: "skills/write-code/SKILL.md",
		verb: "verdict read",
		reason: "existing `verdict read` re-derivation — migrate to `pipeline-cli verdict` with #3265",
	},
];
