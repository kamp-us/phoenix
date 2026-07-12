/**
 * mecmua write-path mutation resolvers (#2497, epic #2467, #2463) — the publish +
 * save-draft acts, gated behind the default-off `mecmua-write` flag (ADR 0083, the
 * pano `post.saveDraft` dark-ship shape): with the flag off both fail
 * {@link MecmuaDisabled}, so the write path is unreachable even if a client bypasses
 * the (not-yet-built) UI. Domain validation + the DB write live in {@link Mecmua}
 * (ADR 0013); this layer resolves the identity, the flag, and the capability.
 *
 * The authority split is the ticket's load-bearing rule:
 *   - `mecmua.publish` is floored at **yazar** via {@link requirePublishMecmua} — a
 *     çaylak is refused with the `FORBIDDEN` `RequiresLevel` (the earned-authorship
 *     gate, ADR 0107 §7). It stamps `publishedAt`; the byline is the LIVE identity
 *     resolved from `authorId` at read (#2463), not a snapshot.
 *   - `mecmua.saveDraft` is NOT yazar-gated — a private draft write is normal-auth
 *     only (`CurrentUser.required`), and multiple drafts per author are allowed.
 *
 * Neither publishes a `/fate/live` invalidation: mecmua Post lives in no subscribed
 * connection yet, so both are `fanned: false` in `fate-live/fanned-mutations.ts`.
 */
import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {MECMUA_FEED, MECMUA_WRITE} from "../../../src/flags/keys.ts";
import {UserId} from "../../lib/ids.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {RequiresLevel} from "../kunye/errors.ts";
import {MecmuaDisabled, MecmuaPostNotFound, MecmuaTitleRequired} from "./errors.ts";
import {MecmuaPostId} from "./ids.ts";
import {Mecmua} from "./Mecmua.ts";
import {PublishMecmua, requirePublishMecmua} from "./PublishMecmua.ts";
import type {MecmuaPostRow} from "./post-fields.ts";
import type {MecmuaPost, MecmuaSubscriptionReceipt} from "./views.ts";
import {MecmuaPostView, MecmuaSubscriptionReceiptView} from "./views.ts";

/** Is the mecmua write path on for this request? Safe-default `false` (ships dark). */
const mecmuaOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_WRITE, false).pipe(provideRequestFlags);
});

/** Is the mecmua feed (subscribe/unsubscribe) on for this request? Safe-default `false`. */
const feedOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_FEED, false).pipe(provideRequestFlags);
});

/** Stamp the wire `__typename` onto a service row — the one mecmua write-path shaper. */
const toMecmuaPost = (r: MecmuaPostRow): MecmuaPost => ({__typename: "MecmuaPost", ...r});

/** The subscribe/unsubscribe receipt shaper — the target author + the post-write edge state. */
const toSubscriptionReceipt = (
	authorId: UserId,
	subscribed: boolean,
): MecmuaSubscriptionReceipt => ({
	__typename: "MecmuaSubscriptionReceipt",
	id: authorId,
	subscribed,
});

// Branded wire inputs (type-only, byte-identical decode): `authorId`/`id` arrive
// tagged UserId / MecmuaPostId, so a transposed service call is a compile error (#2700).
const SubscriptionInput = Schema.Struct({
	authorId: UserId,
});

const SaveDraftInput = Schema.Struct({
	title: Schema.optional(Schema.NullOr(Schema.String)),
	body: Schema.optional(Schema.NullOr(Schema.String)),
	slug: Schema.optional(Schema.NullOr(Schema.String)),
});

const PublishInput = Schema.Struct({
	id: MecmuaPostId,
});

export const mutations = {
	"mecmua.publish": Fate.mutation(
		{
			input: PublishInput,
			type: MecmuaPostView,
			error: Schema.Union([
				Unauthorized,
				MecmuaDisabled,
				RequiresLevel,
				MecmuaPostNotFound,
				MecmuaTitleRequired,
			]),
		},
		Effect.fn("mecmua.publish")(function* ({input}) {
			const user = yield* CurrentUser.required;
			if (!(yield* mecmuaOn)) {
				return yield* new MecmuaDisabled({message: "mecmua şu an kapalı"});
			}
			// The yazar floor: `requirePublishMecmua` discharges `PublishMecmua` and threads
			// the grant into the body, so `yield* PublishMecmua` is the compile-error gate —
			// a çaylak is refused the `FORBIDDEN` `RequiresLevel` before any write (ADR 0107 §3).
			return yield* requirePublishMecmua(
				Effect.gen(function* () {
					yield* PublishMecmua;
					const mecmua = yield* Mecmua;
					const row = yield* mecmua.publish({id: input.id, authorId: UserId.make(user.id)});
					return toMecmuaPost(row);
				}),
			);
		}),
	),
	"mecmua.saveDraft": Fate.mutation(
		{
			input: SaveDraftInput,
			type: MecmuaPostView,
			error: Schema.Union([Unauthorized, MecmuaDisabled]),
		},
		Effect.fn("mecmua.saveDraft")(function* ({input}) {
			const user = yield* CurrentUser.required;
			if (!(yield* mecmuaOn)) {
				return yield* new MecmuaDisabled({message: "mecmua şu an kapalı"});
			}
			const mecmua = yield* Mecmua;
			const row = yield* mecmua.saveDraft({
				authorId: UserId.make(user.id),
				...(input.title != null ? {title: input.title} : {}),
				...(input.body != null ? {body: input.body} : {}),
				...(input.slug != null ? {slug: input.slug} : {}),
			});
			return toMecmuaPost(row);
		}),
	),
	"mecmua.subscribe": Fate.mutation(
		{
			input: SubscriptionInput,
			type: MecmuaSubscriptionReceiptView,
			error: Schema.Union([Unauthorized, MecmuaDisabled]),
		},
		Effect.fn("mecmua.subscribe")(function* ({input}) {
			const user = yield* CurrentUser.required;
			if (!(yield* feedOn)) return yield* new MecmuaDisabled({message: "mecmua şu an kapalı"});
			const mecmua = yield* Mecmua;
			yield* mecmua.subscribe({subscriberId: UserId.make(user.id), authorId: input.authorId});
			return toSubscriptionReceipt(input.authorId, true);
		}),
	),
	"mecmua.unsubscribe": Fate.mutation(
		{
			input: SubscriptionInput,
			type: MecmuaSubscriptionReceiptView,
			error: Schema.Union([Unauthorized, MecmuaDisabled]),
		},
		Effect.fn("mecmua.unsubscribe")(function* ({input}) {
			const user = yield* CurrentUser.required;
			if (!(yield* feedOn)) return yield* new MecmuaDisabled({message: "mecmua şu an kapalı"});
			const mecmua = yield* Mecmua;
			yield* mecmua.unsubscribe({subscriberId: UserId.make(user.id), authorId: input.authorId});
			return toSubscriptionReceipt(input.authorId, false);
		}),
	),
};
