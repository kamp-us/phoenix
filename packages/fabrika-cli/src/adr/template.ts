/**
 * `adr new`'s canonical template, rendered pure.
 *
 * The contract holds the template's single home; this is that text with the five frontmatter
 * substitutions applied. The `<…>` prompts in the body stay — they are the author's slots, and the
 * skill's judgment is what fills them. Two terminal sections are deliberately NOT scaffolded
 * (`## Records`, `## Amendments`): an empty one invites filler, so the skill adds them when it has
 * content for them.
 */

export interface ScaffoldInput {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly status: string;
	readonly date: string;
	readonly tags: ReadonlyArray<string>;
}

/** The default `title:` when `--title` is absent: the slug, de-hyphenated. */
export const titleFromSlug = (slug: string): string => slug.split("-").join(" ");

/** Split a `--tags` value on commas, dropping empty entries. */
export const parseTags = (raw: string): ReadonlyArray<string> =>
	raw
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

/** The record's filename under `--dir`. */
export const recordFilename = (id: string, slug: string): string => `${id}-${slug}.md`;

/** The bytes `adr new` writes. */
export const renderTemplate = ({id, title, status, date, tags}: ScaffoldInput): string =>
	`---
id: ${id}
title: ${title}
status: ${status}
date: ${date}
tags: [${tags.join(", ")}]
---

# ${id} — ${title}

**What this decides:** <one plain sentence a non-author parses cold.>

## Context

<Why this came up — situation, constraint, prior pain. Name any ADR this supersedes or amends.>

## Decision

**<One bolded declarative sentence.>**

<Then the mechanics, declarative. No hedging.>

## Consequences

<What this makes easier / harder. Any migration cost.>
`;
