/**
 * The `tracker` tool — `pipeline-cli tracker claim <target>` /
 * `pipeline-cli tracker read-back <target>` / `pipeline-cli tracker apply-triage <target>` /
 * `pipeline-cli tracker create-issue` / `pipeline-cli tracker create-comment <target>` /
 * `pipeline-cli tracker post-verdict <target>` / `pipeline-cli tracker graduate <target>`.
 *
 * The CLI surface of the Wave-1 `Tracker` service (ADR 0190): `claim` posts the ADR-0115
 * agent-distinguishable claim and exits 0 only when the claim is ours; `read-back` resolves
 * and prints the current owner; `apply-triage` applies a type/priority/status classification
 * and drops the entity out of the needs-triage queue (#3263); `create-issue` files a new
 * issue and `create-comment` adds a note (#3264); `post-verdict` upserts a SHA-bound
 * ADR-0058 gate verdict comment and reads it back (#3265); `graduate` posts the
 * source → artifact provenance record and closes the source as completed (#3266).
 * Judgment-as-parameter: the claiming identity, the classification, the created content, the
 * verdict (gate / PASS|FAIL / bound head / prose), and the graduation artifact are supplied,
 * not decided by the tool — the claim session
 * id defaults to `$CLAUDE_CODE_SESSION_ID` (the only agent-distinguishable signal under the
 * shared `usirin` login) and `--session` overrides it for the orchestrated/delegated-token
 * path and for tests; an absent value fails closed. A create `--body` defaults to stdin, so
 * a composed markdown body streams straight in (no shared temp file, no `-f body=@file`
 * local-path leak — the #2002 hazard class is gone, not hand-guarded).
 *
 * `GithubTrackerLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {
	type ClaimResult,
	type CommentResult,
	type CreateIssueResult,
	GithubTrackerLive,
	type GraduateResult,
	type ReadBackResult,
	Tracker,
	type TriageResult,
	type VerdictResult,
} from "./tracker.ts";

const BACKOFF_EXIT_CODE = 1;

const targetArg = Argument.integer("target").pipe(
	Argument.withDescription("the tracker entity (issue / PR) number the verb acts on"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription(
		"the claiming session id (default: $CLAUDE_CODE_SESSION_ID); the delegated token on the orchestrated path",
	),
);

const resolveSession = (session: Option.Option<string>): string =>
	Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();

/** Print the back-off reason on stderr and exit non-zero — the "did not claim" signal. */
const backOff = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`tracker: ${reason}\n`);
		process.exit(BACKOFF_EXIT_CODE);
	});

const reportClaim = (target: number, result: ClaimResult): Effect.Effect<void> => {
	switch (result._tag) {
		case "claimed":
			return Console.log(`tracker: claimed #${target} (session ${result.session}) — proceed.`);
		case "held-by-other":
			return backOff(
				`#${target} is already claimed by another agent (session ${result.owner.session}, at ${result.owner.claimedAt}) — BACK OFF, do not mutate.`,
			);
		case "lost":
			return backOff(
				`lost the co-claim on #${target}` +
					(result.owner !== null
						? ` (earliest authorized claim is session ${result.owner.session})`
						: " (our claim is not authorized — a write+ collaborator must post it)") +
					" — BACK OFF, do not mutate.",
			);
	}
};

const claim = Command.make(
	"claim",
	{target: targetArg, session: sessionFlag},
	Effect.fn(function* ({target, session}) {
		const sessionId = resolveSession(session);
		if (sessionId === "") {
			return yield* backOff(
				"no CLAUDE_CODE_SESSION_ID (and no --session) — cannot post an agent-distinguishable claim. BACK OFF, do not mutate.",
			);
		}
		const result = yield* (yield* Tracker).claim(target, {session: sessionId});
		yield* reportClaim(target, result);
	}),
).pipe(
	Command.withDescription(
		"Claim a tracker entity (exit 0 = held by us; non-zero = backed off, do not mutate)",
	),
);

const reportReadBack = (target: number, result: ReadBackResult): Effect.Effect<void> =>
	result._tag === "owned"
		? Console.log(
				`tracker: #${target} is claimed by session ${result.owner.session} (at ${result.owner.claimedAt}).`,
			)
		: Console.log(`tracker: #${target} is unclaimed.`);

const readBack = Command.make(
	"read-back",
	{target: targetArg},
	Effect.fn(function* ({target}) {
		const result = yield* (yield* Tracker).readBack(target);
		yield* reportReadBack(target, result);
	}),
).pipe(Command.withDescription("Read back and print the current claim owner of a tracker entity"));

