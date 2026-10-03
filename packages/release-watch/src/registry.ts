/** The npm registry boundary: read one package's `latest` dist-tag. */
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as semver from "semver";

const REGISTRY = "https://registry.npmjs.org";

const LatestManifest = Schema.Struct({version: Schema.String});

/** The registry did not answer with a valid `latest` version for the package. */
export class RegistryError extends Schema.TaggedError<RegistryError>()(
	"@kampus/release-watch/RegistryError",
	{
		pkg: Schema.String,
		message: Schema.String,
	},
) {}

export const npmLatest = Effect.fn("Registry.npmLatest")(function* (pkg: string) {
	const response = yield* HttpClient.get(`${REGISTRY}/${pkg}/latest`).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.mapError((cause) => new RegistryError({pkg, message: cause.message})),
	);
	const manifest = yield* HttpClientResponse.schemaBodyJson(LatestManifest)(response).pipe(
		Effect.mapError((cause) => new RegistryError({pkg, message: cause.message})),
	);
	if (semver.valid(manifest.version) === null) {
		return yield* new RegistryError({
			pkg,
			message: `latest is ${JSON.stringify(manifest.version)}, not a version`,
		});
	}
	return manifest.version;
});
