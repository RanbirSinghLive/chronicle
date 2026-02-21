import { App, TFile, parseYaml } from "obsidian";
import type {
  AttributeChange,
  ChronicleSettings,
  ConflictRecord,
  DismissedConflict,
  EntityType,
  ExtractedFact,
  RegistryEntry,
} from "../types";
import { ensureFolderExists } from "../utils/vault";

// ── Private table row types ───────────────────────────────────────────────────

interface AttributeTableRow {
  attribute: string;      // lowercase category name
  value: string;
  firstMentioned: string; // scene path
  source: string;         // source quote
}

interface AppearanceRow {
  scene: string;
  role: string;
  chapter: string;
}

// ── BibleManager ─────────────────────────────────────────────────────────────

export class BibleManager {
  private app: App;
  private settings: ChronicleSettings;

  // Serialise concurrent writes to the same bible note.
  // Key: bible note path. Value: latest pending operation promise.
  private updateQueue = new Map<string, Promise<void>>();

  constructor(app: App, settings: ChronicleSettings) {
    this.app = app;
    this.settings = settings;
  }

  // ── Public: note creation ─────────────────────────────────────────────────

  /**
   * Create a bible note for a single registry entry.
   * Returns true if created, false if a note already existed.
   */
  async createBibleNote(entry: RegistryEntry): Promise<boolean> {
    const path = this.bibleNotePath(entry.name);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return false;

    await ensureFolderExists(this.app, this.settings.bibleFolderPath);
    const content = this.generateNoteContent(entry);
    await this.app.vault.create(path, content);
    return true;
  }

  /**
   * Create bible notes for all entries that don't already have one.
   * Returns counts of notes created and skipped.
   */
  async createAllBibleNotes(
    entries: RegistryEntry[]
  ): Promise<{ created: number; skipped: number }> {
    await ensureFolderExists(this.app, this.settings.bibleFolderPath);
    let created = 0;
    let skipped = 0;

    for (const entry of entries) {
      const wasCreated = await this.createBibleNote(entry);
      if (wasCreated) created++;
      else skipped++;
    }

    return { created, skipped };
  }

