import {DurableObject} from "cloudflare:workers";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {createAuth, type Session} from "./auth";
import migrations from "./drizzle/migrations/migrations";
import * as schema from "./drizzle/schema";

export class Pasaport extends DurableObject<Env> {
	db = drizzle(this.ctx.storage, {schema});
	auth = createAuth(this.db);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname.startsWith("/api/auth/")) {
			return this.auth.handler(request);
		}
		return new Response("Not found", {status: 404});
	}

	async validateSession(headers: Headers): Promise<Session | null> {
		try {
			const session = await this.auth.api.getSession({headers});
			if (!session?.user) return null;
			return session;
		} catch (error) {
			console.error("[Pasaport.validateSession]", error);
			return null;
		}
	}
}
