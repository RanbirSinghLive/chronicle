import { App, TFile } from "obsidian";
import type {
  ChronicleSettings,
  ConflictRecord,
  EntityScanResult,
  ExtractedFact,
  RegistryEntry,
  ScanResult,
} from "../types";
import type { RegistryManager } from "../registry/RegistryManager";
import type { BibleManager } from "../bible/BibleManager";
import type { ConflictManager } from "../conflict/ConflictManager";
import { stripFrontmatter } from "../utils/vault";
import {
  ATTRIBUTE_NOUN_DICT,
  COMPLEXION_ADJECTIVES,
  buildEntityAlternation,
  buildLocationAlternation,
  buildLocationPatterns,
  normaliseStem,
  patternAppositive,
  patternCompoundAdj,
  patternNounIs,
  patternPossessive,
  patternVerbAttr,
  resolveNoun,
} from "./patterns";
import { LlmClient } from "./LlmClient";

/** Attribute categories owned by Tier 1 — Tier 2 will not overwrite these. */
const TIER1_ATTRS = new Set([
  ...Object.keys(ATTRIBUTE_NOUN_DICT),
  "complexion",
  "location",
]);

interface Paragraph {
  text: string;
  startLine: number; // 1-based, relative to original file
}

export class ExtractionEngine {
  private app: App;
  private settings: ChronicleSettings;
  private registry: RegistryManager;
  private bible: BibleManager;
  private conflictManager: ConflictManager;
  private llmClient: LlmClient;

  constructor(
    app: App,
    settings: ChronicleSettings,
    registry: RegistryManager,
    bible: BibleManager,
    conflictManager: ConflictManager
  ) {
    this.app = app;
    this.settings = settings;
    this.registry = registry;
    this.bible = bible;
    this.conflictManager = conflictManager;
    this.llmClient = new LlmClient(settings);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Scan a single scene file (called on-save). */
  async scanFile(file: TFile): Promise<ScanResult> {
    const start = Date.now();

    if (!this.isSceneFile(file)) {
      return { scannedPaths: [], entities: [], conflicts: [], durationMs: 0 };
    }

    const [content, entries] = await Promise.all([
      this.app.vault.read(file),
      this.registry.loadEntries(),
    ]);

    let factMap = this.extractFromContent(content, file.path, entries);
    factMap = await this.runTier2(factMap, content, file.path, entries);

    const entityResults = await this.applyFactMap(factMap, entries, file.path, null);

    const allConflicts: ConflictRecord[] = entityResults.flatMap((r) => r.conflicts);
    if (allConflicts.length > 0) {
      await this.conflictManager.mergeConflicts(allConflicts);
    }

    return {
      scannedPaths: [file.path],
      entities: entityResults.filter((r) => r.changes.length > 0 || r.conflicts.length > 0),
      conflicts: allConflicts,
      durationMs: Date.now() - start,
    };
  }

  /** Scan all scene files (called by full-scan command). */
  async fullScan(): Promise<ScanResult> {
    const start = Date.now();
    const entries = await this.registry.loadEntries();

    const allFiles = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isSceneFile(f))
      .sort((a, b) => a.stat.mtime - b.stat.mtime); // chronological order

    // Accumulate facts across all files
    // Physical attrs: first occurrence wins (earliest file by mtime)
    // Location: latest occurrence wins (overwrite each file)
    const globalAttrs = new Map<string, Map<string, ExtractedFact>>();
    const globalAppearances = new Map<string, Set<string>>();

    for (const file of allFiles) {
      const content = await this.app.vault.read(file);
      let factMap = this.extractFromContent(content, file.path, entries);
      factMap = await this.runTier2(factMap, content, file.path, entries);

      for (const [entityName, facts] of factMap) {
        if (!globalAttrs.has(entityName)) {
          globalAttrs.set(entityName, new Map());
        }
        if (!globalAppearances.has(entityName)) {
          globalAppearances.set(entityName, new Set());
        }

        globalAppearances.get(entityName)!.add(file.path);
        const attrMap = globalAttrs.get(entityName)!;

        for (const fact of facts) {
          if (fact.attribute === "location") {
            // Latest wins for location
            attrMap.set("location", fact);
          } else {
            // First occurrence wins for physical attributes
            if (!attrMap.has(fact.attribute)) {
              attrMap.set(fact.attribute, fact);
            }
          }
        }
      }
    }

    // Apply accumulated facts to bible notes
    const allEntityResults: EntityScanResult[] = [];
    const allConflicts: ConflictRecord[] = [];

    for (const [entityName, attrMap] of globalAttrs) {
      const entry = entries.find((e) => e.name === entityName);
      if (!entry) continue;

      const facts = Array.from(attrMap.values());
      const appearances = Array.from(globalAppearances.get(entityName) ?? []);
      const { changes, conflicts } = await this.bible.updateBibleNote(entry, facts, null, appearances);

      allConflicts.push(...conflicts);
      allEntityResults.push({ entityName, changes, conflicts, appearances });
    }

    if (allConflicts.length > 0) {
      await this.conflictManager.mergeConflicts(allConflicts);
    }

    return {
      scannedPaths: allFiles.map((f) => f.path),
      entities: allEntityResults.filter((r) => r.changes.length > 0 || r.conflicts.length > 0),
      conflicts: allConflicts,
      durationMs: Date.now() - start,
    };
  }

