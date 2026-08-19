/**
 * The `ledger` verb group — `fabrika ledger <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag carries
 * a one-line description), runs the pure verb, and emits its outcome. Every decision lives in the
 * `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * **`--ready-for` is optional at the parser and refused in the verb body.** A parser-required flag's
 * absence is exit `1`, indistinguishable from a typo; an absent audience is a decision nobody made
 * (#4780), which must be provable as `10`. `--body-digest`, `--child` and `--title` stay
 * parser-required, because their absence is an ordinary usage error with no semantic content and their
 * fail-open risk is a *wrong* value — which is `21` and `10` respectively, not a missing one.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runChild} from "./child-verb.ts";
import {runDraft} from "./draft-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runSupersede} from "./supersede-verb.ts";
import {runTopology} from "./topology-verb.ts";
import {runWrite} from "./write-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const epicArg = Argument.integer("number").pipe(
	Argument.withDescription("the epic this verb plans"),
);

const tokenFlag = Flag.string("token").pipe(
	Flag.withDescription(
		"the claim token `build claim <epic> --purpose plan` handed this lane — its identity, and what the run directory is keyed on",
	),
);

const bodyDigestFlag = Flag.string("body-digest").pipe(
	Flag.withDescription(
		"the 12-lowercase-hex body digest `ledger open` printed; the verb recomputes it from the live body and refuses on 21 if the epic moved",
	),
);

const stdin = Effect.sync(readStdin);

const open = leafCommand(
	"open",
	{number: epicArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(
			yield* runOpen({
				number,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Prove the ground and open the plan run for an epic."),
	Command.withDescription(
		'Prove the ground fresh, allocate the run directory (keyed on the claim nonce --token names, never the session), read the epic\'s existing children, probe the cycle doc, and rank duplicate candidates. Prints {"answer":"opened","epic":n,"run":"…","mode":"fresh|re-plan","bodyDigest":"…","dir":"…","children":[…],"cycleDoc":"present|absent|unknown","candidates":{"outcome":"candidates|none|indeterminate","items":[…]}}. Carry bodyDigest to `ledger draft` and `ledger write`. Exits 7 (the epic is proven absent or closed), 10 (not a type:epic), 11 (the epic, its sub-issue list, the backlog, the cycle-doc probe or the freshness probe could not be read), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, since ownership turns on the whole token and never the session id, #6060), 20 (the base is proven behind origin/main), 22 (two or more "## Plan (plan-epic)" headings — the mode has no single meaning). Example: fabrika ledger open 4300 --token build:s-9f2e:c1a4d6f8-…',
	),
);

const draft = leafCommand(
	"draft",
	{number: epicArg, bodyDigest: bodyDigestFlag, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, bodyDigest, token, repo}) {
		yield* emit(
			yield* runDraft({
				number,
				bodyDigest,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				stdin,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Validate the plan block on stdin and stage it."),
	Command.withDescription(
		'Validate the plan block on STDIN against the closed section set and the story grammar, then stage it in the run directory. Prints {"answer":"staged","epic":n,"document":"plan","sections":10,"stories":[…],"bytes":n}. It does not judge content — a "### Approach" reading TBD stages cleanly. Exits 3 (stdin held nothing), 4 (a required ### section is missing, duplicated or out of order; the block does not open with "## Plan (plan-epic)"; zero user stories; or story ids that are not contiguous from 1), 5 (machine-local path), 6 (bare @ reference), 7 (the epic is proven absent or closed), 10 (not a type:epic, or --body-digest is not 12 lowercase hex), 11 (a read failed — nothing was staged), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, #6060), 21 (the epic body moved since open). Example: fabrika ledger draft 4300 --body-digest 8f2c1a90b4d7 --token build:s-9f2e:c1a4d6f8-… < plan.md',
	),
);

const child = leafCommand(
	"child",
	{
		number: epicArg,
		title: Flag.string("title").pipe(
			Flag.withDescription("the child's title; it carries no type or priority prefix"),
		),
		type: Flag.string("type").pipe(
			Flag.withDescription(
				"the child's type label: type:bug | type:feature | type:chore | type:decision | type:investigation",
			),
		),
		priority: Flag.string("priority").pipe(
			Flag.withDescription(
				"the child's priority label: p0 | p1 | p2 (p3 is retired, not admitted)",
			),
		),
		readyFor: Flag.string("ready-for").pipe(
			Flag.optional,
			Flag.withDescription(
				"the child's audience: human | agent. Optional at the parser and REFUSED on 10 when absent — a child never inherits its audience by omission (#4780)",
			),
		),
		assignee: Flag.string("assignee").pipe(
			Flag.optional,
			Flag.withDescription(
				"the login a held child is born assigned to; required with --ready-for human (#4693)",
			),
		),
		milestone: Flag.string("milestone").pipe(
			Flag.optional,
			Flag.withDescription(
				"the title of an open milestone; required unless --label carries a standing lane (#5969)",
			),
		),
		token: tokenFlag,
		label: Flag.string("label").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a further label applied in the same create call; repeatable, and every value must already exist in the repo taxonomy (#4285)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({
		number,
		title,
		type,
		priority,
		readyFor,
		assignee,
		milestone,
		token,
		label,
		repo,
	}) {
		yield* emit(
			yield* runChild({
				number,
				title,
				type,
				priority,
				readyFor: Option.getOrNull(readyFor),
				assignee: Option.getOrNull(assignee),
				milestone: Option.getOrNull(milestone),
				labels: label,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				stdin,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Mint one child issue with every birth attribute at once."),
	Command.withDescription(
		'Mint one child with EVERY birth attribute in the one POST — title, body, every label, milestone and assignee — record it in the run manifest, link it as a native sub-issue, then re-read and report the OBSERVED result. Prints {"answer":"minted","epic":n,"child":n,"linked":true,"observed":{…},"stories":[…],"containment":"…"}. Exits 3 (stdin held nothing), 4 (the composed body\'s fields or sections do not parse: a malformed **Stories:** value, absent or malformed acceptance criteria, or a child of an asked type whose **Containment:** is off the vocabulary `.fabrika.jsonc`\'s containmentVocabulary resolves to, while the cycle doc is present), 5 (machine-local path), 6 (bare @ reference), 7 (the epic is proven absent or closed), 8 (the create was attempted and no re-read could prove it — UNKNOWN), 9 (created and it does not read back as sent), 10 (a label, --type, --priority, --milestone or --ready-for off its closed vocabulary; --ready-for absent; --ready-for human without --assignee; neither --milestone nor a standing-lane --label, so the child would be born homeless; or not a type:epic), 11 (a precondition read failed, or the config exists and its containmentVocabulary does not decode — NOTHING was created), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, #6060), 23 (created and the sub-issue link could not be proven), 26 (created and the run manifest could not be written). Example: fabrika ledger child 4300 --title "queue view: fate loader" --type type:feature --priority p1 --ready-for agent --token build:s-9f2e:c1a4d6f8-… < child.md',
	),
);

const topology = leafCommand(
	"topology",
	{number: epicArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(
			yield* runTopology({
				number,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				stdin,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Validate the declared topology and render its Dependencies block."),
	Command.withDescription(
		'Validate the topology declared on STDIN — one "#<ref> phase <n> [requires #<a>, #<b>]" line per child, order-indifferent — against the run manifest, render the "## Dependencies" block, and parse it back through the shipped reader before staging it. Prints {"answer":"staged","epic":n,"document":"topology","phases":n,"children":n,"edges":[["#4303","#4301"]],"bytes":n}. It cannot see a shared-file conflict — whether two children in one phase write the same module is the skill\'s judgment (#3709). Exits 3 (stdin held nothing), 4 (a line does not parse), 7 (the epic is proven absent or closed, or the run manifest holds zero children), 10 (not a type:epic, or a phase is not a positive integer), 11 (a read failed — nothing was staged), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, #6060), 24 (a cycle, a reference to a non-child, a manifest child placed nowhere, or a rendered block that does not parse back to the declared edges). Example: fabrika ledger topology 4300 --token build:s-9f2e:c1a4d6f8-… < topo.txt',
	),
);

const write = leafCommand(
	"write",
	{number: epicArg, bodyDigest: bodyDigestFlag, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, bodyDigest, token, repo}) {
		yield* emit(
			yield* runWrite({
				number,
				bodyDigest,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Splice the staged plan and topology into the epic body."),
	Command.withDescription(
		'Splice the staged plan and topology into the epic body in one PATCH, then re-read and compare the WHOLE normalized body. The plan region is resolved through the verb-written enrichment marker, never by position, and is never cut to end-of-file (#4879). mode is carried from `ledger open`, never re-derived. Prints {"answer":"written","epic":n,"mode":"…","bodyDigest":"…","newDigest":"…","planBytes":n,"topologyBytes":n,"verified":true}. Exits 7 (the epic is proven absent or closed), 8 (the PATCH was issued and could not be confirmed — UNKNOWN), 9 (written and it does not read back as composed), 10 (not a type:epic, or --body-digest is not 12 lowercase hex), 11 (a read failed — NOTHING was written), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, #6060), 21 (the epic body moved since open), 22 (the plan region is unresolvable), 25 (plan.md or topology.md was never staged in this run). Example: fabrika ledger write 4300 --body-digest 8f2c1a90b4d7 --token build:s-9f2e:c1a4d6f8-…',
	),
);

const supersede = leafCommand(
	"supersede",
	{
		number: epicArg,
		child: Flag.integer("child").pipe(Flag.withDescription("the child being retired")),
		reason: Flag.string("reason").pipe(
			Flag.withDescription("why it is retired; posted verbatim as the journal comment"),
		),
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, child: childNumber, reason, token, repo}) {
		yield* emit(
			yield* runSupersede({
				number,
				child: childNumber,
				reason,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Retire a child the re-plan no longer contains."),
	Command.withDescription(
		'Retire a child the re-plan no longer contains: comment, unlink, close as not_planned — in that order, so a child is never closed while still linked — then re-read and prove it. Prints {"answer":"superseded","epic":n,"child":n,"comment":id,"unlinked":true,"state":"closed"}. Refuses a child that is not this epic\'s sub-issue, and one this run minted. Exits 5 (the reason carries a machine-local path), 6 (bare @ reference), 7 (the epic or the child is proven absent or closed), 8 (a leg was attempted and its outcome could not be proven), 9 (the legs landed and the child does not read back closed and unlinked), 10 (not a type:epic; --child is not a sub-issue of it; or --child was minted by this run), 11 (a precondition read failed — nothing was written), 15 (this LANE does not hold the epic\'s claim — --token says which lane is asking, #6060). Example: fabrika ledger supersede 4300 --child 4288 --reason "folded into the loader slice" --token build:s-9f2e:c1a4d6f8-…',
	),
);

export const ledgerCommand = Command.make("ledger").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		open,
		draft,
		child,
		topology,
		write,
		supersede,
	]),
	Command.withShortDescription("Author an epic's plan and its children."),
	Command.withDescription(
		"Author an epic's plan: open the run on proven-fresh ground, stage the plan block, mint each child born complete and linked, declare the dependency topology, and splice both into the epic body",
	),
);
