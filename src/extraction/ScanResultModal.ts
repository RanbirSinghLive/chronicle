import { App, Modal } from "obsidian";
import type { ScanResult } from "../types";

export class ScanResultModal extends Modal {
  private result: ScanResult;

  constructor(app: App, result: ScanResult) {
    super(app);
    this.result = result;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Chronicle: Full Scan Results" });

    const { scannedPaths, entities, durationMs } = this.result;
    const fileWord = scannedPaths.length !== 1 ? "files" : "file";
    const entityWord = entities.length !== 1 ? "entities" : "entity";

    contentEl.createEl("p", {
      text: `Scanned ${scannedPaths.length} ${fileWord} in ${durationMs}ms. ${entities.length} ${entityWord} updated.`,
    });

    if (entities.length === 0) {
      contentEl.createEl("p", {
        text: "No changes detected.",
        cls: "chronicle-modal-status",
      });
      return;
    }

    for (const entityResult of entities) {
      const section = contentEl.createDiv();
      section.createEl("h3", { text: entityResult.entityName });

      if (entityResult.appearances.length > 0) {
        const appWord = entityResult.appearances.length !== 1 ? "scenes" : "scene";
        section.createEl("p", {
          text: `Appears in ${entityResult.appearances.length} ${appWord}.`,
          cls: "chronicle-modal-status",
        });
      }

      if (entityResult.changes.length === 0) {
        section.createEl("p", {
          text: "No attribute changes — new appearances recorded.",
          cls: "chronicle-modal-status",
        });
        continue;
      }

      const list = section.createEl("ul");
      for (const change of entityResult.changes) {
        const item = list.createEl("li");
        item.createEl("strong", { text: change.attribute });
        item.appendText(": ");

        if (change.oldValue === null) {
          item.appendText(`"${change.newValue ?? ""}" (new)`);
        } else if (change.newValue === null) {
          item.appendText(`cleared (was "${change.oldValue}")`);
        } else {
          item.appendText(`"${change.oldValue}" → "${change.newValue}"`);
        }

        if (change.sourceQuote) {
          item.createEl("blockquote").setText(`"${change.sourceQuote}"`);
        }
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
