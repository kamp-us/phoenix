/**
 * edge/tool-schema-guard — the boot fence over every registered tool's GENERATED `inputSchema`.
 * Generic (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * The MCP spec requires a tool's `inputSchema` to be a top-level `{"type":"object"}`, and the Claude
 * Code CLI validates the entire `ListToolsResult`: ONE spec-invalid tool schema makes the client
 * reject the whole response, so every OTHER tool on the server is zeroed as collateral and nothing
 * fail-louds anywhere — the silent all-seats channel outage of #3753. This fence turns that class
 * from "every seat silently boots with no channel tools" into "the server refuses to serve, naming
 * the offending tool", and it asserts the SAME schema the server serves (`Tool.getJsonSchema`, the
 * generator `McpServer` itself calls) rather than re-deriving the shape.
 */
import {Effect, Schema} from "effect";
import {Tool, type Toolkit} from "effect/unstable/ai";

/** One registered tool's generated `inputSchema`, as the fence read it. */
export interface ToolSchema {
	readonly tool: string;
	readonly inputSchema: unknown;
}

/** One or more registered tools generate an `inputSchema` that is not a top-level object. */
export class InvalidToolSchemaError extends Schema.TaggedErrorClass<InvalidToolSchemaError>()(
	"@kampus/pipeline-crew-mcp/edge/InvalidToolSchemaError",
	{
		tools: Schema.Array(Schema.String),
		detail: Schema.String,
	},
) {
	override get message(): string {
		return (
			`spec-invalid MCP inputSchema on ${this.tools.join(", ")} — the MCP spec requires a ` +
			`top-level {"type":"object"}, and a client rejects the WHOLE tools/list response on one bad ` +
			`schema, zeroing every other tool (#3753). Generated: ${this.detail}`
		);
	}
}

/**
 * The offending tools across `toolkits`, in registration order. Pure and reading the SAME generator
 * the server serves (`Tool.getJsonSchema`) — so the fence is testable against a deliberately invalid
 * tool without standing up a server or a transport.
 */
export const findInvalidToolSchemas = (
	toolkits: ReadonlyArray<Toolkit.Any>,
): ReadonlyArray<ToolSchema> =>
	toolkits.flatMap((toolkit) =>
		Object.values(toolkit.tools)
			.map((tool) => ({tool: tool.name, inputSchema: Tool.getJsonSchema(tool)}))
			.filter(({inputSchema}) => (inputSchema as {readonly type?: unknown}).type !== "object"),
	);

/**
 * Assert every tool in `toolkits` serves a spec-valid `inputSchema`. Run on the boot critical path
 * (before the transport forks its serve loop) so a violation aborts the build instead of shipping a
 * server whose toolset the client will silently discard.
 */
export const assertToolSchemas = (
	toolkits: ReadonlyArray<Toolkit.Any>,
): Effect.Effect<void, InvalidToolSchemaError> => {
	const invalid = findInvalidToolSchemas(toolkits);
	if (invalid.length === 0) return Effect.void;
	return Effect.fail(
		new InvalidToolSchemaError({
			tools: invalid.map(({tool}) => tool),
			detail: invalid.map((v) => `${v.tool}=${JSON.stringify(v.inputSchema)}`).join(" · "),
		}),
	);
};
