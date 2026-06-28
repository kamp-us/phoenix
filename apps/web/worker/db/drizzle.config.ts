import {defineConfig} from "drizzle-kit";

// `dbCredentials` is consumed only by `drizzle-kit migrate` (the `pnpm db:migrate`
// escape hatch for applying pending migrations short of a full `alchemy deploy`).
// alchemy resolves the D1 database by name and never reads this block.
// `D1_DATABASE_ID` is the D1 UUID (Cloudflare dashboard / `wrangler d1 list`); the
// account id + token reuse alchemy's own deploy credentials (see deploy.yml). Missing
// values surface as drizzle-kit's own "Please provide required params" error on migrate;
// `generate` never reads this block, so it works without credentials.
//
// CI-secret roster: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` are two of the four
// CI secrets enumerated canonically in `infra/ci-credentials/github.ts` (the provisioner);
// keep these names in sync with that roster (#1432).
export default defineConfig({
	dialect: "sqlite",
	driver: "d1-http",
	schema: "./worker/db/drizzle/schema.ts",
	out: "./worker/db/drizzle/migrations",
	dbCredentials: {
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
		databaseId: process.env.D1_DATABASE_ID ?? "",
		token: process.env.CLOUDFLARE_API_TOKEN ?? "",
	},
});
