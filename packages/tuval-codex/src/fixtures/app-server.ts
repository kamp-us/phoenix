import {createInterface} from "node:readline";

let answer: unknown = null;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({input: process.stdin});
input.on("line", (line) => {
	const frame = JSON.parse(line);
	if (!frame.method) {
		answer = frame.result;
		return;
	}
	switch (frame.method) {
		case "initialize":
			send({id: frame.id, result: {userAgent: "fixture"}});
			break;
		case "initialized":
			break;
		case "test/pid":
			send({id: frame.id, result: process.pid});
			break;
		case "test/error":
			send({id: frame.id, error: {code: -32600, message: "Refused by fixture"}});
			break;
		case "test/exit":
			process.exit(3);
			break;
		case "test/hang":
			break;
		case "test/malformed":
			process.stdout.write("{bad json\n");
			break;
		case "test/approval":
			send({
				id: 42,
				method: "item/commandExecution/requestApproval",
				params: {threadId: "session"},
			});
			send({id: frame.id, result: {accepted: true}});
			break;
		case "test/readReply":
			send({id: frame.id, result: answer});
			break;
		case "test/unicode": {
			const encoded = Buffer.from(`${JSON.stringify({id: frame.id, result: "🦊"})}\n`);
			const split = encoded.indexOf(Buffer.from("🦊")) + 1;
			process.stdout.write(encoded.subarray(0, split));
			setTimeout(() => process.stdout.write(encoded.subarray(split)), 10);
			break;
		}
		default:
			send({id: frame.id, result: frame.params});
	}
});
input.on("close", () => process.exit(0));
