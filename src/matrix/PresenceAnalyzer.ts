import { App, TFile, parseYaml } from "obsidian";
import type {
  ChronicleSettings,
  CellPresence,
  PresenceCell,
  PresenceMatrix,
  RegistryEntry,
  SceneRow,
} from "../types";
import type { RegistryManager } from "../registry/RegistryManager";
import type { BibleManager } from "../bible/BibleManager";
import { stripFrontmatter } from "../utils/vault";
import { buildEntityAlternation } from "../extraction/patterns";

export class PresenceAnalyzer {
  constructor(
    private app: App,
    private settings: ChronicleSettings,
    private registry: RegistryManager,
    private bible: BibleManager
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  async buildMatrix(): Promise<PresenceMatrix> {
    const entries  = await this.registry.loadEntries();
    const characters = entries.filter((e) => e.type === "character" && !e.excluded);

    const sceneFiles = this.getSceneFiles();

    // Pre-load appearances from bible notes: characterName → Set<scenePath>
    const appearanceMap = new Map<string, Set<string>>();
    await Promise.all(
      characters.map(async (char) => {
        const scenes = await this.bible.getSceneAppearances(char);
        appearanceMap.set(char.name, new Set(scenes));
      })
    );

    // Build rows
    const sceneRows: SceneRow[] = [];
    for (const file of sceneFiles) {
      const content = await this.app.vault.read(file);
      const povName  = this.detectPOV(content, characters);

      const cells: Record<string, PresenceCell> = {};
      for (const char of characters) {
        const inAppearances = appearanceMap.get(char.name)?.has(file.path) ?? false;
        let presence: CellPresence;

        if (povName === char.name) {
          presence = "pov";
        } else if (inAppearances) {
          presence = "active";
        } else if (this.mentionedInScene(content, char)) {
          presence = "mentioned";
        } else {
          presence = "absent";
        }

        cells[char.name] = { presence };
      }

      sceneRows.push({
        scenePath:  file.path,
        sceneLabel: file.basename,
        cells,
      });
    }

    return {
      characters: characters.map((c) => c.name),
      scenes: sceneRows,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Return scene files in reading order.
   * Files inside configured sceneFolders are sorted alphabetically within
   * each folder (assumes numeric/alphabetical naming convention).
   * When no sceneFolders are configured, all markdown files are used.
   */
  private getSceneFiles(): TFile[] {
    const chronicleDir = this.settings.registryPath.substring(
      0, this.settings.registryPath.lastIndexOf("/")
    );

    const all = this.app.vault
      .getMarkdownFiles()
      .filter((f) => {
        if (chronicleDir && f.path.startsWith(chronicleDir + "/")) return false;
        if (f.path === this.settings.registryPath) return false;
        return true;
      });

    if (this.settings.sceneFolders.length === 0) {
      return all.sort((a, b) => a.path.localeCompare(b.path));
    }

    // Keep only files inside configured scene folders, preserve folder order
    const result: TFile[] = [];
    for (const folder of this.settings.sceneFolders) {
      const normalised = folder.replace(/\/$/, "");
      const inFolder = all
        .filter((f) => f.path.startsWith(normalised + "/"))
        .sort((a, b) => a.path.localeCompare(b.path));
      result.push(...inFolder);
    }
    return result;
  }

  /**
   * Read the `pov:` frontmatter key and return the matching character name,
   * or null if none.
   */
  private detectPOV(content: string, characters: RegistryEntry[]): string | null {
    if (!content.startsWith("---")) return null;
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return null;
    let fm: Record<string, unknown>;
    try {
      fm = (parseYaml(content.slice(4, endIdx)) as Record<string, unknown>) ?? {};
    } catch {
      return null;
    }
    const pov = fm["pov"];
    if (typeof pov !== "string") return null;
    const povLower = pov.toLowerCase();
    for (const char of characters) {
      if (
        char.name.toLowerCase() === povLower ||
        char.aliases.some((a) => a.toLowerCase() === povLower)
      ) {
        return char.name;
      }
    }
    return null;
  }

  /**
   * True if the character's name or any alias appears literally in the scene
   * body (case-insensitive). Used to classify "mentioned" (◦) presence.
   */
  private mentionedInScene(content: string, char: RegistryEntry): boolean {
    const body = stripFrontmatter(content).toLowerCase();
    const names = [char.name, ...char.aliases];
    return names.some((n) => body.includes(n.toLowerCase()));
  }
}
