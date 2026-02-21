import { App, Modal, Notice, Setting, TFile } from "obsidian";

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
      this.setFrontmatterKey(content, "chronicle-anchor", position)
    );
  }

  private async clearAnchor(): Promise<void> {
    const content = await this.app.vault.read(this.file);
    await this.app.vault.modify(
      this.file,
      this.removeFrontmatterKey(content, "chronicle-anchor")
    );
  }

  /**
   * Set `key: value` in the YAML frontmatter.
   * Creates a frontmatter block if none exists.
   */
  private setFrontmatterKey(
    content: string,
    key: string,
    value: number
  ): string {
    if (content.startsWith("---")) {
      const endIdx = content.indexOf("\n---", 3);
      if (endIdx !== -1) {
        // fmBody = text between opening and closing ---
        const fmBody = content.slice(4, endIdx);
        const rest = content.slice(endIdx); // starts with \n---

        const keyRegex = new RegExp(`^${key}:.*$`, "m");
        if (keyRegex.test(fmBody)) {
          return "---\n" + fmBody.replace(keyRegex, `${key}: ${value}`) + rest;
        }
        // Append key before closing ---
        const sep = fmBody.trim() ? "\n" : "";
        return "---\n" + fmBody + sep + `${key}: ${value}` + rest;
      }
    }
    // No valid frontmatter — prepend one
    return `---\n${key}: ${value}\n---\n\n` + content;
  }

  /** Remove `key` line(s) from the YAML frontmatter. */
  private removeFrontmatterKey(content: string, key: string): string {
    if (!content.startsWith("---")) return content;
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return content;

    const fmBody = content.slice(4, endIdx);
    const rest = content.slice(endIdx);

    // Remove the key line (may or may not have a leading newline)
    const cleaned = fmBody
      .split("\n")
      .filter((line) => !line.match(new RegExp(`^${key}:`)))
      .join("\n");

    return "---\n" + cleaned + rest;
  }
}
