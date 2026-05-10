import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./worker/features/pano/drizzle/schema.ts",
	out: "./worker/features/pano/drizzle/migrations",
});
