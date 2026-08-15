/**
 * The fixtures every `spike` test drives from, so five verb suites agree about what a well-formed
 * workspace, manifest, evidence log and spike issue look like — and a change to one of those shapes
 * reds in one place rather than drifting across five.
 */

import type {EvidenceRecord, Manifest} from "./workspace.ts";
import {
	evidencePath,
	manifestPath,
	renderEvidenceLine,
	renderManifest,
	sha256OfText,
	workspacePath,
} from "./workspace.ts";

export const REPO = "o/r";
export const NONCE = "7f3a9c21";
export const SPIKE = 9310;
export const TREE_ROOT = "/repo";
export const TMP_ROOT = "/tmp-root";
export const QUESTION = "does a single-use token need a new table?";
export const WORKSPACE = workspacePath(TMP_ROOT, NONCE);
export const MANIFEST = manifestPath(WORKSPACE);
export const EVIDENCE = evidencePath(WORKSPACE);
export const CLEAN_TREE_DIGEST = sha256OfText("");

/**
 * A temp root of the shape a real machine hands out — one the leak scanner recognises, unlike
 * {@link TMP_ROOT}. It is what a masking test must sit on: a workspace under `/tmp-root` is not a
 * leak, so it cannot prove the refusal #5553 named.
 */
export const LEAKY_TMP_ROOT = "/var/folders/z9/t0000000";
export const LEAKY_WORKSPACE = workspacePath(LEAKY_TMP_ROOT, NONCE);
export const LEAKY_MANIFEST = manifestPath(LEAKY_WORKSPACE);
export const LEAKY_EVIDENCE = evidencePath(LEAKY_WORKSPACE);

export const ENV = {CLAUDE_PIPELINE_REPO: REPO} as Record<string, string | undefined>;

export const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
	spike: SPIKE,
	nonce: NONCE,
	kind: "logic",
	question: QUESTION,
	repo: REPO,
	ticket: null,
	treeDigest: CLEAN_TREE_DIGEST,
	treeRoot: TREE_ROOT,
	...overrides,
});

export const manifestText = (overrides: Partial<Manifest> = {}): string =>
	renderManifest(manifest(overrides));

export const evidenceRecord = (
	seq: number,
	overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord => ({
	seq,
	command: ["printf", "no\\n"],
	commandExit: 0,
	timedOut: false,
	outBytes: 3,
	errBytes: 0,
	truncated: false,
	outSha256: sha256OfText("no\n"),
	errSha256: sha256OfText(""),
	...overrides,
});

export const evidenceText = (records: ReadonlyArray<EvidenceRecord>): string =>
	records.map(renderEvidenceLine).join("");

/** The one-run log every capture/dispose test rests on, and the digest a marker must carry. */
export const ONE_RUN = evidenceText([evidenceRecord(1)]);
export const ONE_RUN_DIGEST = sha256OfText(ONE_RUN);

export const issuePayload = (
	overrides: {
		readonly number?: number;
		readonly title?: string;
		readonly body?: string;
		readonly state?: string;
		readonly labels?: ReadonlyArray<string>;
	} = {},
): string =>
	JSON.stringify({
		number: overrides.number ?? SPIKE,
		title: overrides.title ?? `spike: ${QUESTION}`,
		body: overrides.body ?? "## Question\n",
		state: overrides.state ?? "open",
		labels: (overrides.labels ?? ["prototyping:spike"]).map((name) => ({name})),
		html_url: `https://example.test/#${overrides.number ?? SPIKE}`,
		user: {login: "agent"},
	});

export const commentsPayload = (
	comments: ReadonlyArray<{
		readonly id: number;
		readonly body: string;
		readonly createdAt?: string;
	}>,
): string =>
	JSON.stringify(
		comments.map((comment) => ({
			id: comment.id,
			body: comment.body,
			created_at: comment.createdAt ?? "2026-08-10T00:00:00Z",
			updated_at: comment.createdAt ?? "2026-08-10T00:00:00Z",
			user: {login: "agent"},
		})),
	);

/** The command lines the fake spawner is scripted on. */
export const ROOT = /^git rev-parse --show-toplevel$/;
export const STATUS = /^git -C \/repo status --porcelain=v1/;
export const LABELS = /^gh api --paginate repos\/o\/r\/labels\?/;
export const ISSUE = /^gh api repos\/o\/r\/issues\/9310$/;
export const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/9310\/comments\?/;
export const CREATE = /^gh api --method POST repos\/o\/r\/issues -f/;
export const POST = /^gh api --method POST repos\/o\/r\/issues\/9310\/comments -f/;
export const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;
export const CLOSE = /^gh api --method PATCH repos\/o\/r\/issues\/9310 -f state=closed/;
export const VIEWER = /^gh api user --jq \.login$/;
export const PERMISSION = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
export const OPEN_SPIKES = /^gh api --paginate repos\/o\/r\/issues\?state=open&labels=/;
