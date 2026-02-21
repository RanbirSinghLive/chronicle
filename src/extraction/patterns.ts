/**
 * Chronicle Tier 1 extraction patterns and attribute dictionary.
 * Pure module — no Obsidian imports. All functions are stateless.
 */

import type { RegistryEntry } from "../types";

// ─── Attribute dictionary ──────────────────────────────────────────────────────

/**
 * Maps attribute category names to noun headwords that signal them.
 * Matching checks whether the found noun starts with any entry (handles plurals).
 */
export const ATTRIBUTE_NOUN_DICT: Record<string, string[]> = {
  hair: [
    "hair", "locks", "mane", "braid", "braids", "curl", "curls",
    "tress", "tresses", "strand", "strands",
  ],
  eyes: ["eye", "eyes", "gaze", "stare", "irises", "iris"],
  height: ["height", "stature"],
  build: ["build", "frame", "figure", "physique", "body", "shoulders"],
  age: ["age", "years"],
  voice: ["voice", "tone", "timbre", "accent"],
};

/**
 * Adjectives that map to "complexion" when found in an appositive construction.
 * e.g. "Elena, pale and tired," → complexion: pale
 */
export const COMPLEXION_ADJECTIVES: string[] = [
  "pale", "pallid", "ashen", "sallow", "ruddy", "flushed",
  "tanned", "dark", "fair", "olive", "freckled",
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Escape a string for literal use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex alternation for all names and aliases of one entity.
 * Sorted longest-first to prevent prefix shadowing.
 * e.g. "(?:Elena|Ellie|the Archivist)"
 */
export function buildEntityAlternation(entry: RegistryEntry): string {
  const names = [entry.name, ...entry.aliases]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  return `(?:${names.join("|")})`;
}

/**
 * Build a regex alternation for all location entries (all names + aliases).
 * Sorted longest-first.
 */
export function buildLocationAlternation(locationEntries: RegistryEntry[]): string {
  const names: string[] = [];
  for (const loc of locationEntries) {
    names.push(loc.name, ...loc.aliases);
  }
  if (names.length === 0) return "(?:__no_locations__)";
  names.sort((a, b) => b.length - a.length);
  return `(?:${names.map(escapeRegex).join("|")})`;
}

/**
 * Look up a noun in ATTRIBUTE_NOUN_DICT.
 * Returns the attribute category if the noun starts with any dictionary entry,
 * or null if no match.
 */
export function resolveNoun(noun: string): string | null {
  const lower = noun.toLowerCase();
  for (const [category, nouns] of Object.entries(ATTRIBUTE_NOUN_DICT)) {
    if (nouns.some((n) => lower === n || lower.startsWith(n))) {
      return category;
    }
  }
  return null;
}

/**
 * Normalise a compound-adjective stem by stripping common suffixes,
 * so "haired" → "hair", "eyed" → "eye".
 */
export function normaliseStem(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/red$/, "")   // "auburn-red" edge case
    .replace(/ed$/, "")    // "haired" → "hair", "eyed" → "eye"
    .replace(/en$/, "");   // e.g. "golden" would leave "gold" — acceptable
}

// ─── Physical attribute patterns ───────────────────────────────────────────────

const ATTR_VERBS =
  "had|has|have|wore|wears|sport(?:ed|s)?|bor(?:e|ed)|boast(?:ed|s)?|" +
  "possess(?:ed|es)?|reveal(?:ed|s)?|show(?:ed|n|s)?|display(?:ed|s)?";

/**
 * Pattern 1: compound adjective before entity name.
 * Matches: "copper-haired Elena", "blue-eyed Marcus"
 * Group 1: adjective value ("copper")
 * Group 2: noun stem ("haired")
 */
export function patternCompoundAdj(entityAlt: string): RegExp {
  return new RegExp(
    `(\\w[\\w ]{0,20}?)-(\\w+(?:ed|en|red))\\s+${entityAlt}`,
    "gi"
  );
}

/**
 * Pattern 1b: possessive noun + be-verb + value.
 * Matches: "Elena's hair was copper", "Marcus's eyes are blue"
 * Group 1: noun ("hair")
 * Group 2: value phrase ("copper" or "dark copper")
 *
 * Highest priority because it names the attribute noun explicitly.
 */
const ATTR_BE_VERBS = "is|are|was|were|became|become|turned|remained|stay(?:ed|s)?";

export function patternNounIs(entityAlt: string): RegExp {
  return new RegExp(
    `${entityAlt}'s\\s+(\\w+)\\s+(?:${ATTR_BE_VERBS})\\s+([\\w-]+(?:\\s+[\\w-]+)?)`,
    "gi"
  );
}

/**
 * Pattern 2: possessive + adjective + noun.
 * Matches: "Elena's copper hair", "Marcus's blue eyes"
 * Group 1: adjective phrase ("copper" or "dark copper")
 * Group 2: noun ("hair")
 */
export function patternPossessive(entityAlt: string): RegExp {
  return new RegExp(
    `${entityAlt}'s\\s+([\\w-]+(?:\\s+[\\w-]+)?)\\s+(\\w+)`,
    "gi"
  );
}

/**
 * Pattern 3: subject + verb + adjective + noun.
 * Matches: "Elena had copper hair", "Marcus wore a dark cloak"
 * Group 1: adjective phrase
 * Group 2: noun
 */
export function patternVerbAttr(entityAlt: string): RegExp {
  return new RegExp(
    `${entityAlt}\\s+(?:${ATTR_VERBS})\\s+(?:a\\s+|an\\s+|the\\s+)?` +
    `([\\w-]+(?:\\s+[\\w-]+)?)\\s+(\\w+)`,
    "gi"
  );
}

/**
 * Pattern 4: appositive clause after entity name.
 * Matches: "Elena, pale and tired," → clause: "pale and tired"
 * Group 1: clause text
 */
export function patternAppositive(entityAlt: string): RegExp {
  return new RegExp(
    `${entityAlt},\\s+([^,.(]{3,60}?)(?:,|\\.)`,
    "gi"
  );
}

// ─── Location patterns ─────────────────────────────────────────────────────────

export interface LocationPatternDef {
  pattern: RegExp;
  left: boolean;   // true = entity left (clears location)
}

/**
 * Build all four location movement patterns for a character+location pair.
 * Group 1: character name/alias token
 * Group 2: location name/alias token
 */
export function buildLocationPatterns(
  characterAlt: string,
  locationAlt: string
): LocationPatternDef[] {
  return [
    // "Elena entered the Vault"
    {
      pattern: new RegExp(
        `(${characterAlt})\\s+(?:entered|stepped into|walked into|came into|moved into)\\s+(?:the\\s+)?(${locationAlt})`,
        "gi"
      ),
      left: false,
    },
    // "Marcus arrived at the Vault"
    {
      pattern: new RegExp(
        `(${characterAlt})\\s+(?:arrived at|arrived in|reached|came to)\\s+(?:the\\s+)?(${locationAlt})`,
        "gi"
      ),
      left: false,
    },
    // "Elena was in the Archive"
    {
      pattern: new RegExp(
        `(${characterAlt})\\s+(?:was|were|stood|sat|remained|waited|stayed)\\s+` +
        `(?:in|at|inside|within)\\s+(?:the\\s+)?(${locationAlt})`,
        "gi"
      ),
      left: false,
    },
    // "Elena left the Vault"
    {
      pattern: new RegExp(
        `(${characterAlt})\\s+(?:left|departed|exited|fled|escaped from|slipped out of|rushed out of)\\s+(?:the\\s+)?(${locationAlt})`,
        "gi"
      ),
      left: true,
    },
  ];
}
