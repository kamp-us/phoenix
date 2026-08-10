/**
 * The `gh api` REST shell behind `cp-bank` — the board write that banks a §CP PR, and the board
 * read that derives the banked set back off it (#4754).
 *
 * The read is the shipped implementation of the watch-set derivation the engine def used to call
 * by name only (`banked_cp_prs_awaiting_approval_json`, no definition anywhere in the tree). The
 * write exists so the two can never disagree: banking goes through one verb that applies the very
 * label the derivation keys on, provisioning it if the adopting repo lacks it.
 *
 * Same `Context.Service`-on-`ChildProcessSpawner` shape as `approval-watcher/github.ts`, over the
 * shared `tracker/gh-io.ts` seam: REST only (GraphQL is broken on the kamp-us org), every infra
 * failure a typed error in the `E` channel, untrusted REST JSON Schema-decoded at the boundary.
 */
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcessSpawner} from "effect/unstable/process";
import {
	type GhCommandError,
	type GhParseError,
	json,
	type RepoResolutionError,
	resolveRepo,
	runGh,
} from "../tracker/gh-io.ts";
import {BANKED_LABEL, type BankedPr} from "./cp-bank.ts";

const createLabelArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/labels`,
	"-f",
	`name=${BANKED_LABEL}`,
	"-f",
	"color=5319e7",
	"-f",
	"description=Control-plane PR banked on the board, awaiting a control-plane approval",
];

// `--slurp` because bare `--paginate` concatenates one JSON array per page, unparseable as a
// whole once the set passes 100 (#3762).
const bankedArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/issues`,
	"-f",
	"state=open",
	"-f",
	`labels=${BANKED_LABEL}`,
	"-f",
	"per_page=100",
	"--paginate",
	"--slurp",
];

const addLabelArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${pr}/labels`,
	"-f",
	`labels[]=${BANKED_LABEL}`,
];

const assignArgs = (repo: string, pr: number, login: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${pr}/assignees`,
	"-f",
	`assignees[]=${login}`,
];

const requestReviewArgs = (repo: string, pr: number, login: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/pulls/${pr}/requested_reviewers`,
	"-f",
	`reviewers[]=${login}`,
];

const readBackArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${pr}`,
];

const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.Struct({name: Schema.String})),
	assignees: Schema.Array(Schema.Struct({login: Schema.String})),
	pull_request: Schema.optionalKey(Schema.Unknown),
});

const decodePages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawIssue)));
const decodeIssue = Schema.decodeUnknownEffect(RawIssue);

/** The label lives on PRs; the issues endpoint returns both, so plain issues are filtered out. */
const listBanked = Effect.fn("BankBoard.listBanked")(function* (repo: string) {
	const pages = yield* decodePages(yield* json(bankedArgs(repo)));
	return pages
		.flat()
		.filter((raw) => raw.pull_request !== undefined)
		.map((raw): BankedPr => ({number: raw.number, title: raw.title}));
});

/** What a bank landed, read back off the board rather than inferred from four 2xx responses. */
export interface BankResult {
	readonly pr: number;
	readonly approver: string;
	readonly labelled: boolean;
	readonly assigned: boolean;
}

/** The bank failed its read-back: the mutations returned 2xx but the board does not carry them. */
export class BankNotLanded extends Schema.TaggedErrorClass<BankNotLanded>()(
	"@kampus/cp-bank/BankNotLanded",
	{pr: Schema.Number, detail: Schema.String},
) {}

const bank = Effect.fn("BankBoard.bank")(function* (repo: string, pr: number, approver: string) {
	// A 422 here is "the label already exists", which is the common case, not a failure.
	yield* runGh(createLabelArgs(repo)).pipe(
		Effect.catchTag("@kampus/gh-io/GhCommandError", () => Effect.void),
	);
	yield* runGh(addLabelArgs(repo, pr));
	yield* runGh(assignArgs(repo, pr, approver));
	// A review request on a PR the approver already reviewed 422s; the assignment + label are what
	// the derivation reads, so this leg is best-effort rather than the whole bank's failure.
	yield* runGh(requestReviewArgs(repo, pr, approver)).pipe(
		Effect.catchTag("@kampus/gh-io/GhCommandError", () => Effect.void),
	);
	const landed = yield* decodeIssue(yield* json(readBackArgs(repo, pr)));
	const result: BankResult = {
		pr,
		approver,
		labelled: landed.labels.some((l) => l.name === BANKED_LABEL),
		assigned: landed.assignees.some((a) => a.login === approver),
	};
	if (!result.labelled || !result.assigned) {
		return yield* new BankNotLanded({
			pr,
			detail:
				`read-back says labelled=${result.labelled} assigned=${result.assigned} — the bank did ` +
				"not land, so the watch set would not carry this PR",
		});
	}
	return result;
});

export type BankBoardError =
	| RepoResolutionError
	| GhCommandError
	| GhParseError
	| Schema.SchemaError;

/**
 * `BankBoard` — the board side of banking. `set` derives the banked §CP watch set; `bank` performs
 * the whole banking act as one call and proves it landed.
 */
export class BankBoard extends Context.Service<
	BankBoard,
	{
		readonly set: () => Effect.Effect<ReadonlyArray<BankedPr>, BankBoardError>;
		readonly bank: (
			pr: number,
			approver: string,
		) => Effect.Effect<BankResult, BankBoardError | BankNotLanded>;
	}
>()("@kampus/cp-bank/BankBoard") {}

export const BankBoardLive: Layer.Layer<BankBoard, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(BankBoard)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				set: () => repo.pipe(Effect.flatMap((r) => withSpawner(listBanked(r)))),
				bank: (pr: number, approver: string) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(bank(r, pr, approver)))),
			};
		}),
	);
