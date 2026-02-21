import { App, Modal, Setting } from "obsidian";
import type { ConflictRecord } from "../types";
import type { ConflictManager } from "./ConflictManager";
import type { BibleManager } from "../bible/BibleManager";

/**
 * Popover-style modal for a single conflict.
 * Opened when the user clicks a gutter marker.
 */
export class ConflictModal extends Modal {
  private conflict: ConflictRecord;
  private conflictManager: ConflictManager;
  private bible: BibleManager;
  private onResolved: () => void;

  constructor(
    app: App,
    conflict: ConflictRecord,
    conflictManager: ConflictManager,
    bible: BibleManager,
    onResolved: () => void
  ) {
    super(app);
    this.conflict = conflict;
    this.conflictManager = conflictManager;
    this.bible = bible;
    this.onResolved = onResolved;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const c = this.conflict;

    // ── Header ──────────────────────────────────────────────────────────────────
    contentEl.createEl("h3", {
      text: `Conflict: ${c.entity} — ${c.attribute}`,
    });

    const badge = contentEl.createEl("span", {
      text: c.type === "hard" ? "⚠ Hard conflict" : "◈ Soft conflict",
    });
    badge.style.background = c.type === "hard" ? "#c0392b" : "#e67e22";
    badge.style.color = "#fff";
    badge.style.padding = "2px 8px";
    badge.style.borderRadius = "4px";
    badge.style.fontSize = "0.8em";

    // ── Comparison table ─────────────────────────────────────────────────────────
    const table = contentEl.createEl("table");
    table.style.marginTop = "12px";
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";

    const head = table.createEl("thead");
    const hr = head.createEl("tr");
    ["", "Established", "New (conflicting)"].forEach((h) => {
      const th = hr.createEl("th", { text: h });
      th.style.textAlign = "left";
      th.style.padding = "4px 8px";
      th.style.borderBottom = "1px solid var(--background-modifier-border)";
    });

    const body = table.createEl("tbody");

    const row = (label: string, prior: string, next: string) => {
      const tr = body.createEl("tr");
      [label, prior, next].forEach((txt, i) => {
        const td = tr.createEl("td", { text: txt });
        td.style.padding = "4px 8px";
        if (i === 2) {
          td.style.color = "var(--text-error)";
          td.style.fontWeight = "600";
        }
      });
    };

    row("Value", c.priorValue, c.newValue);
    row("Scene", c.priorScene, c.newScene);

    // ── Dismiss note ──────────────────────────────────────────────────────────────
    let noteValue = "";
    new Setting(contentEl)
      .setName("Dismissal note")
      .setDesc("Optional explanation (stored in bible note frontmatter).")
      .addText((t) =>
        t
          .setPlaceholder("e.g. Elena is wearing contacts")
          .onChange((v) => (noteValue = v))
      );

    // ── Action buttons ────────────────────────────────────────────────────────────
    const btnRow = contentEl.createDiv();
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.marginTop = "8px";

    // Dismiss — keep established value, mark conflict intentional
    const dismissBtn = btnRow.createEl("button", { text: "Dismiss" });
    dismissBtn.addEventListener("click", async () => {
      await this.conflictManager.dismissConflict(c, noteValue, this.bible);
      this.close();
      this.onResolved();
    });

    // Update Bible — accept new value as authoritative
    const updateBtn = btnRow.createEl("button", {
      text: "Update Bible",
    });
    updateBtn.style.background = "var(--interactive-accent)";
    updateBtn.style.color = "var(--text-on-accent)";
    updateBtn.addEventListener("click", async () => {
      await this.conflictManager.updateBible(c, this.bible);
      this.close();
      this.onResolved();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
