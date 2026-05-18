import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	driver: "d1-http",
	schema: "./worker/db/drizzle/schema.ts",
	out: "./worker/db/drizzle/migrations",
});
