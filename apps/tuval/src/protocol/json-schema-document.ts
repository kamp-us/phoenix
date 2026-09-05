/**
 * The JSON Schema document a rendered parameter schema rides in.
 *
 * This mirrors `JsonSchema.Document<"draft-2020-12">` at the `catalogs.tuval` pin (effect
 * 4.0.0-rc.112, `dist/JsonSchema.d.ts`): `{dialect, schema, definitions}`, the root schema held
 * apart from the definitions it points into with `#/$defs/<name>`. It is declared here rather than
 * imported as a schema because effect exports `Document` as a type only — there is no `Schema` for
 * it — and the wire needs one that decodes.
 *
 * The inner nodes stay open (`Record(String, Unknown)`): the protocol decides that a document
 * arrived, not which JSON Schema keywords it used.
 */

import {Schema} from "effect";

/** One JSON Schema node — an open record, as `JsonSchema.JsonSchema` is at the pin. */
export const JsonSchemaNode = Schema.Record(Schema.String, Schema.Unknown);
export type JsonSchemaNode = typeof JsonSchemaNode.Type;

export const JsonSchemaDocument = Schema.Struct({
	dialect: Schema.Literal("draft-2020-12"),
	schema: JsonSchemaNode,
	definitions: Schema.Record(Schema.String, JsonSchemaNode),
});
export type JsonSchemaDocument = typeof JsonSchemaDocument.Type;
