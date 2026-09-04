/**
 * Encoding and decoding, through the same message classes in both directions.
 *
 * A decode is total: it answers with the message or with `ProtocolRefused` naming the direction and
 * the schema issue. Nothing here throws and nothing resolves a malformed frame to a partial value.
 */

import {Effect, Schema} from "effect";
import {type Direction, ProtocolRefused} from "./errors.ts";
import {describeSchemaError} from "./issue.ts";
import {parseJson, stringifyJson} from "./json.ts";
import {KernelToPage, PageToKernel} from "./messages.ts";

const decodeFor =
	<S extends Schema.Codec<any, any>>(schema: S, direction: Direction) =>
	(text: string): Effect.Effect<S["Type"], ProtocolRefused> => {
		const refuse = (reason: string) => new ProtocolRefused({direction, reason});
		const parsed = parseJson(text);
		if (parsed._tag === "Failed") {
			return Effect.fail(refuse(`not JSON: ${parsed.reason}`));
		}
		return Schema.decodeUnknownEffect(schema)(parsed.value).pipe(
			Effect.mapError((error) => refuse(describeSchemaError(error))),
		);
	};

const encodeFor =
	<S extends Schema.Codec<any, any>>(schema: S, direction: Direction) =>
	(message: S["Type"]): Effect.Effect<string, ProtocolRefused> =>
		Schema.encodeEffect(schema)(message).pipe(
			Effect.map(stringifyJson),
			Effect.mapError(
				(error) => new ProtocolRefused({direction, reason: describeSchemaError(error)}),
			),
		);

export const decodePageMessage = decodeFor(PageToKernel, "page-to-kernel");
export const decodeKernelMessage = decodeFor(KernelToPage, "kernel-to-page");

export const encodePageMessage = encodeFor(PageToKernel, "page-to-kernel");
export const encodeKernelMessage = encodeFor(KernelToPage, "kernel-to-page");