  // ── Private: scene file filtering ──────────────────────────────────────────

  private isSceneFile(file: TFile): boolean {
    if (file.extension !== "md") return false;

    // Never scan Chronicle's own generated files
    const biblePath = this.settings.bibleFolderPath.replace(/\/$/, "");
    if (file.path.startsWith(biblePath + "/")) return false;
    if (file.path === this.settings.registryPath) return false;

    // Also exclude anything in the registry's parent folder (_chronicle/)
    const registryDir = this.settings.registryPath.substring(
      0, this.settings.registryPath.lastIndexOf("/")
    );
    if (registryDir && file.path.startsWith(registryDir + "/")) return false;

    // If no scene folders configured, all markdown files are candidates
    if (this.settings.sceneFolders.length === 0) return true;

    return this.settings.sceneFolders.some((folder) => {
      const normalised = folder.replace(/\/$/, "");
      return file.path.startsWith(normalised + "/");
    });
  }

  // ── Private: paragraph splitting ───────────────────────────────────────────

  private splitIntoParagraphs(content: string): Paragraph[] {
    const body = stripFrontmatter(content);
    const lines = body.split("\n");

    // Compute line offset from stripping frontmatter
    const totalLines = content.split("\n").length;
    const bodyLines = lines.length;
    const frontmatterOffset = totalLines - bodyLines;

    const paragraphs: Paragraph[] = [];
    let current: string[] = [];
    let currentStart = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip Chronicle marker lines, headings (they're not prose)
      if (trimmed.startsWith("<!--") || trimmed.startsWith("-->") || trimmed.startsWith("#")) {
        if (current.length > 0) {
          paragraphs.push({
            text: current.join("\n"),
            startLine: currentStart + frontmatterOffset,
          });
          current = [];
        }
        currentStart = i + 2;
        continue;
      }

      if (trimmed === "") {
        if (current.length > 0) {
          paragraphs.push({
            text: current.join("\n"),
            startLine: currentStart + frontmatterOffset,
          });
          current = [];
        }
        currentStart = i + 2;
      } else {
        if (current.length === 0) currentStart = i + 1;
        current.push(line);
      }
    }

    if (current.length > 0) {
      paragraphs.push({
        text: current.join("\n"),
        startLine: currentStart + frontmatterOffset,
      });
    }

    return paragraphs;
  }

  // ── Private: extraction core ────────────────────────────────────────────────

