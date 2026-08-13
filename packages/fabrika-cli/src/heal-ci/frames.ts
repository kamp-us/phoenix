/**
 * The framed multi-context log stream `heal-ci logs` writes and `heal-ci classify` reads.
 *
 * One module because two verbs must agree on it byte for byte: a writer its own reader cannot split
 * is how a five-context stream comes to be classified as one signature by whichever pattern matched
 * first, and hand-rolling the split at the caller would put a parser on the one surface this skill
 * declares attacker-authorable.
 */

export interface LogFrame {
	/** The gating context the block came from, or `-` for an unframed body. */
	readonly context: string;
	readonly jobId: string;
	readonly bytes: number;
	readonly truncated: boolean;
	readonly text: string;
}

/** The null token this group prints for a field with no value. */
export const NULL_TOKEN = "-";

const HEADER = /^==== context (.+?) job (\S+) bytes (\d+) truncated (true|false) ====$/;

const endOf = (context: string): string => `==== end ${context} ====`;

export const renderFrame = (frame: LogFrame): string =>
	[
		`==== context ${frame.context} job ${frame.jobId} bytes ${frame.bytes} truncated ${frame.truncated} ====`,
		frame.text,
		endOf(frame.context),
	].join("\n");

/**
 * Split a stream into blocks, in the order received.
 *
 * A stream carrying no header at all is one block under context `-` — the bare-body case, which is
 * how a caller pipes a single log in by hand. Anything outside a frame (the `logs` header line, say)
 * is not a block and is dropped rather than classified as one.
 */
export const parseFrames = (stream: string): ReadonlyArray<LogFrame> => {
	const lines = stream.split("\n");
	const frames: LogFrame[] = [];
	let open: {header: RegExpExecArray; body: string[]} | null = null;

	for (const line of lines) {
		if (open === null) {
			const header = HEADER.exec(line);
			if (header !== null) open = {header, body: []};
			continue;
		}
		const context = open.header[1] ?? NULL_TOKEN;
		if (line === endOf(context)) {
			frames.push({
				context,
				jobId: open.header[2] ?? NULL_TOKEN,
				bytes: Number.parseInt(open.header[3] ?? "0", 10),
				truncated: open.header[4] === "true",
				text: open.body.join("\n"),
			});
			open = null;
			continue;
		}
		open.body.push(line);
	}

	// An unterminated frame still carries bytes a caller must be allowed to classify; dropping it
	// would answer "nothing failed" over a log that was merely cut off mid-transfer.
	if (open !== null) {
		frames.push({
			context: open.header[1] ?? NULL_TOKEN,
			jobId: open.header[2] ?? NULL_TOKEN,
			bytes: Number.parseInt(open.header[3] ?? "0", 10),
			truncated: true,
			text: open.body.join("\n"),
		});
	}

	if (frames.length > 0) return frames;
	return [
		{
			context: NULL_TOKEN,
			jobId: NULL_TOKEN,
			bytes: new TextEncoder().encode(stream).length,
			truncated: false,
			text: stream.replace(/\n$/, ""),
		},
	];
};
