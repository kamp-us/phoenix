/**
 * Legacy Pasaport Durable Object — kept only to satisfy the wrangler v1
 * migration `new_sqlite_classes: ["Pasaport"]` reference. Every production
 * code path now calls module functions in `./module.ts` against
 * `env.PHOENIX_DB`; this class is unreferenced.
 *
 * Task 4 (d1-direct) deletes this file along with the `PASAPORT` binding
 * and the `migrations` entries.
 */
import {DurableObject} from "cloudflare:workers";

export class Pasaport extends DurableObject<Env> {
	override async fetch(_request: Request): Promise<Response> {
		return new Response("pasaport DO is deprecated — see worker/features/pasaport/module.ts", {
			status: 410,
		});
	}
}