  private extractFromContent(
    content: string,
    filePath: string,
    entries: RegistryEntry[]
  ): Map<string, ExtractedFact[]> {
    const factMap = new Map<string, ExtractedFact[]>();
    const paragraphs = this.splitIntoParagraphs(content);
    const locationEntries = entries.filter((e) => e.type === "location" && !e.excluded);
    const characterEntries = entries.filter((e) => e.type === "character" && !e.excluded);

    console.log(`Chronicle extract [${filePath}]: paragraphs=${paragraphs.length} characters=${characterEntries.map(e=>e.name).join(",")}`);

    for (const entry of characterEntries) {
      const terms = [entry.name, ...entry.aliases].map((t) => t.toLowerCase());
      const visited = new Set<number>();
      const facts: ExtractedFact[] = [];

      for (let idx = 0; idx < paragraphs.length; idx++) {
        if (visited.has(idx)) continue;

        const paraLower = paragraphs[idx].text.toLowerCase();
        const mentioned = terms.some((t) => paraLower.includes(t));
        if (!mentioned) continue;

        console.log(`Chronicle extract [${entry.name}]: mention in para ${idx}: "${paragraphs[idx].text.slice(0,60)}..."`);

        // Compute extraction window
        const wStart = Math.max(0, idx - this.settings.extractionWindow);
        const wEnd = Math.min(paragraphs.length - 1, idx + this.settings.extractionWindow);

        // Mark all paragraphs in this window as visited
        for (let j = wStart; j <= wEnd; j++) visited.add(j);

        const windowText = paragraphs
          .slice(wStart, wEnd + 1)
          .map((p) => p.text)
          .join("\n\n");
        const windowStartLine = paragraphs[wStart].startLine;

        const attrFacts = this.extractPhysicalAttributes(
          windowText, windowStartLine, entry, filePath
        );
        const locFacts = this.extractLocations(
          windowText, windowStartLine, entry, locationEntries, filePath
        );

        console.log(`Chronicle extract [${entry.name}]: attrFacts=${attrFacts.map(f=>`${f.attribute}:${f.value}`).join(",") || "none"}`);
        facts.push(...attrFacts, ...locFacts);
      }

      if (facts.length > 0) {
        factMap.set(entry.name, facts);
      } else if (paragraphs.some((p) =>
        [entry.name, ...entry.aliases].some((t) => p.text.toLowerCase().includes(t.toLowerCase()))
      )) {
        // Entity appeared but no facts extracted — still record appearance
        factMap.set(entry.name, []);
      }
    }

    return factMap;
  }

  private extractPhysicalAttributes(
    windowText: string,
    windowStartLine: number,
    entry: RegistryEntry,
    filePath: string
  ): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const entityAlt = buildEntityAlternation(entry);
    const now = new Date().toISOString();
    const seenAttributes = new Set<string>();

    const addFact = (attribute: string, value: string, match: RegExpExecArray | RegExpMatchArray) => {
      if (seenAttributes.has(attribute)) return; // priority: first pattern wins
      seenAttributes.add(attribute);
      facts.push({
        attribute,
        value: value.trim(),
        sourceScene: filePath,
        sourceLine: this.computeLineNumber(windowText, match.index ?? 0, windowStartLine),
        sourceQuote: this.truncateToSourceQuote(match[0]),
        extractedBy: "tier1",
        extractedAt: now,
      });
    };

    /**
     * The possessive/verb patterns greedily absorb the noun into group 1 when
     * the sentence continues after it (e.g. "Elena's copper hair caught the
     * light" → g1="copper hair", g2="caught"). If g2 isn't a known noun, fall
     * back to treating the last word of g1 as the noun instead.
     */
    const resolveGroups = (
      g1: string,
      g2: string
    ): { category: string; adj: string } | null => {
      const cat = resolveNoun(g2);
      if (cat) return { category: cat, adj: g1 };

      const words = g1.split(/\s+/);
      if (words.length > 1) {
        const lastWord = words[words.length - 1];
        const fallback = resolveNoun(lastWord);
        if (fallback) return { category: fallback, adj: words.slice(0, -1).join(" ") };
      }
      return null;
    };

    // Priority 1: Noun-is — "Elena's hair was copper"  (most explicit: names the noun directly)
    const nounIsRe = patternNounIs(entityAlt);
    for (const match of windowText.matchAll(nounIsRe)) {
      const noun  = match[1]?.trim() ?? "";
      const value = match[2]?.trim() ?? "";
      const category = resolveNoun(noun);
      if (category && value) addFact(category, value, match);
    }

