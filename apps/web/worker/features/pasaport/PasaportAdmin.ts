/**
 * Pasaport admin service — operations the dev-only `/api/admin/pasaport/*`
 * routes call after `AdminAuth.required` succeeds.
 *
 * Only one operation today: `backfillProfiles` walks the `user` table and
 * upserts a `user_profile` identity row per user. Idempotent — counter
 * columns (`total_karma`, `*_count`) default to 0 on insert and are left
 * untouched on update.
 */
import {Context, Effect, Layer} from "effect";
import * as schema from "../../db/drizzle/schema";
import {CloudflareEnv} from "../../services/CloudflareEnv";
import {Drizzle, DrizzleError} from "../../services/Drizzle";

export interface BackfillProfilesResult {
	emitted: number;
}

export class PasaportAdmin extends Context.Service<
	PasaportAdmin,
	{
		readonly backfillProfiles: Effect.Effect<BackfillProfilesResult, DrizzleError>;
	}
>()("@phoenix/pasaport/PasaportAdmin") {}

export const PasaportAdminLive = Layer.effect(PasaportAdmin)(
	Effect.gen(function* () {
		// Capture deps once at layer build so methods can stay `R = never`.
		const env = yield* CloudflareEnv;
		const db = yield* Drizzle;

		const tryDb = <A>(fn: () => Promise<A>) =>
			Effect.tryPromise({
				try: fn,
				catch: (cause) => new DrizzleError({cause}),
			});

		const upsertProfileIdentity = Effect.fn("PasaportAdmin.upsertProfileIdentity")(
			function* (args: {
				userId: string;
				username: string | null;
				displayName: string | null;
				image: string | null;
				updatedAtSec: number;
			}) {
				yield* tryDb(() =>
					env.PHOENIX_DB.prepare(
						`INSERT INTO user_profile (
						user_id, username, display_name, image,
						total_karma, definition_count, post_count, comment_count,
						updated_at
					) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
					ON CONFLICT(user_id) DO UPDATE SET
						username      = COALESCE(excluded.username, user_profile.username),
						display_name  = excluded.display_name,
						image         = excluded.image,
						updated_at    = excluded.updated_at`,
					)
						.bind(args.userId, args.username, args.displayName, args.image, args.updatedAtSec)
						.run(),
				);
			},
		);

		return {
			backfillProfiles: Effect.gen(function* () {
				const users = yield* tryDb(() =>
					db
						.select({
							id: schema.user.id,
							name: schema.user.name,
							image: schema.user.image,
							username: schema.user.username,
						})
						.from(schema.user),
				);

				const nowSec = Math.floor(Date.now() / 1000);
				let emitted = 0;
				for (const u of users) {
					yield* upsertProfileIdentity({
						userId: u.id,
						username: u.username ?? null,
						displayName: u.name ?? null,
						image: u.image ?? null,
						updatedAtSec: nowSec,
					});
					emitted++;
				}
				return {emitted};
			}),
		};
	}),
);
