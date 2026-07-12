/**
 * The `depo put <file>` subcommand (ADR 0144 decision 5). It resolves the apiKey,
 * uploads the file via the client lib (`put`), and prints exactly the public URL
 * to stdout — so a caller can capture `$(depo put shot.png)` and embed it. Every
 * typed failure is turned into a legible stderr line + a non-zero exit; nothing
 * but the URL ever reaches stdout on success.
 *
 * The command self-contains its services (`Command.provide`) so the bin's run
 * boundary stays thin: it bakes in `DoormanClientLive` over `FetchHttpClient.layer`,
 * leaving the registered command's residual requirement at the Node platform union.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {put} from "./client.ts";
import type {
	ContentAddressConflict,
	DigestError,
	FileReadError,
	MissingCredential,
	PayloadTooLarge,
	Unauthorized,
	UnsupportedFile,
	UnsupportedMediaType,
	UploadFailed,
} from "./errors.ts";
import {resolveApiKey} from "./live.ts";

/** The full typed-failure union `put` (+ credential resolution) can raise. */
type PutFailure =
	| MissingCredential
	| UnsupportedFile
	| FileReadError
	| DigestError
	| Unauthorized
	| UnsupportedMediaType
	| PayloadTooLarge
	| ContentAddressConflict
	| UploadFailed;

const fileArg = Argument.string("file").pipe(
	Argument.withDescription("path to an allowlisted image (PNG/JPEG/WebP) to upload"),
);

const tokenFlag = Flag.string("token").pipe(
	Flag.optional,
	Flag.withDescription(
		"pasaport apiKey (else KAMPUS_TOKEN, else ~/.config/kampus/token — ADR 0045)",
	),
);

/**
 * Each typed failure → a one-line stderr message + a non-zero exit. The failure is
 * mapped here (not left to `NodeRuntime`'s stack dump) so an operator or a calling
 * skill gets a legible reason, and stdout stays clean for the URL alone.
 */
const reportAndExit = (message: string) =>
	Effect.gen(function* () {
		yield* Console.error(`depo: ${message}`);
		return yield* Effect.sync(() => process.exit(1));
	});

/** Map a typed put failure to its operator-legible one-line reason. */
const reasonOf = (error: PutFailure): string => {
	switch (error._tag) {
		case "depo/MissingCredential":
			return error.reason;
		case "depo/UnsupportedFile":
			return `unsupported file ${error.filename} (.${error.ext}) — allowed: png, jpg, jpeg, webp`;
		case "depo/FileReadError":
			return `cannot read ${error.path}: ${String(error.cause)}`;
		case "depo/DigestError":
			return `could not compute content address: ${String(error.cause)}`;
		case "depo/Unauthorized":
			return `unauthorized (401): ${error.message}`;
		case "depo/UnsupportedMediaType":
			return `rejected (415): ${error.message}`;
		case "depo/PayloadTooLarge":
			return `too large (413): ${error.message}`;
		case "depo/ContentAddressConflict":
			return `conflict (409): ${error.message}`;
		case "depo/UploadFailed":
			return `upload failed${error.status === null ? "" : ` (${error.status})`}: ${error.message}`;
	}
};

const putCommand = Command.make(
	"put",
	{file: fileArg, token: tokenFlag},
	Effect.fn(function* ({file, token}) {
		const run = Effect.gen(function* () {
			const apiKey = yield* resolveApiKey(token._tag === "Some" ? token.value : undefined);
			const url = yield* put({path: file, apiKey});
			yield* Console.log(url);
		});

		yield* run.pipe(Effect.catch((error) => reportAndExit(reasonOf(error))));
	}),
).pipe(Command.withDescription("Upload an image to depo and print its public URL"));

export const depoCommand = Command.make("depo").pipe(
	Command.withSubcommands([putCommand]),
	Command.withDescription("depo — kampus's internal asset store client (ADR 0144)"),
);
