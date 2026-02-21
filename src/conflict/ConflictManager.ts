import { App, TFile, parseYaml } from "obsidian";
import type {
  ChronicleSettings,
  ConflictRecord,
  DismissedConflict,
} from "../types";
import { ensureFolderExists } from "../utils/vault";
import type { BibleManager } from "../bible/BibleManager";

export class ConflictManager {
  private app: App;
  private settings: ChronicleSettings;

  constructor(app: App, settings: ChronicleSettings) {
    this.app = app;
    this.settings = settings;
  }

  private get conflictPath(): string {
    const dir = this.settings.registryPath.substring(
      0,
      this.settings.registryPath.lastIndexOf("/")
    );
    return `${dir}/conflicts.md`;
  }

  async ensureConflictLogExists(): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(this.conflictPath);
    if (existing instanceof TFile) return;

    const dir = this.conflictPath.substring(
      0,
      this.conflictPath.lastIndexOf("/")
    );
    await ensureFolderExists(this.app, dir);

    await this.app.vault.create(
      this.conflictPath,
      [
        "---",
        "chronicle-conflicts: true",
        "conflicts: []",
        "---",
        "",
        "# Conflict Log",
        "",
        "_Managed by Chronicle. Use the conflict popover or 'View conflict log' command to resolve conflicts._",
        "",
      ].join("\n")
    );
  }

  async loadConflicts(): Promise<ConflictRecord[]> {
    await this.ensureConflictLogExists();
    const file = this.app.vault.getAbstractFileByPath(
      this.conflictPath
    ) as TFile;
    const content = await this.app.vault.read(file);
    const fm = this.parseFm(content);
    const raw = fm["conflicts"];
    return Array.isArray(raw) ? (raw as ConflictRecord[]) : [];
  }

  async saveConflicts(conflicts: ConflictRecord[]): Promise<void> {
    await this.ensureConflictLogExists();
    const file = this.app.vault.getAbstractFileByPath(
      this.conflictPath
    ) as TFile;
    const content = await this.app.vault.read(file);

    // Preserve body after closing ---
    const closingDelim = content.indexOf("\n---", 3);
    const body = closingDelim !== -1 ? content.slice(closingDelim + 4) : "\n";

    const lines = [
      "---",
      "chronicle-conflicts: true",
      "conflicts:",
    ];

    for (const c of conflicts) {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      lines.push(`  - type: ${c.type}`);
      lines.push(`    entity: "${esc(c.entity)}"`);
      lines.push(`    attribute: "${esc(c.attribute)}"`);
      lines.push(`    priorValue: "${esc(c.priorValue)}"`);
      lines.push(`    priorScene: "${esc(c.priorScene)}"`);
      lines.push(`    newValue: "${esc(c.newValue)}"`);
      lines.push(`    newScene: "${esc(c.newScene)}"`);
      lines.push(`    newLine: ${c.newLine}`);
      lines.push(`    status: ${c.status}`);
      if (c.dismissalNote) lines.push(`    dismissalNote: "${esc(c.dismissalNote)}"`);
      if (c.dismissedAt)   lines.push(`    dismissedAt: "${c.dismissedAt}"`);
    }

    lines.push("---");
    await this.app.vault.modify(file, lines.join("\n") + body);
  }

  /**
   * Merge incoming conflicts into the log.
   * Deduplicates by (entity, attribute, newScene).
   * - Active match: update newValue/newLine in case a mid-word auto-save left
   *   a stale partial value (e.g. "lic" → "lilac").
   * - Dismissed match with same value: leave dismissed.
   * - Dismissed match with a different value: re-add as a new active conflict.
   */
  async mergeConflicts(incoming: ConflictRecord[]): Promise<void> {
    if (incoming.length === 0) return;

    const existing = await this.loadConflicts();

    for (const c of incoming) {
      const idx = existing.findIndex(
        (e) =>
          e.entity    === c.entity    &&
          e.attribute === c.attribute &&
          e.newScene  === c.newScene
      );

      if (idx === -1) {
        // No prior record for this (entity, attribute, scene) — add fresh.
        existing.push(c);
      } else if (existing[idx].status === "active") {
        // Update the value/line in case the prior record was from a partial save.
        existing[idx].newValue = c.newValue;
        existing[idx].newLine  = c.newLine;
      } else {
        // Dismissed. Re-activate only if the new value differs from what was dismissed.
        if (existing[idx].newValue !== c.newValue) {
          existing.push(c);
        }
        // Same value as dismissed → user already decided; leave it alone.
      }
    }

    await this.saveConflicts(existing);
  }

  async getActiveConflicts(): Promise<ConflictRecord[]> {
    const all = await this.loadConflicts();
    return all.filter((c) => c.status === "active");
  }

  /**
   * Dismiss a conflict: mark it in conflicts.md and record it in the
   * bible note's `dismissed-conflicts` frontmatter so it won't re-trigger.
   */
  async dismissConflict(
    conflict: ConflictRecord,
    note: string,
    bible: BibleManager
  ): Promise<void> {
    const all = await this.loadConflicts();
    const today = new Date().toISOString().slice(0, 10);

    // Dismiss ALL records for this (entity, attribute, newScene) slot so that
    // stale mid-word partial values don't leave ghost active conflicts behind.
    for (const c of all) {
      if (
        c.entity    === conflict.entity    &&
        c.attribute === conflict.attribute &&
        c.newScene  === conflict.newScene  &&
        c.status    === "active"
      ) {
        c.status       = "dismissed";
        c.dismissalNote = note || undefined;
        c.dismissedAt  = today;
      }
    }
    await this.saveConflicts(all);

    // Store dismissal in the bible note so subsequent scans don't re-surface it
    const dismissed: DismissedConflict = {
      attribute: conflict.attribute,
      value: conflict.newValue,
      scene: conflict.newScene,
      note: note || undefined,
      dismissedAt: new Date().toISOString().slice(0, 10),
    };
    await bible.addDismissedConflict(conflict.entity, dismissed);
  }

  /**
   * Accept the new value as authoritative: dismiss the conflict and
   * force-update the bible note with the new value.
   */
  async updateBible(
    conflict: ConflictRecord,
    bible: BibleManager
  ): Promise<void> {
    await this.dismissConflict(conflict, "Updated bible to new value", bible);
    await bible.forceUpdateAttribute(
      conflict.entity,
      conflict.attribute,
      conflict.newValue,
      conflict.newScene
    );
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private parseFm(content: string): Record<string, unknown> {
    if (!content.startsWith("---")) return {};
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return {};
    try {
      return (parseYaml(content.slice(4, endIdx)) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }
}
