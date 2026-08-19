import {defineConfig} from "drizzle-kit";

// `dbCredentials` is read ONLY by `drizzle-kit migrate` — alchemy resolves the D1
// database by name and never reads this block, and `generate` works without credentials.
// `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` are two of the four CI secrets
// enumerated in `infra/ci-credentials/github.ts`; keep the names in sync (#1432).
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
