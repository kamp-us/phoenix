/**
 * The read model behind the çaylak proving ground (#1287), composing the existing
 * `listSandboxed*` reads and grouping them by author so the divan's unit is the
 * **person**, not loose items.
 *
 * It must NOT re-derive the sandbox predicate or touch `sandboxVisibleWhere` — inline
 * sözlük/pano reads stay `{mod, author}`. These reads are unconditional; the yazar gate
 * (`requireDivanAccess`) is enforced at the fate resolver, not here.
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
		readonly roster: () => Effect.Effect<ReadonlyArray<DivanRosterRow>>;
		/** Newest first. */
		readonly backlogOf: (authorId: UserId) => Effect.Effect<ReadonlyArray<DivanItem>>;
		/**
		 * The mod-notification transition gate (#1699): a create path pages the team only
		 * when this count is exactly 1 right after an item committed — the author's 0→1
		 * entry onto the roster — so their later items don't re-page.
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

		// ONE batched profile read, so the client fires no per-row by-id `Profile` read
		// (ADR 0021's no-waterfalls contract). A çaylak with no profile row degrades to
		// nulls + 0 karma rather than dropping off the roster.
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