    // Priority 2: Possessive — "Elena's copper hair"
    const possRe = patternPossessive(entityAlt);
    for (const match of windowText.matchAll(possRe)) {
      const g1 = match[1]?.trim() ?? "";
      const g2 = match[2]?.trim() ?? "";
      const resolved = resolveGroups(g1, g2);
      if (resolved) addFact(resolved.category, resolved.adj, match);
    }

    // Priority 3: Verb — "Elena had copper hair"
    const verbRe = patternVerbAttr(entityAlt);
    for (const match of windowText.matchAll(verbRe)) {
      const g1 = match[1]?.trim() ?? "";
      const g2 = match[2]?.trim() ?? "";
      const resolved = resolveGroups(g1, g2);
      if (resolved) addFact(resolved.category, resolved.adj, match);
    }

    // Priority 4: Compound adjective — "copper-haired Elena"
    const compRe = patternCompoundAdj(entityAlt);
    for (const match of windowText.matchAll(compRe)) {
      const adjValue = match[1]?.trim() ?? "";
      const stem = normaliseStem(match[2] ?? "");
      const category = resolveNoun(stem);
      if (category) addFact(category, adjValue, match);
    }

    // Priority 5: Appositive — "Elena, pale and tired,"
    const appRe = patternAppositive(entityAlt);
    for (const match of windowText.matchAll(appRe)) {
      const clause = match[1]?.trim() ?? "";
      const tokens = clause.toLowerCase().split(/\W+/);
      for (const token of tokens) {
        if (COMPLEXION_ADJECTIVES.includes(token)) {
          addFact("complexion", token, match);
          break; // one complexion per appositive
        }
      }
    }

