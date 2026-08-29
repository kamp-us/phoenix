/**
 * The `handoff` verb group — `fabrika handoff <capture|take|read|claim>`, the `handoff` skill's half
 * of the ideation layer's continuity story.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * **The answer channel is machine, unconditionally, so there is no `--json` flag**, and there is no
 * `--body` or `--body-file`: `take` reads its asserted half from stdin so a machine-local path has no
 * route into a posted artifact (#3086, #3173).
 */

import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runCapture} from "./capture-verb.ts";
import {runClaim} from "./claim-verb.ts";
import {runRead} from "./read-verb.ts";
import {runTake} from "./take-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const issueFlag = Flag.integer("issue").pipe(
	Flag.withDescription("the issue the work belongs to; every verb addresses one"),
);

const baseFlag = Flag.string("base").pipe(
	Flag.optional,
	Flag.withDescription(
		"the branch the work is measured against (default: the repository's default branch); a compared field, so pass the value the pack was taken with",
	),
);

const nonceFlag = Flag.string("nonce").pipe(
	Flag.withDescription(
		"this run's key, eight lowercase hex characters — authored once per run and passed explicitly, never inferred from the environment",
	),
);

const capture = leafCommand(
	"capture",
	{issue: issueFlag, base: baseFlag, repo: repoFlag},
	Effect.fn(function* ({issue, base, repo}) {
		yield* emit(
			yield* runCapture({
				issue,
				base: Option.getOrNull(base),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Derive the ground state: branch, head, tree, issue and PR."),
	Command.withDescription(
		'Derive the ground state — branch, head, reachability, tree, base, issue and pull-request state — as one JSON object, writing nothing and reading no comments. Prints {"issue":n,"repo":"…","capturedAt":"…","git":{…},"board":{…},"groundDigest":"…"}. Exits 7 (no such issue), 11 (a git or board read failed — the ground is UNKNOWN, never clean). Example: fabrika handoff capture --issue 5021',
	),
);

const take = leafCommand(
	"take",
	{
		issue: issueFlag,
		nonce: nonceFlag,
		base: baseFlag,
		declareUnreachable: Flag.boolean("declare-unreachable").pipe(
			Flag.withDescription(
				"seal the pack even though the work is unreachable, recording the unreachability in the proven half as a stated loss",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({issue, nonce, base, declareUnreachable, repo}) {
		yield* emit(
			yield* runTake({
				issue,
				nonce,
				base: Option.getOrNull(base),
				declareUnreachable,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Compose, post and read back the sealed handoff pack."),
	Command.withDescription(
		'Compose the pack from the four asserted sections on STDIN plus a fresh capture, leak-scan it, post it as one marker-bearing comment, and read it back. Prints {"issue":n,"packComment":c,"packNonce":"…","sealedAt":"…","groundDigest":"…","reachable":"…","supersedes":c|null}. Exits 3 (stdin held nothing), 4 (a section is missing, out of order, empty, or content sits outside the closed set), 5/6 (machine-local path, bare @ reference), 7 (no such issue), 8/9 (the comment write failed, read-back differs), 11 (the capture or a precondition read failed — nothing written), 12 (the work is unreachable by a successor and --declare-unreachable was not given). Example: printf \'## Intent\\nWiden the fanout guard.\\n\\n## Established\\nA failing case is committed.\\n\\n## Next act\\nFollow one level of helper call.\\n\\n## Unsure\\nWhether one level is enough.\\n\' | fabrika handoff take --issue 5021 --nonce 7f3a9c21',
	),
);

const read = leafCommand(
	"read",
	{issue: issueFlag, base: baseFlag, repo: repoFlag},
	Effect.fn(function* ({issue, base, repo}) {
		yield* emit(
			yield* runRead({
				issue,
				base: Option.getOrNull(base),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Resolve the latest sealed pack and report its drift."),
	Command.withDescription(
		'Resolve the latest sealed pack, parse its two halves, re-derive the ground against the PACKED branch, and report the drift field by field. Prints {"issue":n,"pack":"none|sealed|claimed","packComment":…,"packNonce":…,"sealedAt":…,"author":…,"asserted":…,"ground":{"packed":"…"},"drift":{"packedBranch":"resolves|gone|unknown","state":"none|moved|unknown","fields":[…]},"heldBy":…,"disregarded":[…],"scanned":{…}} — all three pack tokens exit 0. Exits 7 (no such issue), 11 (a comment read, a permission read or the live re-derivation failed), 14 (the latest sealed pack does not parse, or its groundDigest disagrees with the fields it labels). Example: fabrika handoff read --issue 5021',
	),
);

const claim = leafCommand(
	"claim",
	{issue: issueFlag, nonce: nonceFlag, repo: repoFlag},
	Effect.fn(function* ({issue, nonce, repo}) {
		yield* emit(
			yield* runClaim({
				issue,
				nonce,
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Claim the latest sealed pack for this run."),
	Command.withDescription(
		'Claim the latest sealed pack, keyed on the run nonce. Prints {"issue":n,"packComment":c,"claimNonce":"…","claim":"held|resumed","claimedAt":"…","claimComment":c}. Exits 7 (no such issue), 8/9 (the claim write failed, read-back differs), 11 (a comment or permission read failed — nothing written), 13 (no sealed pack to claim), 14 (the latest pack does not parse), 15 (another nonce holds it). Example: fabrika handoff claim --issue 5021 --nonce 4b8e2f01',
	),
);

export const handoffCommand = Command.make("handoff").pipe(
	Command.withSubcommands([capture, take, read, claim]),
	Command.withShortDescription("Hand one session's work to the next."),
	Command.withDescription(
		"Hand one session's work to the next: derive the ground state, seal a pack of what is asserted plus what is proven, read the latest pack back with its drift, and claim it under a run nonce",
	),
);
