/**
 * `Mecmua` — the mecmua long-form write service (#2497, epic #2467, #2463). The
 * domain-object home for the two write acts, reached only through the `Drizzle` seam
 * and dying on infra errors via `orDieAccess` (the `Report`/`Pano` service idiom):
 * validation + the DB write live here, never in the fate resolver (ADR 0013).
 *
 * Two acts:
 *   - {@link MecmuaService.saveDraft} — insert a NEW draft row (`publishedAt = null`).
 *     Multiple drafts per author are allowed (the deliberate divergence from pano's
 *     one-draft-per-author partial-unique index, #2463), so this always inserts a
 *     fresh id — never a probe-then-upsert.
 *   - {@link MecmuaService.publish} — stamp `publishedAt` on the caller's own draft
 *     (the yazar-floored act, gated at the mutation by `PublishMecmua`). The write is
 *     scoped `where id = ? AND author_id = ?`, so a yazar can only publish their OWN
 *     draft; a miss is {@link MecmuaPostNotFound}.
 *
 * There is no `authorName` column — the byline is the LIVE identity resolved from
 * `authorId` at read time (#2463), so a publish stamps only `publishedAt`; the byline
 * follows the author's current identity, never a snapshot.
 */

import {id} from "@usirin/forge";
import {and, eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {MecmuaPostNotFound, MecmuaTitleRequired} from "./errors.ts";
import {type MecmuaPostRow, toMecmuaPostRow} from "./post-fields.ts";

export interface SaveMecmuaDraftInput {
	authorId: string;
	/** Optional on a draft — a half-filled form persists (empty ⇒ stored as ""). */
	title?: string | null;
	body?: string | null;
	slug?: string | null;
}

export interface PublishMecmuaInput {
	/** The draft to publish. */
	id: string;
	/** The caller — the write is scoped to their OWN draft. */
	authorId: string;
}

export class Mecmua extends Context.Service<
	Mecmua,
	{
		readonly saveDraft: (input: SaveMecmuaDraftInput) => Effect.Effect<MecmuaPostRow>;
		readonly publish: (
			input: PublishMecmuaInput,
		) => Effect.Effect<MecmuaPostRow, MecmuaPostNotFound | MecmuaTitleRequired>;
	}
>()("mecmua/Mecmua") {}

export const MecmuaLive = Layer.effect(Mecmua)(
	Effect.gen(function* () {
		// `orDieAccess`: every internal DB call dies on `DrizzleError` (infra failures are
		// defects, `.patterns/effect-errors.md`), so method signatures carry domain errors only.
		const {run} = orDieAccess(yield* Drizzle);

		const saveDraft = Effect.fn("Mecmua.saveDraft")(function* (input: SaveMecmuaDraftInput) {
			const now = new Date();
			const postId = id("mecmua");
			const row = {
				id: postId,
				slug: input.slug ?? null,
				title: (input.title ?? "").trim(),
				body: input.body ?? "",
				authorId: input.authorId,
				publishedAt: null,
				createdAt: now,
				updatedAt: now,
			} satisfies typeof schema.mecmuaPost.$inferSelect;
			yield* run((db) => db.insert(schema.mecmuaPost).values(row));
			return toMecmuaPostRow(row);
		});

		const publish = Effect.fn("Mecmua.publish")(function* (input: PublishMecmuaInput) {
			// Ownership-scoped read: only the caller's OWN row resolves, so a yazar can't
			// publish another author's draft (a foreign/absent id is MECMUA_POST_NOT_FOUND).
			const existing = yield* run((db) =>
				db.query.mecmuaPost.findFirst({
					where: {id: input.id, authorId: input.authorId},
				}),
			);
			if (!existing) {
				return yield* new MecmuaPostNotFound({message: "Yayımlanacak yazı bulunamadı."});
			}
			if (existing.title.trim().length === 0) {
				return yield* new MecmuaTitleRequired({message: "Yayımlamak için bir başlık gerekli."});
			}
			const now = new Date();
			// Idempotent re-publish: keep the original instant if already published, else stamp now.
			const publishedAt = existing.publishedAt ?? now;
			yield* run((db) =>
				db
					.update(schema.mecmuaPost)
					.set({publishedAt, updatedAt: now})
					.where(
						and(eq(schema.mecmuaPost.id, input.id), eq(schema.mecmuaPost.authorId, input.authorId)),
					),
			);
			return toMecmuaPostRow({...existing, publishedAt, updatedAt: now});
		});

		return {saveDraft, publish};
	}),
);
