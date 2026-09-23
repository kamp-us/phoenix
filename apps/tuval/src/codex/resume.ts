import {isDeepStrictEqual} from "node:util";
import type {TranscriptItem} from "@kampus/tuval/ai-agent/ports";
import type {ResumeTarget} from "@kampus/tuval/kernel/ai-agent/service/index";

const contents = ({timestamp: _timestamp, ...item}: TranscriptItem) => item;

export const resumeItems = (
	items: ReadonlyArray<TranscriptItem>,
	target: ResumeTarget,
): ReadonlyArray<TranscriptItem> => {
	if (!target.holdsTranscript) return items;
	const held = new Map(target.held.map((item) => [item.id, item]));
	const boundary = items.findLastIndex((item) => held.has(item.id));
	return items.filter((item, index) => {
		const previous = held.get(item.id);
		return (
			index > boundary ||
			(previous !== undefined && !isDeepStrictEqual(contents(previous), contents(item)))
		);
	});
};
