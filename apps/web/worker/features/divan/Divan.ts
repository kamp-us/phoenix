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
 * gate (enforced at the fate resolver). The service read itself is unconditional,
 * exactly like the `listSandboxed*` reads it builds on.
 *
 * Two reads:
 *   - {@link Divan.roster} — the pending-çaylak roster (grouped by author, per-kind
 *     counts) across ALL authors.
 *   - {@link Divan.backlogOf} — one çaylak's sandboxed backlog (the items, for the
 *     #1290 detail view), newest first.
 */
import {Context, Effect, Layer} from "effect";
import {UserId} from "../../lib/ids.ts";
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
		readonly backlogOf: (authorId: UserId) => Effect.Effect<ReadonlyArray<DivanItem>>;
		/**
		 * How many still-pending (sandboxed, not-removed) items one author has across
		 * all three kinds — the mod-notification transition gate (#1699): a create path
		 * fires the "new çaylak awaiting review" page only when this count is exactly 1
		 * right after a çaylak's item committed (their 0→1 entry onto the roster), so a
		 * çaylak's second and later items don't re-page the team.
		 */
		// `authorId` stays unbranded `string` (unlike `backlogOf`'s `UserId`): the only
		// caller is bildirim's `notifyCaylakEntersDivan` (`mod-emitters.ts`), which passes a
		// plain-string author id — branding this param would fail typecheck in that
		// out-of-feature site, which epic #2700's report slice (#2721) does not touch.
		readonly pendingCountOf: (authorId: string) => Effect.Effect<number>;
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
						authorId: UserId.make(d.authorId),
						createdAt: d.createdAt,
						preview: preview(d.body),
					}),
				),
				...posts.map(
					(p): DivanItem => ({
						kind: "post",
						id: p.id,
						authorId: UserId.make(p.authorId),
						createdAt: p.createdAt,
						preview: preview(p.title),
					}),
				),
				...comments.map(
					(c): DivanItem => ({
						kind: "comment",
						id: c.id,
						authorId: UserId.make(c.authorId),
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
			pendingCountOf: (authorId) => Effect.map(collect({authorId}), (items) => items.length),
		};
	}),
);