    return facts;
  }

  private extractLocations(
    windowText: string,
    windowStartLine: number,
    entry: RegistryEntry,
    locationEntries: RegistryEntry[],
    filePath: string
  ): ExtractedFact[] {
    if (locationEntries.length === 0) return [];

    const facts: ExtractedFact[] = [];
    const characterAlt = buildEntityAlternation(entry);
    const locationAlt = buildLocationAlternation(locationEntries);
    const patterns = buildLocationPatterns(characterAlt, locationAlt);
    const now = new Date().toISOString();

    for (const { pattern, left } of patterns) {
      for (const match of windowText.matchAll(pattern)) {
        const characterToken = match[1] ?? "";
        const locationToken = match[2] ?? "";

        // Verify character token belongs to this entry
        const resolvedChar = this.resolveAlias(characterToken, [entry]);
        if (!resolvedChar) continue;

        const canonicalLocation = this.resolveAlias(locationToken, locationEntries);
        if (!canonicalLocation && !left) continue; // unregistered location, skip

        facts.push({
          attribute: "location",
          value: left ? "" : (canonicalLocation ?? locationToken),
          sourceScene: filePath,
          sourceLine: this.computeLineNumber(windowText, match.index ?? 0, windowStartLine),
          sourceQuote: this.truncateToSourceQuote(match[0]),
          extractedBy: "tier1",
          extractedAt: now,
        });
      }
    }

    // For location, use only the last extracted fact per scan window
    // (latest position statement wins)
    const locationFacts = facts.filter((f) => f.attribute === "location");
    return locationFacts.length > 0 ? [locationFacts[locationFacts.length - 1]] : [];
  }

  // ── Private: alias resolution ───────────────────────────────────────────────

  private resolveAlias(token: string, entries: RegistryEntry[]): string | null {
    const normalise = (s: string) => {
      const lower = s.toLowerCase().trim();
      return lower.startsWith("the ") ? lower.slice(4) : lower;
    };

    const normToken = normalise(token);

    for (const entry of entries) {
      if (normalise(entry.name) === normToken) return entry.name;
      for (const alias of entry.aliases) {
        if (normalise(alias) === normToken) return entry.name;
      }
    }
    return null;
  }

  // ── Private: utilities ──────────────────────────────────────────────────────

  private truncateToSourceQuote(passage: string): string {
    const words = passage.trim().split(/\s+/);
    if (words.length <= 30) return passage.trim();
    return words.slice(0, 30).join(" ") + "…";
  }

  private computeLineNumber(
    windowText: string,
    matchIndex: number,
    windowStartLine: number
  ): number {
    const textBefore = windowText.slice(0, matchIndex);
    const newlinesBefore = (textBefore.match(/\n/g) ?? []).length;
    return windowStartLine + newlinesBefore;
  }

  // ── Private: Tier 2 LLM integration ─────────────────────────────────────────

  /**
   * If LLM extraction is enabled, call the LLM for entities that opt in,
   * then merge Tier 2 facts into the existing Tier 1 fact map.
   * Never overwrites Tier 1 facts for attributes Tier 1 already covers.
   */
  private async runTier2(
    tier1Map: Map<string, ExtractedFact[]>,
    content: string,
    filePath: string,
    entries: RegistryEntry[]
  ): Promise<Map<string, ExtractedFact[]>> {
    if (!this.settings.llmEnabled) return tier1Map;

    // Only characters that have not explicitly opted out
    const llmEntities = entries.filter(
      (e) => e.type === "character" && !e.excluded && e.llmOptIn !== false
    );
    if (llmEntities.length === 0) return tier1Map;

    try {
      const body = stripFrontmatter(content);
      const tier2 = await this.llmClient.extract(body, llmEntities);
      return this.mergeTier2(tier1Map, tier2, filePath);
    } catch (err) {
      console.error("Chronicle: Tier 2 LLM extraction failed", err);
      return tier1Map;
    }
  }

  /**
   * Merge Tier 2 facts into the Tier 1 fact map.
   * Tier 1 wins for its own attribute categories (TIER1_ATTRS).
   * New attributes from Tier 2 are appended as ExtractedFact with extractedBy: "tier2".
   */
  private mergeTier2(
    tier1Map: Map<string, ExtractedFact[]>,
    tier2: Record<string, Record<string, { value: string; quote: string }>>,
    filePath: string
  ): Map<string, ExtractedFact[]> {
    const now = new Date().toISOString();

    for (const [entityName, attrs] of Object.entries(tier2)) {
      if (!tier1Map.has(entityName)) {
        tier1Map.set(entityName, []);
      }
      const existing = tier1Map.get(entityName)!;
      const existingAttrs = new Set(existing.map((f) => f.attribute));

      for (const [attr, { value, quote }] of Object.entries(attrs)) {
        // Skip if Tier 1 already found something for this attribute category
        if (TIER1_ATTRS.has(attr) && existingAttrs.has(attr)) continue;
        // Skip if already present (even from a prior Tier 2 run)
        if (existingAttrs.has(attr)) continue;

        existingAttrs.add(attr);
        existing.push({
          attribute: attr,
          value: value.trim(),
          sourceScene: filePath,
          sourceLine: 0,  // LLM extraction doesn't resolve line numbers
          sourceQuote: quote.trim().split(/\s+/).slice(0, 30).join(" "),
          extractedBy: "tier2",
          extractedAt: now,
        });
      }
    }

    return tier1Map;
  }

  // ── Private: fact application ───────────────────────────────────────────────

  private async applyFactMap(
    factMap: Map<string, ExtractedFact[]>,
    entries: RegistryEntry[],
    sceneFile: string | null,
    appearances: string[] | null
  ): Promise<EntityScanResult[]> {
    const results: EntityScanResult[] = [];

    for (const [entityName, facts] of factMap) {
      const entry = entries.find((e) => e.name === entityName);
      if (!entry) continue;

      const { changes, conflicts } = await this.bible.updateBibleNote(
        entry,
        facts,
        sceneFile,
        appearances ?? undefined
      );

      results.push({
        entityName,
        changes,
        conflicts,
        appearances: sceneFile ? [sceneFile] : [],
      });
    }

    return results;
  }
}
