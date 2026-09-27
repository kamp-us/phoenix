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
 * Eight leaves author a plan run. `retopology`, `digest` and `defer` are the three that read no run
 * directory at all — each belongs to the descope route, which is found on epics whose run was long
 * since cleared: `retopology` repairs the block, `digest` prints the input that repair takes, and
 * `defer` unlinks the child. Sourcing any of them from `ledger open` would put the staged run back
 * in a route built not to need one.
 *
 * **`--ready-for` is optional at the parser and refused in the verb body.** A parser-required flag's
 * absence is exit `1`, indistinguishable from a typo; an absent audience is a decision nobody made,
 * which must be provable as `10`. `--body-digest`, `--child` and `--title` stay
 * parser-required, because their absence is an ordinary usage error with no semantic content and their
 * fail-open risk is a *wrong* value — which is `21` and `10` respectively, not a missing one.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runAdopt} from "./adopt-verb.ts";
import {runChild} from "./child-verb.ts";
import {runDefer} from "./defer-verb.ts";
import {runDigest} from "./digest-verb.ts";
import {runDraft} from "./draft-verb.ts";
import {runEdges} from "./edges-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runRetopology} from "./retopology-verb.ts";
import {runSupersede} from "./supersede-verb.ts";
import {runTopology} from "./topology-verb.ts";
import {runWrite} from "./write-verb.ts";

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
		"the 12-lowercase-hex body digest `ledger open` printed, or `ledger digest` for a route that stages no run; the verb recomputes it from the live body and refuses on 21 if the epic moved",
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
		[
			'Opens an epic\'s plan run and prints {"answer":"opened","mode":…,"bodyDigest":…,…} as JSON.',
			"  7: the epic is absent or closed",
			"  10: not a type:epic",
			"  11: a read failed (UNKNOWN)",
			"  15: this lane does not hold the epic's claim",
			"  20: the base is behind origin/main",
			'  22: more than one "## Plan (plan-epic)" heading',
			'  Derivation: the plan-epic skill\'s contract.md, "ledger open"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ledger open 9420 --token build:s-9f2e:c1a4d6f8-…"}]),
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
		[
			'Validates the plan block on stdin, stages it, and prints {"answer":"staged",…} as JSON.',
			"  3: stdin held nothing",
			"  4: the block breaks the section set or the story grammar",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the epic is absent or closed",
			"  10: not a type:epic, or --body-digest is malformed",
			"  11: a read failed; nothing was staged",
			"  15: this lane does not hold the epic's claim",
			"  21: the epic body moved since open",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger draft"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika ledger draft 9420 --body-digest 8f2c1a90b4d7 --token build:s-9f2e:c1a4d6f8-… < plan.md",
		},
	]),
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
				"the child's type label: type:bug | type:feature | type:chore | type:decision | type:investigation. type:decision is REFUSED on 10 with --ready-for agent — a fresh decision carries no ruling comment of its own to cite",
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
				"the child's audience: human | agent. Optional at the parser and REFUSED on 10 when absent — a child never inherits its audience by omission",
			),
		),
		assignee: Flag.string("assignee").pipe(
			Flag.optional,
			Flag.withDescription(
				"the login a held child is born assigned to; required with --ready-for human",
			),
		),
		milestone: Flag.string("milestone").pipe(
			Flag.optional,
			Flag.withDescription(
				"the title of an open milestone; required unless --label carries a standing lane",
			),
		),
		token: tokenFlag,
		label: Flag.string("label").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a further label applied in the same create call; repeatable, and every value must already exist in the repo taxonomy",
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
		[
			'Mints one child from the body on stdin, links it, and prints {"answer":"minted",…}.',
			"  3: stdin held nothing",
			"  4: the body does not parse",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the epic is absent or closed",
			"  8: the create is unproven (UNKNOWN)",
			"  9: created; it does not read back as sent",
			"  10: a flag is off its vocabulary or missing",
			"  11: a read failed; nothing was created",
			"  15: this lane does not hold the epic's claim",
			"  23: created; the sub-issue link is unproven",
			"  26: created; the run manifest was not written",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger child"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika ledger child 9420 --title "queue view: fate loader" --type type:feature --priority p1 --ready-for agent --milestone "fabrika campaign" --token build:s-9f2e:c1a4d6f8-… < child.md',
		},
	]),
);

