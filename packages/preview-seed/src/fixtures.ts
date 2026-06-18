/**
 * The fixture content the unauthenticated read e2e specs sample — a pure,
 * deterministic description of the rows the seed writes. No I/O, no DB: this is
 * the unit-testable core. `buildFixtures` returns typed insert values shaped to
 * the three read-model tables (`term_summary`, `definition_view`,
 * `post_summary`); `seed.ts` turns them into idempotent upserts.
 *
 * What each row satisfies (the specs in apps/web/tests/e2e):
 *   - term + ≥1 definition → 00-smoke, 07-sozluk-term: a `.kp-sozluk-term-row`
 *     on /sozluk, a `.kp-sozluk-term__title` + a `.kp-sozluk-definition` card on
 *     /sozluk/<slug>, and the first (top-scoring) definition carries `--top`.
 *   - ≥1 pano post → 00-smoke, 03-pano-feed: a `.kp-pano-post` on /pano whose
 *     "N yorum" permalink lands on /pano/<id> and renders `.kp-pano-postpage__title`.
 *
 * IDs/slugs are stable string literals (not random) so a re-run upserts the same
 * rows — the idempotency contract lives here, in the fixed identity.
 */
import type {seedSchema} from "./schema.ts";

type TermSummaryInsert = typeof seedSchema.termSummary.$inferInsert;
type DefinitionViewInsert = typeof seedSchema.definitionView.$inferInsert;
type PostSummaryInsert = typeof seedSchema.postSummary.$inferInsert;

export interface Fixtures {
	readonly terms: ReadonlyArray<TermSummaryInsert>;
	readonly definitions: ReadonlyArray<DefinitionViewInsert>;
	readonly posts: ReadonlyArray<PostSummaryInsert>;
}

/** Stable identity of the single seeded fixture set — also the public surface the specs lean on. */
export const SEED_TERM_SLUG = "merhaba-dunya";
export const SEED_POST_ID = "seed-post-tanitim";

const SEED_AUTHOR_ID = "seed-author";
const SEED_AUTHOR_NAME = "kampüs";

/** First non-deleted definition by (score DESC, created_at ASC, id ASC) gets `--top`. */
const TOP_DEFINITION_ID = "seed-def-merhaba-1";

const lowerFirstLetter = (title: string): string => (title[0] ?? "").toLocaleLowerCase("tr");

const excerptOf = (body: string, max = 160): string =>
	body.length <= max ? body : `${body.slice(0, max - 1)}…`;

/**
 * Build the fixture set at a fixed clock. `now` is injected (not read from the
 * wall clock) so the output is deterministic and the unit tests pin exact rows.
 */
export const buildFixtures = (now: Date = new Date("2026-01-01T00:00:00Z")): Fixtures => {
	const termTitle = "merhaba dünya";
	const topBody =
		"kampüs'e hoş geldin. bu, önizleme ortamının okuma akışlarını besleyen tohum tanımıdır.";
	const secondBody =
		"ikinci bir tanım — terim sayfasının birden fazla kartı listelediğini doğrular.";

	const terms: ReadonlyArray<TermSummaryInsert> = [
		{
			slug: SEED_TERM_SLUG,
			title: termTitle,
			firstLetter: lowerFirstLetter(termTitle),
			definitionCount: 2,
			totalScore: 7,
			excerpt: excerptOf(topBody),
			topDefinitionId: TOP_DEFINITION_ID,
			firstAt: now,
			lastActivityAt: now,
			lastEditAt: now,
		},
	];

	const definitions: ReadonlyArray<DefinitionViewInsert> = [
		{
			id: TOP_DEFINITION_ID,
			authorId: SEED_AUTHOR_ID,
			authorName: SEED_AUTHOR_NAME,
			termSlug: SEED_TERM_SLUG,
			termTitle,
			body: topBody,
			bodyExcerpt: excerptOf(topBody),
			score: 5,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "seed-def-merhaba-2",
			authorId: SEED_AUTHOR_ID,
			authorName: SEED_AUTHOR_NAME,
			termSlug: SEED_TERM_SLUG,
			termTitle,
			body: secondBody,
			bodyExcerpt: excerptOf(secondBody),
			score: 2,
			createdAt: now,
			updatedAt: now,
		},
	];

	const postBody =
		"önizleme ortamı için tohum gönderisi — pano akışının en az bir gönderi listelediğini doğrular.";

	const posts: ReadonlyArray<PostSummaryInsert> = [
		{
			id: SEED_POST_ID,
			slug: SEED_POST_ID,
			title: "kampüs önizleme tohumu",
			// url/host are nullable and deliberately left unset: drizzle then renders a literal
			// NULL in the INSERT text instead of binding `null` as a param. D1's REST `params` is
			// strict string[] and rejects a null element — see d1-rest.ts toRestParams (#569).
			body: postBody,
			bodyExcerpt: excerptOf(postBody),
			authorId: SEED_AUTHOR_ID,
			authorName: SEED_AUTHOR_NAME,
			tags: "meta",
			score: 9,
			commentCount: 0,
			// Lead the "sıcak" (hot) tab — ordered by hot_score DESC.
			hotScore: 1_000_000,
			createdAt: now,
			updatedAt: now,
			lastActivityAt: now,
		},
	];

	return {terms, definitions, posts};
};
