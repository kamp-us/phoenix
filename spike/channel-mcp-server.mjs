// THROWAWAY SPIKE for #3034 (wayfinder map #3031) — NEVER MERGE.
//
// Proof-of-concept: two raw MCP servers, one per "session", wake each other over
// a unix socket and surface the wake to their host as a custom, non-allowlisted
// `notifications/claude/channel` notification. #3033 showed the high-level
// `McpServer` can't declare the channel capability, so this uses the low-level
// `Server` directly. This spike must NOT prejudge design issue #3040.
//
// Run (two panes):
//   node spike/channel-mcp-server.mjs --role a
//   node spike/channel-mcp-server.mjs --role b
// Then call the `send` tool on one; the other's host receives the channel notification.
//
// Grounded against @modelcontextprotocol/sdk@1.29.0:
//   - Server.notification() sends any {method, params}; assertNotificationCapability
//     has no default case, so a custom method passes through unvalidated.
//   - `_meta` is the SDK-standard params envelope field.

import net from "node:net";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const roleFlag = process.argv.indexOf("--role");
const role = roleFlag !== -1 ? process.argv[roleFlag + 1] : undefined;
if (role !== "a" && role !== "b") {
	console.error("usage: node spike/channel-mcp-server.mjs --role <a|b>");
	process.exit(1);
}
const peer = role === "a" ? "b" : "a";
const sockPath = (r) => `/tmp/claude-channel-spike-${r}.sock`;

const server = new Server(
	{ name: `channel-spike-${role}`, version: "0.0.0" },
	{
		capabilities: {
			tools: {},
			// The whole point: a custom, non-allowlisted channel capability.
			experimental: { "claude/channel": {} },
		},
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "send",
			description: `Send a message to the peer session (role ${peer}).`,
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name !== "send") throw new Error(`unknown tool: ${req.params.name}`);
	const message = String(req.params.arguments?.message ?? "");
	await new Promise((resolve, reject) => {
		const client = net.createConnection(sockPath(peer), () => {
			client.end(JSON.stringify({ from: role, message }) + "\n");
		});
		client.on("error", reject);
		client.on("close", resolve);
	});
	return { content: [{ type: "text", text: `sent to role ${peer}: ${message}` }] };
});

// Inbound: a line on THIS role's socket becomes a channel notification to our host.
try {
	fs.unlinkSync(sockPath(role));
} catch {
	// no stale socket — fine
}
const listener = net.createServer((conn) => {
	let buf = "";
	conn.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			const { from, message } = JSON.parse(line);
			server.notification({
				method: "notifications/claude/channel",
				params: { message, _meta: { from } },
			});
		}
	});
});
listener.listen(sockPath(role), () => {
	console.error(`[role ${role}] listening on ${sockPath(role)}`);
});

await server.connect(new StdioServerTransport());
console.error(`[role ${role}] MCP server connected over stdio; peer=${peer}`);
