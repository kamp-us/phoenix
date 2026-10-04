/**
 * `digest` — the opt-in report of missed response targets a scheduled run posts to a chat webhook.
 *
 * **An absent block is off**: `table digest` reads nothing, sends nothing and exits clean, and no
 * other verb reads this key. A declared block names the chat tool and takes the shipped value for
 * every sub-key it leaves out, so `"digest": {"tool": "slack"}` is a working report.
 *
 * **The webhook URL is a credential and never a value here.** `webhookEnv` holds the name of the
 * environment variable the URL is read from. A value that is not a variable name is refused without
 * being echoed, because the likeliest wrong value is the URL itself.
 *
 * `sections` is a list of names, so a later section is a new name and never a change of shape.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10357
 */

import type {JsonSchema} from "../json-schema.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const DIGEST = "digest";

export const CHAT_TOOLS = ["slack", "discord"] as const;
export type ChatTool = (typeof CHAT_TOOLS)[number];

export const DIGEST_SECTIONS = ["triage", "on-call"] as const;
export type DigestSection = (typeof DIGEST_SECTIONS)[number];

export interface DigestSettings {
	readonly tool: ChatTool;
	/** The environment variable that holds the webhook URL. */
	readonly webhookEnv: string;
	readonly sections: ReadonlyArray<DigestSection>;
	/** How long an untriaged issue may wait before the report lists it. */
	readonly triageTargetHours: number;
	/** Post a message when nothing is past its target, instead of staying silent. */
	readonly allClear: boolean;
}

export type Digest = {readonly _tag: "Off"} | ({readonly _tag: "On"} & DigestSettings);

export const DIGEST_OFF: Digest = {_tag: "Off"};

export const SHIPPED_DIGEST: Omit<DigestSettings, "tool"> = {
	webhookEnv: "FABRIKA_DIGEST_WEBHOOK",
	sections: DIGEST_SECTIONS,
	triageTargetHours: 24,
	allClear: false,
};

const named = (path: string): string => `\`${DIGEST}.${path}\``;

const malformed = (reason: string): {readonly _tag: "Malformed"; readonly reason: string} => ({
	_tag: "Malformed",
	reason,
});

const KNOWN = ["tool", "webhookEnv", "sections", "triageTargetHours", "allClear"];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isOneOf = <A extends string>(options: ReadonlyArray<A>, raw: unknown): raw is A =>
	typeof raw === "string" && (options as ReadonlyArray<string>).includes(raw);

const sections = (raw: unknown): Decoded<ReadonlyArray<DigestSection>> => {
	if (raw === undefined) return {_tag: "Value", value: SHIPPED_DIGEST.sections};
	if (!Array.isArray(raw)) return malformed(`${named("sections")} is not a list of section names`);
	const names: DigestSection[] = [];
	for (const [index, entry] of raw.entries()) {
		if (!isOneOf(DIGEST_SECTIONS, entry)) {
			return malformed(
				`${named(`sections[${index}]`)} is not a section — one of ${DIGEST_SECTIONS.join(", ")}`,
			);
		}
		if (names.includes(entry)) return malformed(`${named("sections")} names "${entry}" twice`);
		names.push(entry);
	}
	return names.length === 0
		? malformed(
				`${named("sections")} names no section — leave \`${DIGEST}\` out to turn the report off`,
			)
		: {_tag: "Value", value: names};
};

const decode = (raw: unknown): Decoded<Digest> => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return malformed(`\`${DIGEST}\` is not an object`);
	}
	const record = raw as Record<string, unknown>;
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return malformed(`${named(stray)} is not a setting — one of ${KNOWN.join(", ")}`);
	}
	if (!isOneOf(CHAT_TOOLS, record.tool)) {
		return malformed(`${named("tool")} is not a chat tool — one of ${CHAT_TOOLS.join(", ")}`);
	}
	const webhookEnv = record.webhookEnv ?? SHIPPED_DIGEST.webhookEnv;
	if (typeof webhookEnv !== "string" || !ENV_NAME.test(webhookEnv)) {
		return malformed(
			`${named("webhookEnv")} is not an environment variable name — it names the variable that holds the webhook URL, and the URL itself never goes in this file`,
		);
	}
	const wanted = sections(record.sections);
	if (wanted._tag === "Malformed") return wanted;
	const hours = record.triageTargetHours ?? SHIPPED_DIGEST.triageTargetHours;
	if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
		return malformed(`${named("triageTargetHours")} is not a positive number of hours`);
	}
	const allClear = record.allClear ?? SHIPPED_DIGEST.allClear;
	if (typeof allClear !== "boolean") {
		return malformed(`${named("allClear")} is not true or false`);
	}
	return {
		_tag: "Value",
		value: {
			_tag: "On",
			tool: record.tool,
			webhookEnv,
			sections: wanted.value,
			triageTargetHours: hours,
			allClear,
		},
	};
};

const jsonSchema: JsonSchema = {
	type: "object",
	description:
		"Post a report of missed response targets to a chat webhook when `fabrika table digest` runs, usually from a scheduled workflow. Leave it out and nothing is sent.",
	properties: {
		tool: {
			type: "string",
			enum: [...CHAT_TOOLS],
			description: "The chat tool whose webhook receives the report.",
		},
		webhookEnv: {
			type: "string",
			pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
			description:
				"The name of the environment variable that holds the webhook URL. The URL is a credential: keep it in a secret, never in this file. Default FABRIKA_DIGEST_WEBHOOK.",
		},
		sections: {
			type: "array",
			items: {type: "string", enum: [...DIGEST_SECTIONS]},
			minItems: 1,
			uniqueItems: true,
			description:
				"The sections the report carries. `triage`: untriaged issues past `triageTargetHours`. `on-call`: open on-call items past the `boards.onCall` response target their labels pick. Default both.",
		},
		triageTargetHours: {
			type: "number",
			exclusiveMinimum: 0,
			description:
				"How many hours an untriaged issue may wait before the report lists it. Default 24.",
		},
		allClear: {
			type: "boolean",
			description:
				"Post a message when nothing is past its target. Default false: an empty report is not sent.",
		},
	},
	required: ["tool"],
	additionalProperties: false,
};

export const digestKey: KeyGroup<Digest> = {
	key: DIGEST,
	shippedDefault: DIGEST_OFF,
	decode,
	render: (value) => {
		if (value._tag === "Off") return null;
		const {_tag, ...settings} = value;
		return settings;
	},
	jsonSchema,
};