  /** Returns true if a bible note already exists for this entry. */
  async bibleNoteExists(entry: RegistryEntry): Promise<boolean> {
    const path = this.bibleNotePath(entry.name);
    return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  /**
   * Compute the vault-relative path for an entity's bible note.
   * Public so main.ts can open the file after creation.
   */
  bibleNotePath(entryName: string): string {
    return `${this.settings.bibleFolderPath}/${this.sanitiseFilename(entryName)}.md`;
  }

  // ── Public: extraction update ─────────────────────────────────────────────

  /**
   * Update a bible note with newly extracted facts.
   * Creates the note if it doesn't exist yet.
   * Uses an update queue to serialise concurrent writes to the same file.
   *
   * @param entry       Registry entry for this entity
   * @param facts       Extracted facts from the current scan
   * @param sceneFile   Scene path for appearance tracking (null during full scan)
   * @param appearances Explicit scene paths for appearances (used in full scan)
   * @returns  Changes applied and any new conflicts detected
   */
  async updateBibleNote(
    entry: RegistryEntry,
    facts: ExtractedFact[],
    sceneFile: string | null,
    appearances?: string[]
  ): Promise<{ changes: AttributeChange[]; conflicts: ConflictRecord[] }> {
    const path = this.bibleNotePath(entry.name);
    let changes: AttributeChange[] = [];
    let conflicts: ConflictRecord[] = [];

    const prior = this.updateQueue.get(path) ?? Promise.resolve();
    const next = prior.then(async () => {
      ({ changes, conflicts } = await this.doUpdate(entry, facts, sceneFile, appearances));
    });

    this.updateQueue.set(path, next.catch(() => {}));
    await next;
    return { changes, conflicts };
  }

  // ── Public: conflict helpers ──────────────────────────────────────────────

  /**
   * Append a dismissed-conflict record to the bible note's frontmatter so
   * subsequent scans don't re-surface the same conflict.
   */
  /**
   * Return the scene paths stored in the Appearances table of a bible note.
   * Used by the Presence Matrix analyser.
   */
  async getSceneAppearances(entry: RegistryEntry): Promise<string[]> {
    const path = this.bibleNotePath(entry.name);
    const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return [];
    const content = await this.app.vault.read(file);
    const section = this.parseManagedSection(content);
    if (!section) return [];
    const rows = this.parseAppearanceTable(section);
    return rows.map((r) => r.scene);
  }

  async addDismissedConflict(
    entityName: string,
    dismissed: DismissedConflict
  ): Promise<void> {
    const path = this.bibleNotePath(entityName);
    const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return;

    const prior = this.updateQueue.get(path) ?? Promise.resolve();
    const next = prior.then(async () => {
      const content = await this.app.vault.read(file);
      const updated = this.appendDismissedConflictToFrontmatter(content, dismissed);
      await this.app.vault.modify(file, updated);
    });
    this.updateQueue.set(path, next.catch(() => {}));
    await next;
  }

  /**
   * Force-update a single attribute in the bible note, bypassing the normal
   * conflict check. Used by ConflictManager.updateBible() after the user
   * explicitly accepts the new value.
   */
  async forceUpdateAttribute(
    entityName: string,
    attribute: string,
    value: string,
    scene: string
  ): Promise<void> {
    const path = this.bibleNotePath(entityName);
    const file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) return;

    const prior = this.updateQueue.get(path) ?? Promise.resolve();
    const next = prior.then(async () => {
      const content = await this.app.vault.read(file);
      const section = this.parseManagedSection(content);
      const attrRows = section ? this.parseAttributeTable(section) : [];
      const appRows  = section ? this.parseAppearanceTable(section) : [];
      const location = section ? this.parseLocation(section) : null;
      const frontmatter = this.parseFrontmatterFromContent(content);
      const manualOverrides: Record<string, string> =
        (frontmatter["manual-overrides"] as Record<string, string>) ?? {};

      const existing = attrRows.find((r) => r.attribute === attribute);
      if (existing) {
        existing.value  = value;
        existing.source = `(accepted from ${scene})`;
      } else {
        attrRows.push({ attribute, value, firstMentioned: scene, source: `(accepted from ${scene})` });
      }

      // If the accepted attribute had a manual override, remove it so the new
      // value is authoritative and future scans don't re-trigger the conflict.
      const updatedOverrides = { ...manualOverrides };
      delete updatedOverrides[attribute];

      const newSection = this.regenerateManagedSection(
        (frontmatter["chronicle-type"] as EntityType) ?? "character",
        attrRows,
        updatedOverrides,
        appRows,
        location
      );

      const newAttributes: Record<string, string> = {};
      for (const row of attrRows) {
        newAttributes[row.attribute] =
          row.attribute in updatedOverrides ? updatedOverrides[row.attribute] : row.value;
      }
      if (location) newAttributes["location"] = location;

      let updated = this.replaceManagedSection(content, newSection);
      updated = this.updateFrontmatterAttributes(updated, newAttributes);
      updated = this.updateManualOverrides(updated, updatedOverrides);
      await this.app.vault.modify(file, updated);
    });
    this.updateQueue.set(path, next.catch(() => {}));
    await next;
  }

  // ── Private: frontmatter parsing ─────────────────────────────────────────