// Judgment-as-parameter (#3252): the classification is supplied, not decided by the tool.
// `--status` defaults to the `triaged` lifecycle stage — the common triage transition.
const typeFlag = Flag.string("type").pipe(
	Flag.withDescription("the domain type classification (e.g. feature, bug, chore)"),
);

const priorityFlag = Flag.string("p").pipe(
	Flag.withDescription("the domain priority (e.g. p0, p1, p2)"),
);

const statusFlag = Flag.string("status").pipe(
	Flag.optional,
	Flag.withDescription("the target lifecycle stage (default: triaged)"),
);

const reportTriage = (target: number, result: TriageResult): Effect.Effect<void> =>
	Console.log(
		`tracker: triaged #${target} — type:${result.type} ${result.priority} status:${result.status}.`,
	);

const applyTriage = Command.make(
	"apply-triage",
	{target: targetArg, type: typeFlag, p: priorityFlag, status: statusFlag},
	Effect.fn(function* ({target, type, p, status}) {
		const result = yield* (yield* Tracker).applyTriage(target, {
			type,
			priority: p,
			status: Option.getOrElse(status, () => "triaged"),
		});
		yield* reportTriage(target, result);
	}),
).pipe(
	Command.withDescription(
		"Apply a triage classification (type / priority / status) to a tracker entity, leaving the needs-triage queue",
	),
);

// The create envelope (#3264): title/body/stage as parameters. `--body` defaults to stdin so
// a composed markdown body streams straight in — the report/wayfinder/architecture-audit
// intake flows pipe their heredoc into the verb, keeping the #2002 no-shared-temp-file property.
const titleFlag = Flag.string("title").pipe(Flag.withDescription("the new issue's title"));

const bodyFlag = Flag.string("body").pipe(
	Flag.optional,
	Flag.withDescription("the issue/comment body (default: read from stdin)"),
);

const stageFlag = Flag.string("stage").pipe(
	Flag.optional,
	Flag.withDescription("the lifecycle stage the new issue enters at (default: needs-triage)"),
);

/** The body from `--body`, else streamed from stdin (fd 0); an unreadable stream ⇒ empty. */
const resolveBody = (body: Option.Option<string>): string => {
	// biome-ignore lint/plugin: best-effort stdin read — a failed/absent stream is an empty body (the CLI's pre-verb input marshalling), never the E channel; a total helper, not Effect-cosplay. Mirrors trivial-diff's readDiff.
	try {
		return Option.match(body, {
			onSome: (b) => b,
			onNone: () => readFileSync(0, "utf8"),
		});
	} catch {
		return "";
	}
};

const reportCreated = (result: CreateIssueResult): Effect.Effect<void> =>
	Console.log(`tracker: created #${result.target} — ${result.url}`);

const createIssue = Command.make(
	"create-issue",
	{title: titleFlag, body: bodyFlag, stage: stageFlag},
	Effect.fn(function* ({title, body, stage}) {
		const result = yield* (yield* Tracker).createIssue({
			title,
			body: resolveBody(body),
			stage: Option.getOrElse(stage, () => "needs-triage"),
		});
		yield* reportCreated(result);
	}),
).pipe(
	Command.withDescription(
		"File a new issue (title/body/stage) — enters the needs-triage queue by default; body from --body or stdin",
	),
);

const commentTargetArg = Argument.integer("target").pipe(
	Argument.withDescription("the tracker entity (issue) number to comment on"),
);

const reportCommented = (target: number, result: CommentResult): Effect.Effect<void> =>
	Console.log(`tracker: commented on #${target} (ref ${result.ref}).`);

const createComment = Command.make(
	"create-comment",
	{target: commentTargetArg, body: bodyFlag},
	Effect.fn(function* ({target, body}) {
		const result = yield* (yield* Tracker).createComment(target, {body: resolveBody(body)});
		yield* reportCommented(target, result);
	}),
).pipe(
	Command.withDescription("Add a comment (note) to a tracker entity; body from --body or stdin"),
);

// Judgment-as-parameter (#3252): the verdict decision (gate / PASS|FAIL / bound head / prose body)
// is supplied, never decided by the tool — the role vocabulary (which reviewer) lives in the agent
// def, not here. The verb composes the ADR-0058 `review-<gate>:` marker from these parameters so no
// caller hand-composes it.
const verdictGateFlag = Flag.string("gate").pipe(
	Flag.withDescription("the gate namespace: one of code | doc | skill | design (review-<gate>)"),
);

const resultFlag = Flag.string("result").pipe(
	Flag.withDescription("the verdict polarity: PASS or FAIL"),
);

const headRefFlag = Flag.string("head").pipe(
	Flag.withDescription("the full 40-hex head SHA the verdict binds to (ADR 0058)"),
);

