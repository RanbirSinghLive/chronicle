import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { setFrontmatterKey, removeFrontmatterKey } from "../utils/vault";

/**
 * Modal for setting or clearing a story-time anchor on a scene file.
 * Writes/removes the `chronicle-anchor` key in the scene's YAML frontmatter.
 * This is the one case where Chronicle writes to a user's scene file —
 * it only touches frontmatter, never prose, and only on explicit user action.
 */
export class SetAnchorModal extends Modal {
  private file: TFile;

  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Set Scene Time Anchor" });
    contentEl.createEl("p", {
      cls: "chronicle-modal-status",
      text: `Scene: ${this.file.basename}`,
    });

    let positionStr = "";

    new Setting(contentEl)
      .setName("Story-time position")
      .setDesc(
        "A number for this scene's position in story time (e.g. 1, 2.5, 10). " +
          "Scenes are sorted by this value in Story-time view."
      )
      .addText((text) => {
        text.setPlaceholder("e.g. 5").onChange((val) => {
          positionStr = val.trim();
        });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const statusEl = contentEl.createEl("p", { cls: "chronicle-modal-status" });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Set anchor")
          .setCta()
          .onClick(async () => {
            const n = parseFloat(positionStr);
            if (isNaN(n)) {
              statusEl.setText("Please enter a valid number.");
              return;
            }
            try {
              await this.writeAnchor(n);
              new Notice(
                `Chronicle: Anchor set to ${n} for "${this.file.basename}".`
              );
              this.close();
            } catch (err) {
              statusEl.setText(
                err instanceof Error ? err.message : "Failed to set anchor."
              );
            }
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Clear anchor").onClick(async () => {
          try {
            await this.clearAnchor();
            new Notice(
              `Chronicle: Anchor cleared for "${this.file.basename}".`
            );
            this.close();
          } catch (err) {
            statusEl.setText(
              err instanceof Error ? err.message : "Failed to clear anchor."
            );
          }
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async writeAnchor(position: number): Promise<void> {
    const content = await this.app.vault.read(this.file);
    await this.app.vault.modify(
      this.file,
      setFrontmatterKey(content, "chronicle-anchor", position)
    );
  }

  private async clearAnchor(): Promise<void> {
    const content = await this.app.vault.read(this.file);
    await this.app.vault.modify(
      this.file,
      removeFrontmatterKey(content, "chronicle-anchor")
    );
  }
}