const adopt = leafCommand(
	"adopt",
	{
		number: epicArg,
		child: Flag.integer("child").pipe(
			Flag.withDescription("the already-filed issue joining this epic's plan as a child"),
		),
		stories: Flag.string("stories").pipe(
			Flag.optional,
			Flag.withDescription(
				'the plan\'s story ids for the child — bare integers or "none"; required when the issue declares no **Stories:** line, and REFUSED on 4 when it declares a different one',
			),
		),
		containment: Flag.string("containment").pipe(
			Flag.optional,
			Flag.withDescription(
				"the child's containment keyword off containmentVocabulary; required for an asked type with no **Containment:** line while the cycle doc is present, and REFUSED on 4 when the issue declares a different one",
			),
		),
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, child: childNumber, stories, containment, token, repo}) {
		yield* emit(
			yield* runAdopt({
				number,
				child: childNumber,
				stories: Option.getOrNull(stories),
				containment: Option.getOrNull(containment),
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Adopt an already-filed issue as a child, without minting a duplicate.",
	),
	Command.withDescription(
		[
			'Adopts a filed issue as the epic\'s child and prints {"answer":"adopted",…}.',
			"  4: a field or the criteria conflict or do not parse",
			"  5: the amendment carries a machine-local path",
			"  7: the epic or the issue is absent or closed",
			"  8: a write is unproven (UNKNOWN); re-run",
			"  9: amended; the body does not read back",
			"  10: the issue or a flag is not adoptable",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			"  23: the sub-issue link is unproven; re-run",
			"  26: the run manifest was not written; re-run",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger adopt"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika ledger adopt 9420 --child 8195 --stories 2 --token build:s-9f2e:c1a4d6f8-…"},
	]),
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
		[
			'Stages the Dependencies block from the topology on stdin and prints {"answer":"staged",…}.',
			'  Stdin: one "#<ref> phase <n> [requires #<a>, #<b>]" line per child.',
			"  3: stdin held nothing",
			"  4: a line does not parse",
			"  7: the epic is absent or closed, or the manifest has no child",
			"  10: not a type:epic, or a phase is not a positive integer",
			"  11: a read failed; nothing was staged",
			"  15: this lane does not hold the epic's claim",
			"  24: the topology is invalid",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger topology"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika ledger topology 9420 --token build:s-9f2e:c1a4d6f8-… < topo.txt"},
	]),
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
		[
			'Splices the staged plan and topology into the epic body and prints {"answer":"written",…}.',
			"  7: the epic is absent or closed",
			"  8: the PATCH is unconfirmed (UNKNOWN)",
			"  9: written; it does not read back as composed",
			"  10: not a type:epic, or --body-digest is malformed",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			"  21: the epic body moved since open",
			"  22: the plan region is unresolvable",
			"  25: plan.md or topology.md was never staged",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger write"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika ledger write 9420 --body-digest 8f2c1a90b4d7 --token build:s-9f2e:c1a4d6f8-…",
		},
	]),
);

