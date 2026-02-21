import { App, TFile, parseYaml } from "obsidian";
import type { ChronicleSettings, EntityType, RegistryEntry } from "../types";
import { ensureFolderExists, stripFrontmatter } from "../utils/vault";

const SECTION_HEADINGS: Record<EntityType, string> = {
  character: "## Characters",
  location: "## Locations",
  object: "## Objects",
  faction: "## Factions",
};

export class RegistryManager {
  private app: App;
  private settings: ChronicleSettings;

  constructor(app: App, settings: ChronicleSettings) {
    this.app = app;
    this.settings = settings;
  }

  /**
   * Ensure the registry file exists at the configured path.
   * Creates it with an empty template if not present.
   */
  async ensureRegistryExists(): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(this.settings.registryPath);
    if (existing instanceof TFile) return;

    const folder = this.settings.registryPath.substring(
      0,
      this.settings.registryPath.lastIndexOf("/")
    );
    if (folder) await ensureFolderExists(this.app, folder);

    const template = [
      "---",
      "chronicle-registry: true",
      "---",
      "",
      "## Characters",
      "",
      "## Locations",
      "",
      "## Objects",
      "",
      "## Factions",
      "",
    ].join("\n");

    await this.app.vault.create(this.settings.registryPath, template);
  }

  /**
   * Parse the registry file and return all registered entities.
   * Deduplicates by name (case-insensitive) — keeps the first occurrence.
   */
  async loadEntries(): Promise<RegistryEntry[]> {
    const file = await this.getOrCreateRegistryFile();
    const content = await this.app.vault.read(file);
    const body = stripFrontmatter(content);
    const all = this.parseBody(body);
    const seen = new Set<string>();
    return all.filter((e) => {
      const key = e.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Append a new entity to the appropriate section in the registry file.
   * Never rewrites existing content — inserts before the next section heading
   * (or at end of file if last section).
   * Throws if an entity with the same name (case-insensitive) already exists.
   */
  async addEntry(entry: RegistryEntry): Promise<void> {
    const file = await this.getOrCreateRegistryFile();
    const content = await this.app.vault.read(file);

    // Duplicate check
    const existing = this.parseBody(stripFrontmatter(content));
    if (existing.some((e) => e.name.toLowerCase() === entry.name.toLowerCase())) {
      throw new Error(`"${entry.name}" is already in the registry.`);
    }
    const lines = content.split("\n");

    const targetHeading = SECTION_HEADINGS[entry.type];
    const entryBlock = this.serialiseEntry(entry);

    // Find the line index of the target section heading
    let targetIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === targetHeading) {
        targetIdx = i;
        break;
      }
    }

    if (targetIdx === -1) {
      // Section heading not found — append heading + entry at end
      const suffix = content.endsWith("\n") ? "" : "\n";
      await this.app.vault.modify(
        file,
        content + suffix + targetHeading + "\n\n" + entryBlock + "\n"
      );
      return;
    }

    // Find the next section heading after targetIdx
    let nextSectionIdx = -1;
    for (let i = targetIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        nextSectionIdx = i;
        break;
      }
    }

    const insertIdx = nextSectionIdx === -1 ? lines.length : nextSectionIdx;

    // Insert a blank line + entry block before the next section (or end)
    lines.splice(insertIdx, 0, entryBlock, "");
    await this.app.vault.modify(file, lines.join("\n"));
  }

  /**
   * Open the registry file in the active editor leaf.
   */
  async openInEditor(): Promise<void> {
    const file = await this.getOrCreateRegistryFile();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async getOrCreateRegistryFile(): Promise<TFile> {
    await this.ensureRegistryExists();
    const file = this.app.vault.getAbstractFileByPath(this.settings.registryPath);
    if (!(file instanceof TFile)) {
      throw new Error(`Chronicle: Could not find or create registry at ${this.settings.registryPath}`);
    }
    return file;
  }

  private parseBody(body: string): RegistryEntry[] {
    const entries: RegistryEntry[] = [];
    const lines = body.split("\n");

    let currentType: EntityType | null = null;
    let currentBlock: string[] = [];

    const flushBlock = () => {
      if (currentBlock.length > 0 && currentType !== null) {
        const entry = this.parseEntryBlock(currentBlock.join("\n"), currentType);
        if (entry) entries.push(entry);
        currentBlock = [];
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("## ")) {
        flushBlock();
        currentType = this.typeFromHeading(trimmed);
      } else if (trimmed.startsWith("- name:") && currentType !== null) {
        flushBlock();
        currentBlock = [line];
      } else if (currentBlock.length > 0) {
        // Continuation line: either indented content or blank line within block
        if (line.startsWith("  ") || trimmed === "") {
          currentBlock.push(line);
        } else {
          // Non-indented, non-blank line that isn't a new entry — flush
          flushBlock();
        }
      }
    }
    flushBlock();

    return entries;
  }

  private parseEntryBlock(block: string, type: EntityType): RegistryEntry | null {
    try {
      // The block is a YAML block sequence item (starts with "- name: ...").
      // parseYaml parses it directly as an array.
      const parsed = parseYaml(block);

      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const obj = parsed[0] as Record<string, unknown>;
      if (typeof obj.name !== "string") return null;

      const aliases: string[] = [];
      if (Array.isArray(obj.aliases)) {
        for (const a of obj.aliases) {
          if (typeof a === "string") aliases.push(a);
        }
      }

      const entry: RegistryEntry = {
        name: obj.name,
        aliases,
        type,
      };

      if (typeof obj.sceneFolder === "string") entry.sceneFolder = obj.sceneFolder;
      if (typeof obj.excluded === "boolean") entry.excluded = obj.excluded;

      return entry;
    } catch {
      return null;
    }
  }

  private typeFromHeading(heading: string): EntityType | null {
    switch (heading) {
      case "## Characters": return "character";
      case "## Locations": return "location";
      case "## Objects": return "object";
      case "## Factions": return "faction";
      default: return null;
    }
  }

  private serialiseEntry(entry: RegistryEntry): string {
    const aliasesStr =
      entry.aliases.length === 0
        ? "[]"
        : "[" + entry.aliases.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(", ") + "]";

    const lines = [
      `- name: ${entry.name}`,
      `  aliases: ${aliasesStr}`,
      `  type: ${entry.type}`,
    ];

    if (entry.sceneFolder) lines.push(`  sceneFolder: "${entry.sceneFolder}"`);
    if (entry.excluded) lines.push(`  excluded: true`);

    return lines.join("\n");
  }
}
