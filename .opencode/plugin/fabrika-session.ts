import type {Plugin} from "@opencode-ai/plugin";

// Stamps every shell this opencode instance spawns with FABRIKA_SESSION_ID, resolved to the
// ROOT ancestor of the session running the command — one identity across an agent tree
// (operator + its builders), distinct across concurrent roots, matching what
// CLAUDE_CODE_SESSION_ID / PI_SUBAGENT_PARENT_SESSION give fabrika under cc/pi (#6978).
// An explicitly exported FABRIKA_SESSION_ID wins and is never overwritten.

const roots = new Map<string, Promise<string>>();

async function rootSession(client: any, sessionID: string): Promise<string> {
	let current = sessionID;
	for (let depth = 0; depth < 32; depth++) {
		const res = await client.session.get({path: {id: current}}).catch(() => undefined);
		const parent = res?.data?.parentID;
		if (!parent) return current;
		current = parent;
	}
	return current;
}

const FabrikaSessionPlugin: Plugin = ({client}) => ({
	"shell.env": async ({sessionID}, output) => {
		if (!sessionID || process.env.FABRIKA_SESSION_ID) return;
		let root = roots.get(sessionID);
		if (!root) {
			root = rootSession(client, sessionID);
			roots.set(sessionID, root);
		}
		output.env.FABRIKA_SESSION_ID = await root;
	},
});

export default FabrikaSessionPlugin;
export {FabrikaSessionPlugin};
