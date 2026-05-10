import {DurableObject} from "cloudflare:workers";
import {and, asc, count, desc, eq, sql, sum} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./drizzle/migrations/migrations";
import * as schema from "./drizzle/schema";

export type ListSort = "recent" | "popular";

export interface UpsertDefinitionInput {
	authorId: string;
	authorName: string;
	body: string;
	score?: number | undefined;
}

export interface UpsertTermInput {
	slug: string;
	title: string;
	definitions: UpsertDefinitionInput[];
}

export interface UpsertTermResult {
	termId: string;
	insertedDefinitions: number;
}

export interface ClearAllResult {
	terms: number;
	definitions: number;
}

export interface TermSummary {
	id: string;
	slug: string;
	title: string;
	count: number;
	totalScore: number;
	excerpt: string | null;
}

export interface DefinitionRow {
	id: string;
	score: number;
	body: string;
	author: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface TermPage {
	id: string;
	slug: string;
	title: string;
	totalDefinitions: number;
	totalScore: number;
	firstAt: Date;
	lastEdit: Date;
	definitions: DefinitionRow[];
}

const EXCERPT_LEN = 140;

export class Sozluk extends DurableObject<Env> {
	db = drizzle(this.ctx.storage, {schema});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	async listTerms(opts: {sort?: ListSort; limit?: number} = {}): Promise<TermSummary[]> {
		const sort = opts.sort ?? "recent";
		const limit = opts.limit ?? 50;

		/* Per-term aggregates: count + sum(score) + first definition body for excerpt. */
		const rows = await this.db
			.select({
				id: schema.term.id,
				slug: schema.term.slug,
				title: schema.term.title,
				createdAt: schema.term.createdAt,
				count: count(schema.definition.id),
				totalScore: sql<number>`coalesce(${sum(schema.definition.score)}, 0)`,
				topBody: sql<string | null>`(
					select ${schema.definition.body}
					from ${schema.definition}
					where ${schema.definition.termId} = ${schema.term.id}
					order by ${schema.definition.score} desc, ${schema.definition.createdAt} asc
					limit 1
				)`,
			})
			.from(schema.term)
			.leftJoin(schema.definition, eq(schema.definition.termId, schema.term.id))
			.groupBy(schema.term.id)
			.orderBy(
				sort === "popular"
					? desc(sql`coalesce(${sum(schema.definition.score)}, 0)`)
					: desc(schema.term.createdAt),
			)
			.limit(limit);

		return rows.map((r) => ({
			id: r.id,
			slug: r.slug,
			title: r.title,
			count: Number(r.count),
			totalScore: Number(r.totalScore),
			excerpt: r.topBody ? excerpt(r.topBody) : null,
		}));
	}

	async getTerm(slug: string): Promise<TermPage | null> {
		const t = await this.db.query.term.findFirst({
			where: eq(schema.term.slug, slug),
		});
		if (!t) return null;

		const defs = await this.db
			.select()
			.from(schema.definition)
			.where(eq(schema.definition.termId, t.id))
			.orderBy(desc(schema.definition.score), asc(schema.definition.createdAt));

		const firstAt =
			defs.reduce<Date | null>((acc, d) => {
				const c = d.createdAt;
				if (!c) return acc;
				return acc && acc < c ? acc : c;
			}, null) ??
			t.createdAt ??
			new Date(0);

		const lastEdit =
			defs.reduce<Date | null>((acc, d) => {
				const u = d.updatedAt ?? d.createdAt;
				if (!u) return acc;
				return acc && acc > u ? acc : u;
			}, null) ?? firstAt;

		return {
			id: t.id,
			slug: t.slug,
			title: t.title,
			totalDefinitions: defs.length,
			totalScore: defs.reduce((sum, d) => sum + d.score, 0),
			firstAt,
			lastEdit,
			definitions: defs.map((d) => ({
				id: d.id,
				score: d.score,
				body: d.body,
				author: d.authorName,
				createdAt: d.createdAt ?? new Date(0),
				updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0),
			})),
		};
	}

	/**
	 * Idempotent term + definitions insert. Used by the dev-only importer that
	 * reads MDX content from the legacy monorepo. Existing terms are preserved;
	 * existing definitions (matched by `(authorId, body)` per term) are skipped
	 * so re-running the importer is a no-op.
	 */
	async upsertTerm(input: UpsertTermInput): Promise<UpsertTermResult> {
		const existing = await this.db.query.term.findFirst({
			where: eq(schema.term.slug, input.slug),
		});

		const termId = await (async () => {
			if (existing) return existing.id;
			const [row] = await this.db
				.insert(schema.term)
				.values({slug: input.slug, title: input.title})
				.returning({id: schema.term.id});
			if (!row) throw new Error(`Failed to insert term ${input.slug}`);
			return row.id;
		})();

		let insertedDefinitions = 0;
		for (const def of input.definitions) {
			const dupe = await this.db.query.definition.findFirst({
				where: and(
					eq(schema.definition.termId, termId),
					eq(schema.definition.authorId, def.authorId),
					eq(schema.definition.body, def.body),
				),
			});
			if (dupe) continue;
			await this.db.insert(schema.definition).values({
				termId,
				authorId: def.authorId,
				authorName: def.authorName,
				body: def.body,
				score: def.score ?? 0,
			});
			insertedDefinitions++;
		}

		return {termId, insertedDefinitions};
	}

	/**
	 * Wipe every term and definition. Definitions cascade via the term FK, but
	 * we delete both explicitly to return accurate counts.
	 */
	async clearAll(): Promise<ClearAllResult> {
		const [defCount] = await this.db
			.select({n: count(schema.definition.id)})
			.from(schema.definition);
		const [termCount] = await this.db.select({n: count(schema.term.id)}).from(schema.term);

		await this.db.delete(schema.definition);
		await this.db.delete(schema.term);

		return {
			terms: Number(termCount?.n ?? 0),
			definitions: Number(defCount?.n ?? 0),
		};
	}
}

function excerpt(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= EXCERPT_LEN) return flat;
	return `${flat.slice(0, EXCERPT_LEN - 1).trimEnd()}…`;
}
