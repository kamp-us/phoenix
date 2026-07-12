/**
 * The `cf-utils scrub-author-email` IO shell — the thin Effect bin around the pure core
 * (`scrub-author-email.ts`). It resolves the target D1 (an explicit `--database-id`, never a
 * prod-hardcoded default, mirroring `@kampus/moderator-grant`; the account id from the
 * keychain-first `CLOUDFLARE_ACCOUNT_ID` Config), builds the scrub db over the D1 REST
 * transport (`@kampus/d1-rest`) credentialed by cf-utils' keychain seam, runs the dry-run scan,
 * and — ONLY under the confirm-and-name gate (`--execute` AND `--confirm scrub-author-email`) —
 * applies the rewrite. See `scrub-author-email.ts` for the destructive-ceremony + SQL-grounding
 * invariants; this file only wires them to the CLI.
 */

import type {Credentials} from "@distilled.cloud/cloudflare/Credentials";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, type Layer, Option} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import type {HttpClient} from "effect/unstable/http/HttpClient";
import {
	CONFIRM_OP_NAME,
	decideWrite,
	makeScrubDb,
	renderDryRun,
	renderScrubbed,
	scanAffected,
	scrubEmails,
} from "./scrub-author-email.ts";

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID (never prod-hardcoded)"),
);
const accountIdFlag = Flag.string("account-id").pipe(
	Flag.optional,
	Flag.withDescription("Cloudflare account id (default: keychain / $CLOUDFLARE_ACCOUNT_ID)"),
);
const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription("actually rewrite (default: dry-run — scan + print counts, write nothing)"),
);
const confirmFlag = Flag.string("confirm").pipe(
	Flag.optional,
	Flag.withDescription(`name the op to authorize the write — must be "${CONFIRM_OP_NAME}"`),
);

const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");

/** A D1 REST scan/scrub query rejected — keeps the failure in `E`, never a swallowed defect. */
export class ScrubDbError extends Schema.TaggedErrorClass<ScrubDbError>()(
	"@kampus/cf-utils/ScrubDbError",
	{
		op: Schema.Literals(["scan", "scrub"]),
		cause: Schema.Unknown,
	},
) {}

/**
 * `scrub-author-email` — the one destructive verb. It runs the dry-run scan first ALWAYS (so a
 * founder sees the per-table counts before any write), then consults the pure confirm-gate: a
 * refused gate prints the dry-run report and stops; an authorized gate (`--execute` +
 * `--confirm scrub-author-email`) applies the rewrite and prints the post-write summary. The
 * scan/report never emits an email value — leak-clean output is the count, not the PII.
 */
export const makeScrubCommand = (restLayer: Layer.Layer<Credentials | HttpClient>) =>
	Command.make(
		"scrub-author-email",
		{
			databaseId: databaseIdFlag,
			accountId: accountIdFlag,
			execute: executeFlag,
			confirm: confirmFlag,
		},
		Effect.fn(function* ({databaseId, accountId: accountIdOpt, execute, confirm}) {
			const account = Option.isSome(accountIdOpt) ? accountIdOpt.value : yield* accountId;
			const db = makeScrubDb(makeD1Rest({accountId: account, databaseId, layer: restLayer}));

			// The dry-run scan runs ALWAYS — the count-only report a founder reads before any write.
			const affected = yield* Effect.tryPromise({
				try: () => scanAffected(db),
				catch: (cause) => new ScrubDbError({op: "scan", cause}),
			});
			yield* Console.log(renderDryRun(affected));

			const decision = decideWrite({
				execute,
				confirm: Option.isSome(confirm) ? confirm.value : undefined,
			});
			if (decision._tag === "DryRun") {
				yield* Console.log(`  (write refused: ${decision.reason})`);
				return;
			}

			const total = affected.reduce((sum, a) => sum + a.count, 0);
			if (total === 0) {
				yield* Console.log("  (nothing to rewrite — the scan found no email-shaped rows)");
				return;
			}

			// Gate authorized (--execute + --confirm scrub-author-email) and there ARE rows: rewrite.
			const scrubbed = yield* Effect.tryPromise({
				try: () => scrubEmails(db),
				catch: (cause) => new ScrubDbError({op: "scrub", cause}),
			});
			yield* Console.log(renderScrubbed(scrubbed));
		}),
	).pipe(
		Command.withDescription(
			"Scrub email-at-rest from author_name (dry-run default; --execute --confirm scrub-author-email to apply) — #2137",
		),
	);
