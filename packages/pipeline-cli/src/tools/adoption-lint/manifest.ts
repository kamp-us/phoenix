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
 * SHA-bound marker-resolution three skills hand-copy (#2102). `tracker apply-triage`
 * (#3263), `tracker post-verdict` (#3265), and `tracker graduate` (#3266) have since
 * landed with their consumer migrations; the remaining envelope decision (claim) arrives
 * with its sibling child.
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
	{
		// `tracker create-issue` owns the intake-create envelope (#3264): file a new issue with a
		// title/body that enters the needs-triage queue. The fingerprint is the co-occurrence of
		// both tells — a `-f title=` create field AND the `labels[]=status:needs-triage` intake
		// label — so an incidental issue read (`/issues/<N>`), or a create at a different stage
		// (plan-epic's `status:planned` child, wayfinder's `wayfinder:map`), is not a false finding.
		// A file that cites `pipeline-cli tracker create-issue` is compliant.
		verb: "tracker create-issue",
		signature: [
			/-f\s+"?title=/, // sets a title (a create, not a read)
			/labels\[\]=status:needs-triage/, // enters the needs-triage intake queue
		],
		citation: /pipeline-cli\s+tracker\s+create-issue\b/,
		reason:
			"re-derives the intake-create envelope that `pipeline-cli tracker create-issue` owns (POST a titled needs-triage issue), instead of citing the verb (#3264 / #3254)",
	},
	{
		// `tracker post-verdict` owns the ADR-0058 verdict/comment-post + read-back envelope (#3265):
		// compose the SHA-bound `review-<gate>: <PASS|FAIL> @ <sha>` marker, PATCH our own prior marker
		// in the namespace else POST, then re-fetch and self-verify the landed body (#3019). The
		// fingerprint is the co-occurrence of emitting the marker AS a comment body (`body=review-…`)
		// and the PATCH-own-prior upsert against the comments endpoint — so a mere DESCRIPTION of the
		// marker format (which every review skill carries) is NOT a false finding. A file that cites
		// `pipeline-cli tracker post-verdict` (or the equivalent `pipeline-cli verdict post`) is compliant.
		verb: "tracker post-verdict",
		signature: [
			/body=[^"']{0,80}review-(?:code|doc|skill|design):/, // emits the verdict marker as a comment body
			/-X\s+PATCH[^\n]*\/comments/, // the PATCH-own-prior upsert leg (else POST)
		],
		citation: /pipeline-cli\s+(?:tracker\s+post-verdict|verdict\s+post)\b/,
		reason:
			"re-derives the ADR-0058 verdict/comment-post + read-back envelope that `pipeline-cli tracker post-verdict` owns (compose the SHA-bound marker, PATCH-own-prior-else-POST, self-verify the landed body), instead of citing the verb (#3265 / #3254)",
	},
	{
		// `tracker graduate` owns the map/investigation graduation-close envelope (#3266): post the
		// `Graduated into <artifact>` source → artifact provenance record, then close the source as
		// COMPLETED (graduated, not abandoned). The fingerprint is the co-occurrence of all three
		// tells — the `Graduated into` provenance record, a comment POST that carries it, and the
		// close-as-completed PATCH (`state=closed` + `state_reason=completed`, distinct from triage's
		// `not_planned`) — so the many incidental prose mentions of "graduated" fog in wayfinder are
		// not a false finding. A file that cites `pipeline-cli tracker graduate` is compliant.
		verb: "tracker graduate",
		signature: [
			/Graduated into/, // the source → artifact provenance record
			/\/comments\s+-f\s+body=/, // the audit-comment POST leg
			/state=closed\s+-f\s+state_reason=completed/, // close as completed (not not_planned)
		],
		citation: /pipeline-cli\s+tracker\s+graduate\b/,
		reason:
			"re-derives the graduation-close envelope that `pipeline-cli tracker graduate` owns (post the source → artifact provenance record, close the source as completed), instead of citing the verb (#3266 / #3254)",
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
 * re-derivers named in #3254 — their conversion is a non-drop-in rewrite (both scans
 * do more than a single (PR, gate) resolution: write-code also counts FAIL rounds for
 * the N=3 repair cap), so #3265 deferred it to its own reviewable PR, tracked by #3619;
 * they stay grandfathered here until that migration lands and draws them down.
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
		reason:
			"existing `verdict read` re-derivation — migrate to `pipeline-cli verdict read` (deferred by #3265 to its own PR, #3619)",
	},
	{
		kind: "grandfathered",
		path: "skills/write-code/SKILL.md",
		verb: "verdict read",
		reason:
			"existing `verdict read` re-derivation — migrate to `pipeline-cli verdict read` (deferred by #3265 to its own PR, #3619)",
	},
];
