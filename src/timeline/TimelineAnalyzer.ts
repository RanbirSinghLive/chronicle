import { App, TFile, parseYaml } from "obsidian";
import type { ChronicleSettings, SceneTemporalRecord } from "../types";
import { TemporalExtractor } from "./TemporalExtractor";
import { stripFrontmatter } from "../utils/vault";

export class TimelineAnalyzer {
  private extractor = new TemporalExtractor();

  constructor(
    private app: App,
    private settings: ChronicleSettings
  ) {}

  // ── Public ──────────────────────────────────────────────────────────────────

  async buildTimeline(): Promise<SceneTemporalRecord[]> {
    const sceneFiles = this.getSceneFiles();
    const records: SceneTemporalRecord[] = [];

    for (const file of sceneFiles) {
      const content = await this.app.vault.read(file);
      const anchor = this.readAnchor(content);
      const body = stripFrontmatter(content);
      const markers = this.extractor.extract(body);

      records.push({
        scenePath: file.path,
        anchor: anchor !== null ? String(anchor) : undefined,
        markers,
        resolvedPosition: anchor !== null ? anchor : undefined,
      });
    }

    return records;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Read the `chronicle-anchor` frontmatter key as a number.
   * Accepts both numeric YAML values and numeric strings.
   */
  private readAnchor(content: string): number | null {
    if (!content.startsWith("---")) return null;
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return null;
    let fm: Record<string, unknown>;
    try {
      fm = (parseYaml(content.slice(4, endIdx)) as Record<string, unknown>) ?? {};
    } catch {
      return null;
    }
    const val = fm["chronicle-anchor"];
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const n = parseFloat(val);
      if (!isNaN(n)) return n;
    }
    return null;
  }

  /**
   * Return scene files in reading order, mirroring the logic in PresenceAnalyzer.
   */
  private getSceneFiles(): TFile[] {
    const chronicleDir = this.settings.registryPath.substring(
      0,
      this.settings.registryPath.lastIndexOf("/")
    );

    const all = this.app.vault.getMarkdownFiles().filter((f) => {
      if (chronicleDir && f.path.startsWith(chronicleDir + "/")) return false;
      if (f.path === this.settings.registryPath) return false;
      return true;
    });

    if (this.settings.sceneFolders.length === 0) {
      return all.sort((a, b) => a.path.localeCompare(b.path));
    }

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
}
