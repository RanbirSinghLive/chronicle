// ─── Entity Types ─────────────────────────────────────────────────────────────

export type EntityType = "character" | "location" | "object" | "faction";

export interface RegistryEntry {
  name: string;
  aliases: string[];
  type: EntityType;
  sceneFolder?: string;  // restrict extraction to a specific folder
  excluded?: boolean;    // exclude from extraction entirely
}

// ─── Fact and Conflict Types ──────────────────────────────────────────────────
// Defined here for completeness; used starting in Milestone 2.

export interface ExtractedFact {
  attribute: string;       // e.g. "hair", "eyes", "location"
  value: string;           // e.g. "copper", "hazel", "The Vault"
  sourceScene: string;     // vault-relative path
  sourceLine: number;
  sourceQuote: string;     // verbatim passage ≤ 30 words
  extractedBy: "tier1" | "tier2" | "manual";
  extractedAt: string;     // ISO 8601 timestamp
}

export interface ConflictRecord {
  type: "hard" | "soft";
  entity: string;
  attribute: string;
  priorValue: string;
  priorScene: string;
  newValue: string;
  newScene: string;
  newLine: number;
  status: "active" | "dismissed";
  dismissalNote?: string;
  dismissedAt?: string;
}

/** Stored in a bible note's `dismissed-conflicts:` frontmatter list. */
export interface DismissedConflict {
  attribute: string;
  value: string;    // the new value that was dismissed
  scene: string;    // the scene where the conflict appeared
  note?: string;
  dismissedAt: string; // ISO date string YYYY-MM-DD
}

export interface SceneTemporalRecord {
  scenePath: string;
  anchor?: string;           // manually set anchor string
  markers: TemporalMarker[];
  resolvedPosition?: number; // story-time ordinal, undefined if unresolved
}

export interface TemporalMarker {
  type: "relative_forward" | "relative_backward" | "absolute" | "same_day";
  text: string;
  line: number;
}

// ─── Plugin Settings ───────────────────────────────────────────────────────────

export type LlmProvider = "anthropic" | "openai" | "ollama";

export interface ChronicleSettings {
  bibleFolderPath: string;
  registryPath: string;
  sceneFolders: string[];        // empty = all folders
  scanOnSave: boolean;
  extractionWindow: number;      // paragraphs around mention to scan, default 1
  absenceWarningThreshold: number; // scenes without appearance before flag, default 5
  llmEnabled: boolean;
  llmProvider: LlmProvider;
  llmApiKey: string;
  ollamaEndpoint: string;
  compileIntegration: boolean;
  conflictGutter: boolean;
  hardConflictColour: string;
  softConflictColour: string;
}

export const DEFAULT_SETTINGS: ChronicleSettings = {
  bibleFolderPath: "_chronicle/bible",
  registryPath: "_chronicle/registry.md",
  sceneFolders: [],
  scanOnSave: true,
  extractionWindow: 1,
  absenceWarningThreshold: 5,
  llmEnabled: false,
  llmProvider: "anthropic",
  llmApiKey: "",
  ollamaEndpoint: "http://localhost:11434",
  compileIntegration: true,
  conflictGutter: true,
  hardConflictColour: "red",
  softConflictColour: "yellow",
};

// ─── Scan Results (Milestone 2) ───────────────────────────────────────────────

export interface AttributeChange {
  attribute: string;
  oldValue: string | null;   // null = first extraction
  newValue: string | null;   // null = location cleared ("left" pattern)
  sourceQuote: string;
  sourceLine: number;
}

export interface EntityScanResult {
  entityName: string;
  changes: AttributeChange[];
  appearances: string[];        // scene paths where entity was found
  conflicts: ConflictRecord[];  // new conflicts detected this scan
}

export interface ScanResult {
  scannedPaths: string[];
  entities: EntityScanResult[];  // entities with changes OR conflicts
  conflicts: ConflictRecord[];   // all new conflicts (for gutter dispatch)
  durationMs: number;
}

// ─── Presence Matrix (Milestone 4) ────────────────────────────────────────────

/** How a character is present in a given scene. */
export type CellPresence = "active" | "mentioned" | "pov" | "absent";

export interface PresenceCell {
  presence: CellPresence;
  location?: string;  // extracted last-known location in that scene (for tooltip)
}

export interface SceneRow {
  scenePath: string;
  sceneLabel: string;  // basename without extension
  cells: Record<string, PresenceCell>;  // keyed by character name
}

export interface PresenceMatrix {
  characters: string[];   // ordered list of character names
  scenes: SceneRow[];     // ordered list of scene rows
}

// ─── Bible Note Frontmatter ────────────────────────────────────────────────────
// Mirrors the structure Chronicle writes into bible note YAML frontmatter.

export interface BibleNoteFrontmatter {
  "chronicle-type": EntityType;
  "chronicle-managed": true;
  "chronicle-version": number;
  attributes: Record<string, string>;
  "manual-overrides": Record<string, string>;
  aliases: string[];
}