  /**
   * Parse the YAML frontmatter block directly from file content.
   * More reliable than metadataCache.getFileCache() for files that were
   * recently modified, since the cache updates asynchronously.
   */
  private parseFrontmatterFromContent(content: string): Record<string, unknown> {
    if (!content.startsWith("---")) return {};
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return {};
    const yamlBlock = content.slice(4, endIdx); // skip opening "---\n"
    try {
      return (parseYaml(yamlBlock) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  // ── Public: section parsing (used by ExtractionEngine) ───────────────────

  parseManagedSection(content: string): string | null {
    const START = "<!-- chronicle:start -->";
    const END = "<!-- chronicle:end -->";
    const startIdx = content.indexOf(START);
    const endIdx = content.indexOf(END);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
    return content.slice(startIdx + START.length, endIdx);
  }

  replaceManagedSection(content: string, newSection: string): string {
    const START = "<!-- chronicle:start -->";
    const END = "<!-- chronicle:end -->";
    const startIdx = content.indexOf(START);
    const endIdx = content.indexOf(END);

    if (startIdx === -1 || endIdx === -1) {
      // Markers missing — append at end
      return content.trimEnd() + "\n\n" + START + "\n" + newSection + "\n" + END + "\n";
    }

    return (
      content.slice(0, startIdx + START.length) +
      "\n" +
      newSection +
      content.slice(endIdx)
    );
  }

  // ── Private: core update logic ────────────────────────────────────────────

  private async doUpdate(
    entry: RegistryEntry,
    facts: ExtractedFact[],
    sceneFile: string | null,
    appearances?: string[]
  ): Promise<{ changes: AttributeChange[]; conflicts: ConflictRecord[] }> {
    // 1. Ensure the bible note exists
    await this.createBibleNote(entry);

    const path = this.bibleNotePath(entry.name);
    const file = this.app.vault.getAbstractFileByPath(path) as TFile;

    // 2. Read current content and parse frontmatter directly from it.
    const content = await this.app.vault.read(file);
    const frontmatter = this.parseFrontmatterFromContent(content);

    const manualOverrides: Record<string, string> =
      (frontmatter["manual-overrides"] as Record<string, string>) ?? {};

    // Dismissed conflicts suppress re-triggering on the same (attribute, value, scene)
    const dismissedConflicts: DismissedConflict[] = Array.isArray(
      frontmatter["dismissed-conflicts"]
    )
      ? (frontmatter["dismissed-conflicts"] as DismissedConflict[])
      : [];

    // 3. Parse managed section
    const existingSection = this.parseManagedSection(content);

    // 4. Parse existing table rows and location
    const attrRows = existingSection ? this.parseAttributeTable(existingSection) : [];
    const appRows  = existingSection ? this.parseAppearanceTable(existingSection) : [];
    const existingLocation = existingSection ? this.parseLocation(existingSection) : null;

    // 5. Merge new facts — detect conflicts for established attributes
    console.log(`Chronicle doUpdate [${entry.name}]:`,
      `facts=${facts.map(f => `${f.attribute}:${f.value}`).join(",")}`,
      `manualOverrides=${JSON.stringify(manualOverrides)}`,
      `attrRows=${JSON.stringify(attrRows.map(r => `${r.attribute}:${r.value}`))}`
    );
    const changes:   AttributeChange[] = [];
    const conflicts: ConflictRecord[]  = [];
    const updatedAttrRows = [...attrRows];
    let updatedLocation = existingLocation;

    for (const fact of facts) {
      if (fact.attribute in manualOverrides) {
        // Manual override is the established canonical value.
        // Still raise a conflict if new prose contradicts it.
        const overrideValue = manualOverrides[fact.attribute];
        if (fact.value && fact.value !== overrideValue) {
          const alreadyDismissed = dismissedConflicts.some(
            (d) =>
              d.attribute === fact.attribute &&
              d.value     === fact.value     &&
              d.scene     === fact.sourceScene
          );
          if (!alreadyDismissed) {
            conflicts.push({
              type:       "hard",
              entity:     entry.name,
              attribute:  fact.attribute,
              priorValue: overrideValue,
              priorScene: "(manual override)",
              newValue:   fact.value,
              newScene:   fact.sourceScene,
              newLine:    fact.sourceLine,
              status:     "active",
            });
          }
        }
        continue; // Never overwrite a manual override
      }

      if (fact.attribute === "location") {
        const newLoc = fact.value === "" ? null : fact.value;
        if (newLoc !== existingLocation) {
          changes.push({
            attribute: "location",
            oldValue: existingLocation,
            newValue: newLoc,
            sourceQuote: fact.sourceQuote,
            sourceLine: fact.sourceLine,
          });
          updatedLocation = newLoc;
        }
        continue;
      }

      // Physical attribute
      const existing      = updatedAttrRows.find((r) => r.attribute === fact.attribute);
      const existingValue = existing?.value ?? null;

      if (existingValue !== null && existingValue !== fact.value) {
        // Established value contradicted — potential hard conflict
        const alreadyDismissed = dismissedConflicts.some(
          (d) =>
            d.attribute === fact.attribute &&
            d.value     === fact.value     &&
            d.scene     === fact.sourceScene
        );

        if (!alreadyDismissed) {
          conflicts.push({
            type: "hard",
            entity:     entry.name,
            attribute:  fact.attribute,
            priorValue: existingValue,
            priorScene: existing?.firstMentioned ?? "unknown",
            newValue:   fact.value,
            newScene:   fact.sourceScene,
            newLine:    fact.sourceLine,
            status:     "active",
          });
          // Do NOT update the stored value — writer must resolve the conflict
          continue;
        }
        // Dismissed: fall through to update normally
      }

      if (existingValue !== fact.value) {
        changes.push({
          attribute: fact.attribute,
          oldValue:  existingValue,
          newValue:  fact.value,
          sourceQuote: fact.sourceQuote,
          sourceLine:  fact.sourceLine,
        });

        if (existing) {
          existing.value  = fact.value;
          existing.source = fact.sourceQuote;
        } else {
          updatedAttrRows.push({
            attribute:      fact.attribute,
            value:          fact.value,
            firstMentioned: fact.sourceScene,
            source:         fact.sourceQuote,
          });
        }
      }
    }

    // 6. Merge appearances
    const allScenes = [
      ...(appearances ?? []),
      ...(sceneFile ? [sceneFile] : []),
    ];
    const updatedAppRows = [...appRows];
    for (const scene of allScenes) {
      if (!updatedAppRows.some((r) => r.scene === scene)) {
        updatedAppRows.push({ scene, role: "—", chapter: "—" });
      }
    }

    // 7. Early exit if nothing changed
    // Also check if any row has a manual override not yet reflected in the table
    // (source column still shows the original quote rather than "(manual override)")
    const overrideNeedsDisplay = updatedAttrRows.some(
      (row) => row.attribute in manualOverrides && row.source !== "(manual override)"
    );
    if (changes.length === 0 && updatedAppRows.length === appRows.length && !overrideNeedsDisplay) {
      return { changes: [], conflicts };
    }

    // 8. Regenerate managed section
    const newSection = this.regenerateManagedSection(
      entry.type,
      updatedAttrRows,
      manualOverrides,
      updatedAppRows,
      updatedLocation
    );

    // 9. Update frontmatter attributes block
    const newAttributes: Record<string, string> = {};
    for (const row of updatedAttrRows) {
      newAttributes[row.attribute] =
        row.attribute in manualOverrides ? manualOverrides[row.attribute] : row.value;
    }
    if (updatedLocation) newAttributes["location"] = updatedLocation;

    // 10. Write updated note
    let updated = this.replaceManagedSection(content, newSection);
    updated = this.updateFrontmatterAttributes(updated, newAttributes);
    await this.app.vault.modify(file, updated);

    return { changes, conflicts };
  }

  // ── Private: markdown table parsing ──────────────────────────────────────

  private parseMarkdownTable(section: string, headingText: string): string[][] {
    const headingIdx = section.indexOf(`## ${headingText}`);
    if (headingIdx === -1) return [];

    const afterHeading = section.slice(headingIdx + `## ${headingText}`.length);
    const tableLines: string[] = [];

    for (const line of afterHeading.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" && tableLines.length > 0) break;
      if (trimmed.startsWith("## ")) break;
      if (trimmed.startsWith("|")) tableLines.push(line);
    }

    if (tableLines.length < 2) return []; // need at least header + separator

    const rows: string[][] = [];
    for (let i = 2; i < tableLines.length; i++) {
      const cells = tableLines[i]
        .split("|")
        .map((c) => c.trim())
        .filter((_, idx, arr) => idx !== 0 && idx !== arr.length - 1);
      if (cells.length > 0 && cells.some((c) => c !== "")) {
        rows.push(cells);
      }
    }
    return rows;
  }

  private parseAttributeTable(section: string): AttributeTableRow[] {
    const rows = this.parseMarkdownTable(section, "Extracted Attributes");
    return rows
      .map((cells) => ({
        attribute: (cells[0] ?? "").toLowerCase(),
        value: cells[1] ?? "",
        firstMentioned: cells[2] ?? "",
        source: cells[3] ?? "",
      }))
      .filter((r) => r.attribute !== "");
  }

  private parseAppearanceTable(section: string): AppearanceRow[] {
    const rows = this.parseMarkdownTable(section, "Appearances");
    return rows
      .map((cells) => ({
        scene: cells[0] ?? "",
        role: cells[1] ?? "—",
        chapter: cells[2] ?? "—",
      }))
      .filter((r) => r.scene !== "");
  }

  private parseLocation(section: string): string | null {
    const marker = "## Last Known Location";
    const idx = section.indexOf(marker);
    if (idx === -1) return null;

    const after = section.slice(idx + marker.length).trim();
    const firstLine = after.split("\n")[0]?.trim() ?? "";

    if (!firstLine || firstLine.startsWith("_No location")) return null;

    // Strip " — last established in ..." suffix
    const dashIdx = firstLine.indexOf(" — ");
    return dashIdx !== -1 ? firstLine.slice(0, dashIdx).trim() : firstLine;
  }

  // ── Private: managed section generation ──────────────────────────────────

  private regenerateManagedSection(
    entityType: EntityType,
    rows: AttributeTableRow[],
    manualOverrides: Record<string, string>,
    appearances: AppearanceRow[],
    location: string | null
  ): string {
    if (entityType !== "character") {
      // Non-character: simpler section (just a Description table)
      return this.regenerateNonCharacterSection(rows, manualOverrides);
    }

    const lines: string[] = [];

    // Extracted Attributes table
    lines.push("## Extracted Attributes", "");
    lines.push("| Attribute | Value | First Mentioned | Source |");
    lines.push("|-----------|-------|----------------|--------|");

    for (const row of rows) {
      const overrideVal = manualOverrides[row.attribute];
      const displayVal = overrideVal ?? row.value;
      const displaySrc = overrideVal ? "(manual override)" : row.source;
      lines.push(
        `| ${this.capitalise(row.attribute)} | ${displayVal} | ${row.firstMentioned} | ${displaySrc} |`
      );
    }

    // Add manual overrides for attributes not yet in table
    for (const [attr, val] of Object.entries(manualOverrides)) {
      if (attr === "location") continue;
      if (!rows.some((r) => r.attribute === attr)) {
        lines.push(`| ${this.capitalise(attr)} | ${val} | — | (manual override) |`);
      }
    }

    lines.push("");

    // Appearances table
    lines.push("## Appearances", "");
    lines.push("| Scene | Role | Chapter |");
    lines.push("|-------|------|---------|");
    for (const row of appearances) {
      lines.push(`| ${row.scene} | ${row.role} | ${row.chapter} |`);
    }
    lines.push("");

    // Last Known Location
    lines.push("## Last Known Location", "");

    // Manual override takes precedence over extracted location
    const effectiveLocation: string | null =
      "location" in manualOverrides ? manualOverrides["location"] : location;

    if (effectiveLocation) {
      lines.push(effectiveLocation);
    } else {
      lines.push("_No location data yet._");
    }

    lines.push("");

    return lines.join("\n");
  }

  private regenerateNonCharacterSection(
    rows: AttributeTableRow[],
    manualOverrides: Record<string, string>
  ): string {
    const lines: string[] = [];
    lines.push("## Description", "");
    lines.push("| Attribute | Value | First Mentioned | Source |");
    lines.push("|-----------|-------|----------------|--------|");

    for (const row of rows) {
      const overrideVal = manualOverrides[row.attribute];
      const displayVal = overrideVal ?? row.value;
      const displaySrc = overrideVal ? "(manual override)" : row.source;
      lines.push(
        `| ${this.capitalise(row.attribute)} | ${displayVal} | ${row.firstMentioned} | ${displaySrc} |`
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  // ── Private: frontmatter update ───────────────────────────────────────────

  private updateFrontmatterAttributes(
    content: string,
    attrs: Record<string, string>
  ): string {
    let newAttrBlock: string;
    if (Object.keys(attrs).length === 0) {
      newAttrBlock = "attributes: {}";
    } else {
      const attrLines = ["attributes:"];
      for (const [key, val] of Object.entries(attrs)) {
        // Quote values containing YAML special characters
        const needsQuotes = /[:#\[\]{}|>&*!,?]/.test(val);
        const safeVal = needsQuotes ? `"${val.replace(/"/g, '\\"')}"` : val;
        attrLines.push(`  ${key}: ${safeVal}`);
      }
      newAttrBlock = attrLines.join("\n");
    }

    // Replace the existing "attributes:" block in frontmatter
    // Handles: "attributes: {}" or "attributes:\n  key: val\n  ..."
    return content.replace(
      /^attributes:(?:\s*\{\}|(?:\n[ \t]+[^\n]+)+)/m,
      newAttrBlock
    );
  }

  /**
   * Rewrite the `manual-overrides:` frontmatter key with the given map.
   * Always serialises as YAML flow mapping: `{key: val}` or `{}`.
   * Handles both flow style `{...}` and block style `\n  key: val` originals.
   */
  private updateManualOverrides(
    content: string,
    overrides: Record<string, string>
  ): string {
    const pairs = Object.entries(overrides)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const newLine = `manual-overrides: {${pairs}}`;
    return content.replace(
      /^manual-overrides:(?:\s*\{\}|\s*\{[^}]*\}|(?:\n[ \t]+[^\n]+)+)/m,
      newLine
    );
  }

  // ── Private: dismissed-conflicts frontmatter ─────────────────────────────

  /**
   * Append a DismissedConflict entry to the `dismissed-conflicts:` list in
   * the file's frontmatter, preserving all other frontmatter fields.
   */
  private appendDismissedConflictToFrontmatter(
    content: string,
    dismissed: DismissedConflict
  ): string {
    if (!content.startsWith("---")) return content;
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return content;

    const fmBlock = content.slice(4, endIdx); // skip opening "---\n"
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    // Deduplication: skip if this exact (attribute, value, scene) is already present.
    if (
      fmBlock.includes(`attribute: "${esc(dismissed.attribute)}"`) &&
      fmBlock.includes(`value: "${esc(dismissed.value)}"`) &&
      fmBlock.includes(`scene: "${esc(dismissed.scene)}"`)
    ) {
      return content;
    }

    const newEntry = [
      `  - attribute: "${esc(dismissed.attribute)}"`,
      `    value: "${esc(dismissed.value)}"`,
      `    scene: "${esc(dismissed.scene)}"`,
      ...(dismissed.note ? [`    note: "${esc(dismissed.note)}"`] : []),
      `    dismissedAt: "${dismissed.dismissedAt}"`,
    ].join("\n");

    // Match dismissed-conflicts: followed by ALL indented continuation lines so
    // that the insert position lands after the last item, not mid-entry.
    // Previously the regex only matched "  - …" lines, missing "    key: val" continuations.
    const listMatch = /^dismissed-conflicts:\s*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(fmBlock);
    if (listMatch) {
      const insertAt = 4 + listMatch.index + listMatch[0].length;
      return content.slice(0, insertAt) + newEntry + "\n" + content.slice(insertAt);
    }

    // If dismissed-conflicts: [] or no entry at all, add the block before closing ---
    const emptyMatch = /^dismissed-conflicts:\s*\[\]\s*$/m.exec(fmBlock);
    if (emptyMatch) {
      const newFm = fmBlock.replace(
        /^dismissed-conflicts:\s*\[\]\s*$/m,
        `dismissed-conflicts:\n${newEntry}`
      );
      return "---\n" + newFm + "\n---" + content.slice(endIdx + 4);
    }

    // No dismissed-conflicts key at all — append before closing ---
    const newFm = fmBlock + `\ndismissed-conflicts:\n${newEntry}`;
    return "---\n" + newFm + "\n---" + content.slice(endIdx + 4);
  }

  // ── Private: content generation (new notes) ───────────────────────────────

  private sanitiseFilename(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, "-");
  }

  private capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private generateNoteContent(entry: RegistryEntry): string {
    const aliasLines =
      entry.aliases.length > 0
        ? entry.aliases.map((a) => `  - "${a}"`).join("\n")
        : "";

    const frontmatterLines = [
      "---",
      `chronicle-type: ${entry.type}`,
      "chronicle-managed: true",
      "chronicle-version: 1",
      "attributes: {}",
      "manual-overrides: {}",
      "aliases:",
    ];
    if (aliasLines) frontmatterLines.push(aliasLines);
    else frontmatterLines.push("  []");
    frontmatterLines.push("---");

    const typeLabel = entry.type.charAt(0).toUpperCase() + entry.type.slice(1);

    const bodyLines = [
      "",
      `# ${entry.name}`,
      "",
      `_Chronicle-generated ${typeLabel.toLowerCase()} profile. Edit the \`manual-overrides\` section in the frontmatter to correct extraction errors. Manual overrides always take precedence._`,
      "",
      "<!-- chronicle:start -->",
      this.generateManagedSection(entry.type),
      "<!-- chronicle:end -->",
    ];

    return frontmatterLines.join("\n") + bodyLines.join("\n");
  }

  private generateManagedSection(type: EntityType): string {
    switch (type) {
      case "character":
        return [
          "## Extracted Attributes",
          "",
          "| Attribute | Value | First Mentioned | Source |",
          "|-----------|-------|----------------|--------|",
          "",
          "## Appearances",
          "",
          "| Scene | Role | Chapter |",
          "|-------|------|---------|",
          "",
          "## Last Known Location",
          "",
          "_No location data yet._",
          "",
        ].join("\n");

      case "location":
        return [
          "## Description",
          "",
          "| Attribute | Value | First Mentioned | Source |",
          "|-----------|-------|----------------|--------|",
          "",
          "## Scenes Set Here",
          "",
          "| Scene | Chapter |",
          "|-------|---------|",
          "",
          "## Current Occupants",
          "",
          "_No occupant data yet._",
          "",
        ].join("\n");

      case "object":
        return [
          "## Description",
          "",
          "| Attribute | Value | First Mentioned | Source |",
          "|-----------|-------|----------------|--------|",
          "",
          "## Possession History",
          "",
          "| Holder | Scene | Chapter |",
          "|--------|-------|---------|",
          "",
          "## Last Known Location",
          "",
          "_No location data yet._",
          "",
        ].join("\n");

      case "faction":
        return [
          "## Description",
          "",
          "| Attribute | Value | First Mentioned | Source |",
          "|-----------|-------|----------------|--------|",
          "",
          "## Known Members",
          "",
          "| Name | Role | First Mentioned |",
          "|------|------|----------------|",
          "",
          "## Scenes Involved",
          "",
          "| Scene | Role | Chapter |",
          "|-------|------|---------|",
          "",
        ].join("\n");
    }
  }
}
