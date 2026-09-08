/** Reserved carrier on the strict 0.84.3 wire; see .patterns/owned-wire-vocabulary.md. */
export const compactionId = (position: number): string => `item-${position}:compaction`;

export const isCompactionId = (id: string): boolean => /^item-\d+:compaction$/.test(id);