const digest = leafCommand(
	"digest",
	{number: epicArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(
			yield* runDigest({
				number,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Print an epic's body digest, staging nothing."),
	Command.withDescription(
		[
			'Prints {"answer":"digest","epic":n,"bodyDigest":"…"} for an epic\'s live body, writing nothing.',
			"  7: the epic is absent or closed",
			"  10: not a type:epic",
			"  11: a read failed; the digest is UNKNOWN",
			"  15: this lane does not hold the epic's claim",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger digest"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ledger digest 5817 --token build:s-9f2e:c1a4d6f8-…"}]),
);

const retopology = leafCommand(
	"retopology",
	{number: epicArg, bodyDigest: bodyDigestFlag, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, bodyDigest, token, repo}) {
		yield* emit(
			yield* runRetopology({
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
	Command.withShortDescription("Rewrite an epic's Dependencies block from its live child links."),
	Command.withDescription(
		[
			'Rewrites Dependencies to the live children and prints {"answer":"rewritten|unchanged",…}.',
			"  4: a topology line does not parse",
			"  7: the epic is absent or closed, blockless or childless",
			"  8: the PATCH is unconfirmed (UNKNOWN)",
			"  9: written; it does not read back as composed",
			"  10: not a type:epic, or --body-digest is malformed",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			"  21: the body moved since the digest",
			"  22: the region has no single meaning",
			"  24: the rewritten topology is invalid",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger retopology"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika ledger retopology 5817 --body-digest 8f2c1a90b4d7 --token build:s-9f2e:c1a4d6f8-…",
		},
	]),
);

const defer = leafCommand(
	"defer",
	{
		number: epicArg,
		child: Flag.integer("child").pipe(
			Flag.withDescription("the child leaving this epic's plan, and staying open"),
		),
		reason: Flag.string("reason").pipe(
			Flag.withDescription("why the plan changed; posted verbatim as the journal comment"),
		),
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, child: childNumber, reason, token, repo}) {
		yield* emit(
			yield* runDefer({
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
	Command.withShortDescription("Take a child out of an epic's plan and leave its issue open."),
	Command.withDescription(
		[
			'Unlinks a child from the epic\'s plan, leaves it open, and prints {"answer":"deferred",…}.',
			"  5: the reason carries a machine-local path",
			"  6: a bare @ reference",
			"  7: the epic or the child is absent or closed",
			"  8: a leg is unproven (UNKNOWN)",
			"  9: the child does not read back open and unlinked",
			"  10: not a type:epic, not its sub-issue, or an empty reason",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger defer"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika ledger defer 8892 --child 8951 --reason "deferred to a follow-up cycle by founder ruling" --token build:s-9f2e:c1a4d6f8-…',
		},
	]),
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
		[
			'Retires a child the re-plan dropped, closing it, and prints {"answer":"superseded",…} as JSON.',
			"  5: the reason carries a machine-local path",
			"  6: a bare @ reference",
			"  7: the epic or the child is absent or closed",
			"  8: a leg is unproven (UNKNOWN)",
			"  9: the child does not read back closed and unlinked",
			"  10: not a type:epic, not its sub-issue, or minted by this run",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger supersede"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika ledger supersede 9420 --child 9421 --reason "folded into the loader slice" --token build:s-9f2e:c1a4d6f8-…',
		},
	]),
);

const edges = leafCommand(
	"edges",
	{number: epicArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(
			yield* runEdges({
				number,
				token,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Write the epic's declared dependencies into the blocked_by graph."),
	Command.withDescription(
		[
			'Writes the Dependencies block into the blocked_by graph and prints {"answer":"reconciled",…}.',
			"  4: the Dependencies block is unparseable",
			"  7: the epic is absent or closed, or declares no topology",
			"  8: edges were written; the graph is unreadable (UNKNOWN)",
			"  9: the graph does not read back with every required edge",
			"  10: not a type:epic",
			"  11: a read failed; nothing was written",
			"  15: this lane does not hold the epic's claim",
			"  24: a named prerequisite is absent",
			'  Derivation: the plan-epic skill\'s contract.md, "ledger edges"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ledger edges 9420 --token build:s-9f2e:c1a4d6f8-…"}]),
);

export const ledgerCommand = Command.make("ledger").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		open,
		draft,
		child,
		adopt,
		topology,
		write,
		edges,
		defer,
		supersede,
		retopology,
		digest,
	]),
	Command.withShortDescription("Author an epic's plan and its children."),
	Command.withDescription(
		"Author an epic's plan: open the run on proven-fresh ground, stage the plan block, mint each child born complete and linked or adopt an already-filed one, declare the dependency topology, and splice both into the epic body — plus the two verbs that need no run: `retopology`, which rewrites a descoped epic's Dependencies block from its live child links, and `digest`, which prints the body digest that repair requires",
	),
);
