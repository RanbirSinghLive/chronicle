import { App, Modal } from "obsidian";
import type { ConflictRecord } from "../types";
import type { ConflictManager } from "./ConflictManager";
import type { BibleManager } from "../bible/BibleManager";
import { ConflictModal } from "./ConflictModal";

/**
 * Modal listing all active conflicts, grouped by entity.
 * Opened by the "View conflict log" command.
 */
export class ConflictLogModal extends Modal {
  private conflictManager: ConflictManager;
  private bible: BibleManager;

  constructor(app: App, conflictManager: ConflictManager, bible: BibleManager) {
    super(app);
    this.conflictManager = conflictManager;
    this.bible = bible;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Chronicle — Conflict Log" });

    const conflicts = await this.conflictManager.getActiveConflicts();

    if (conflicts.length === 0) {
      contentEl.createEl("p", {
        text: "No active conflicts. Your story bible is consistent.",
      });
      return;
    }

    // Group by entity
    const byEntity = new Map<string, ConflictRecord[]>();
    for (const c of conflicts) {
      if (!byEntity.has(c.entity)) byEntity.set(c.entity, []);
      byEntity.get(c.entity)!.push(c);
    }

    for (const [entity, records] of byEntity) {
      contentEl.createEl("h3", { text: entity });

      const table = contentEl.createEl("table");
      table.style.width = "100%";
      table.style.borderCollapse = "collapse";
      table.style.marginBottom = "16px";

      // Header
      const thead = table.createEl("thead");
      const hr = thead.createEl("tr");
      ["Type", "Attribute", "Established", "Conflicting", "Scene", ""].forEach((h) => {
        const th = thead.createEl("th", { text: h });
        th.style.textAlign = "left";
        th.style.padding = "4px 8px";
        th.style.borderBottom = "1px solid var(--background-modifier-border)";
      });

      const tbody = table.createEl("tbody");

      for (const c of records) {
        const tr = tbody.createEl("tr");

        // Type badge
        const typeTd = tr.createEl("td");
        typeTd.style.padding = "4px 8px";
        const badge = typeTd.createEl("span", {
          text: c.type === "hard" ? "⚠" : "◈",
        });
        badge.style.color = c.type === "hard" ? "var(--text-error)" : "#e67e22";

        [c.attribute, c.priorValue, c.newValue, c.newScene].forEach((txt, i) => {
          const td = tr.createEl("td", { text: txt });
          td.style.padding = "4px 8px";
          if (i === 2) td.style.color = "var(--text-error)";
        });

        // Resolve button
        const actionTd = tr.createEl("td");
        actionTd.style.padding = "4px 8px";
        const btn = actionTd.createEl("button", { text: "Resolve…" });
        btn.addEventListener("click", () => {
          new ConflictModal(this.app, c, this.conflictManager, this.bible, () => {
            // Refresh the log after resolution
            this.onOpen();
          }).open();
        });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
