/**
 * `ui law` — the typed prohibition registry, schema-validated whole-file, rows in file order.
 *
 * Three different facts, three different codes, and the skill's prose fallback is legal only in the
 * first: untyped (`13` — no registry beside the manifest), mistyped (`4` — a registry that violates
 * the schema), unreadable (`11` — the law is UNKNOWN, never "untyped").
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS, NO_MANIFEST, PRECONDITION_UNKNOWN, UNTYPED_LAW} from "./codes.ts";
import {atRoot, MANIFEST_PATH, REGISTRY_PATH} from "./conventions.ts";
import {resolveRoot} from "./lane.ts";
import {parseRegistry} from "./law.ts";
import {probe} from "./manifest-verb.ts";

const VERB = "ui law";

export const runLaw = (): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const root = yield* resolveRoot(VERB);
		if (root._tag === "Refused") return root.outcome;

		const manifest = yield* probe(root.root, MANIFEST_PATH);
		if (manifest._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${MANIFEST_PATH}: ${manifest.reason} — presence is UNKNOWN, never "absent".`,
			);
		}
		if (manifest._tag === "Absent") {
			return refuse(
				NO_MANIFEST,
				`${VERB}: no design manifest at ${MANIFEST_PATH} — run /fabrika (#4952).`,
			);
		}

		const registry = yield* probe(root.root, REGISTRY_PATH);
		if (registry._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${REGISTRY_PATH}: ${registry.reason} — the law is UNKNOWN, never "untyped".`,
			);
		}
		if (registry._tag === "Absent") {
			return refuse(
				UNTYPED_LAW,
				`${VERB}: the law is untyped — no ${REGISTRY_PATH} beside the manifest. The manifest's prose prohibitions are the law; note LAW-SOURCE: manifest-prose in the PR.`,
			);
		}

		const text = yield* readFile(atRoot(root.root, REGISTRY_PATH)).pipe(
			Effect.catchTag("fabrika-cli/ReadFailed", (cause) => Effect.succeed(cause)),
		);
		if (typeof text !== "string") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${REGISTRY_PATH}: ${text.reason} — the law is UNKNOWN, never "untyped".`,
			);
		}
		const parsed = parseRegistry(text);
		if (parsed._tag === "Violation") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: ${REGISTRY_PATH} exists but does not satisfy the registry schema: ${parsed.violation} — refusing the whole file; half a law is not a law.`,
			);
		}
		return answer(JSON.stringify({lawSource: "registry", rows: parsed.rows}), [
			`${VERB}: validated ${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"} against the registry schema.`,
		]);
	});
