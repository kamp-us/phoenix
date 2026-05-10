import {defineConfig} from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./worker/features/pano/post-drizzle/schema.ts",
	out: "./worker/features/pano/post-drizzle/migrations",
});