const verdictBodyFileFlag = Flag.string("body-file").pipe(
	Flag.optional,
	Flag.withDescription("path to the verdict prose body (default: read the body from stdin)"),
);

const parsePassed = (raw: string): Effect.Effect<boolean, never> => {
	const value = raw.trim().toUpperCase();
	if (value === "PASS") return Effect.succeed(true);
	if (value === "FAIL") return Effect.succeed(false);
	return backOff(`invalid --result '${raw}' — expected PASS or FAIL`);
};

const readBody = (bodyFile: Option.Option<string>): Effect.Effect<string, never> =>
	Effect.sync(() =>
		Option.match(bodyFile, {
			onNone: () => readFileSync(0, "utf8"),
			onSome: (path) => readFileSync(path, "utf8"),
		}),
	);

const reportVerdict = (target: number, result: VerdictResult): Effect.Effect<void> =>
	Console.log(
		`tracker: ${result._tag} ${result.gate} verdict on #${target} (${result.passed ? "PASS" : "FAIL"} @ ${result.headRef}).`,
	);

const postVerdict = Command.make(
	"post-verdict",
	{
		target: targetArg,
		gate: verdictGateFlag,
		result: resultFlag,
		head: headRefFlag,
		bodyFile: verdictBodyFileFlag,
	},
	Effect.fn(function* ({target, gate, result, head, bodyFile}) {
		const passed = yield* parsePassed(result);
		const body = (yield* readBody(bodyFile)).replace(/\s+$/, "");
		if (body.length === 0) {
			return yield* backOff(
				"empty verdict body — nothing to post (pass --body-file or pipe the prose on stdin)",
			);
		}
		const posted = yield* (yield* Tracker)
			.postVerdict(target, {gate, passed, headRef: head, body})
			.pipe(
				// A malformed judgment (unknown gate, unbindable/non-40-hex @ <sha>, a leaked local path)
				// and a failed post-write self-verify both fail loud, never a false success.
				Effect.catchTag("@kampus/tracker/TrackerInputError", (error) => backOff(error.message)),
				Effect.catchTag("@kampus/tracker/TrackerVerifyError", (error) => backOff(error.message)),
			);
		yield* reportVerdict(target, posted);
	}),
).pipe(
	Command.withDescription(
		"Upsert a SHA-bound gate verdict comment for a tracker entity and read it back (PATCH own prior marker, else POST — one per gate, ADR 0058)",
	),
);

// Judgment-as-parameter (#3252): what the source graduated into (`--artifact`) and an optional
// closing note (`--note`) are supplied; the verb composes the `Graduated into <artifact>`
// provenance record and does the two-step close-as-completed — no caller hand-rolls it.
const artifactFlag = Flag.string("artifact").pipe(
	Flag.withDescription(
		"a domain reference to what the source graduated into (epic(s) / ADR / roadmap entry, prose)",
	),
);

const noteFlag = Flag.string("note").pipe(
	Flag.optional,
	Flag.withDescription(
		"optional closing prose appended after the `Graduated into <artifact>` record",
	),
);

const reportGraduated = (target: number, result: GraduateResult): Effect.Effect<void> =>
	Console.log(
		`tracker: graduated #${target} into ${result.artifact} — closed as completed (state ${result.state}).`,
	);

const graduate = Command.make(
	"graduate",
	{target: targetArg, artifact: artifactFlag, note: noteFlag},
	Effect.fn(function* ({target, artifact, note}) {
		// Only carry `note` when present — `exactOptionalPropertyTypes` forbids `note: undefined`.
		const judgment = Option.match(note, {
			onNone: () => ({artifact}),
			onSome: (n) => ({artifact, note: n}),
		});
		const result = yield* (yield* Tracker).graduate(target, judgment).pipe(
			// A close that did not land `state=closed` fails loud, never a false graduation.
			Effect.catchTag("@kampus/tracker/TrackerVerifyError", (error) => backOff(error.message)),
		);
		yield* reportGraduated(target, result);
	}),
).pipe(
	Command.withDescription(
		"Graduate a source (map/investigation): post the source → artifact provenance record and close the source as completed (#3266)",
	),
);

export const trackerCommand = Command.make("tracker").pipe(
	Command.withSubcommands([
		claim,
		readBack,
		applyTriage,
		createIssue,
		createComment,
		postVerdict,
		graduate,
	]),
	Command.withDescription(
		"The crew tracker service (ADR 0190): claim a tracker entity, read back its owner, apply a triage classification, create an issue or a comment, post a gate verdict, graduate a source into its artifact",
	),
	Command.provide(GithubTrackerLive),
);
