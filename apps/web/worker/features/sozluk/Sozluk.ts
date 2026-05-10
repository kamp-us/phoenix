import {DurableObject} from "cloudflare:workers";
import {asc, count, desc, eq, sql, sum} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./drizzle/migrations/migrations";
import * as schema from "./drizzle/schema";
import {SEED_TERMS} from "./seed";

export type ListSort = "recent" | "popular";

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
			await this.seedIfEmpty();
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
			.orderBy(sort === "popular" ? desc(sql`totalScore`) : desc(schema.term.createdAt))
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

	private async seedIfEmpty(): Promise<void> {
		const rows = await this.db.select({n: count(schema.term.id)}).from(schema.term);
		if (Number(rows[0]?.n ?? 0) > 0) return;

		for (const t of SEED_TERMS) {
			const [inserted] = await this.db
				.insert(schema.term)
				.values({slug: t.slug, title: t.title})
				.returning({id: schema.term.id});
			if (!inserted) continue;
			for (const d of t.definitions) {
				await this.db.insert(schema.definition).values({
					termId: inserted.id,
					authorId: d.authorId,
					authorName: d.authorName,
					body: d.body,
					score: d.score,
				});
			}
		}
	}
}

function excerpt(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= EXCERPT_LEN) return flat;
	return `${flat.slice(0, EXCERPT_LEN - 1).trimEnd()}…`;
}
