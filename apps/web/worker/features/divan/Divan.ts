/**
 * `Divan` — the gated read model behind the çaylak proving ground (#1287, epic
 * #1202). A DESTINATION over the shipped `sandboxBacklogWhere` read model (#1205):
 * it composes the existing `listSandboxed*` reads (Sözlük definitions, pano posts +
 * comments — each already filtered to still-sandboxed, not-removed via
 * `sandboxBacklogWhere`) and groups them by author so the divan's unit is the
 * **person**, not loose items.
 *
 * It does NOT re-derive the predicate and does NOT touch `sandboxVisibleWhere` —
 * inline sözlük/pano reads stay `{mod, author}`. A yazar gains visibility into çaylak
 * work ONLY through this service, reached only past the {@link requireDivanAccess}
 * gate and only when the `PHOENIX_AUTHORSHIP_LOOP` flag is on (both enforced at the
 * fate resolver). The service read itself is unconditional, exactly like the
 * `listSandboxed*` reads it builds on.
 *
 * Two reads:
 *   - {@link Divan.roster} — the pending-çaylak roster (grouped by author, per-kind
 *     counts) across ALL authors.
 *   - {@link Divan.backlogOf} — one çaylak's sandboxed backlog (the items, for the
 *     #1290 detail view), newest first.
 */
import {Context, Effect, Layer} from "effect";
import {Pano} from "../pano/Pano.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {excerpt} from "../text/index.ts";
import {buildRoster, type DivanItem, type DivanRosterRow} from "./roster.ts";

const preview = (text: string | null | undefined): string => excerpt(text ?? "");

export class Divan extends Context.Service<
	Divan,
	{
		/** The pending-çaylak roster: every çaylak with ≥1 sandboxed, not-removed item. */
		readonly roster: () => Effect.Effect<ReadonlyArray<DivanRosterRow>>;
		/** One çaylak's sandboxed backlog (newest first) — the detail-view items. */
		readonly backlogOf: (authorId: string) => Effect.Effect<ReadonlyArray<DivanItem>>;
	}
>()("divan/Divan") {}

export const DivanLive = Layer.effect(Divan)(
	Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		const pano = yield* Pano;
		const pasaport = yield* Pasaport;

		// Fetch the three sandboxed backlogs (optionally one author's) and collapse the
		// per-domain rows onto the normalized `DivanItem` shape. The `sandboxBacklogWhere`
		// filter (sandboxed + not-removed) lives in the `listSandboxed*` reads, not here.
		const collect = Effect.fn("Divan.collect")(function* (opts: {authorId?: string} = {}) {
			const [definitions, posts, comments] = yield* Effect.all(
				[
					sozluk.listSandboxedDefinitions(opts),
					pano.listSandboxedPosts(opts),
					pano.listSandboxedComments(opts),
				],
				{concurrency: "unbounded"},
			);
			const items: DivanItem[] = [
				...definitions.map(
					(d): DivanItem => ({
						kind: "definition",
						id: d.id,
						authorId: d.authorId,
						createdAt: d.createdAt,
						preview: preview(d.body),
					}),
				),
				...posts.map(
					(p): DivanItem => ({
						kind: "post",
						id: p.id,
						authorId: p.authorId,
						createdAt: p.createdAt,
						preview: preview(p.title),
					}),
				),
				...comments.map(
					(c): DivanItem => ({
						kind: "comment",
						id: c.id,
						authorId: c.authorId,
						createdAt: c.createdAt,
						preview: preview(c.body),
					}),
				),
			];
			return items;
		});

		// Join each grouped roster entry to its çaylak's identity (handle + karma) in ONE
		// batched profile read — so the single `divan.roster` fate request carries every
		// row's identity in-batch and the client fires NO per-row by-id `Profile` read
		// (ADR 0021's no-waterfalls contract, #1423). A çaylak with no profile row (or no
		// username yet) degrades to nulls + 0 karma; the client renders the "çaylak"
		// fallback label.
		const roster = Effect.fn("Divan.roster")(function* () {
			const entries = buildRoster(yield* collect());
			const identities = yield* pasaport.getProfileIdentitiesByIds(entries.map((e) => e.authorId));
			const byId = new Map(identities.map((i) => [i.userId, i]));
			return entries.map((e): DivanRosterRow => {
				const identity = byId.get(e.authorId);
				return {
					...e,
					username: identity?.username ?? null,
					displayName: identity?.displayName ?? null,
					totalKarma: identity?.totalKarma ?? 0,
				};
			});
		});

		return {
			roster,
			backlogOf: (authorId) =>
				Effect.map(collect({authorId}), (items) =>
					[...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
				),
		};
	}),
);
