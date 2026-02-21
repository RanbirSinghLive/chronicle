import { App, Modal, Notice, Setting } from "obsidian";
import type { EntityType } from "../types";
import type { RegistryManager } from "./RegistryManager";

export class RegisterEntityModal extends Modal {
  private registry: RegistryManager;

  constructor(app: App, registry: RegistryManager) {
    super(app);
    this.registry = registry;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Register Entity" });

    let nameValue = "";
    let aliasesValue = "";
    let typeValue: EntityType = "character";

    new Setting(contentEl)
      .setName("Name")
      .setDesc("The primary name Chronicle will search for in your scenes.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. Elena")
          .onChange((val) => {
            nameValue = val.trim();
          });
        // Focus the name field when the modal opens
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .setName("Aliases")
      .setDesc("Comma-separated alternative names Chronicle will also recognise.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Ellie, the Archivist")
          .onChange((val) => {
            aliasesValue = val;
          })
      );

    new Setting(contentEl).setName("Type").addDropdown((drop) =>
      drop
        .addOptions({
          character: "Character",
          location: "Location",
          object: "Object",
          faction: "Faction",
        })
        .setValue("character")
        .onChange((val) => {
          typeValue = val as EntityType;
        })
    );

    const statusEl = contentEl.createEl("p", { cls: "chronicle-modal-status" });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Register")
        .setCta()
        .onClick(async () => {
          if (!nameValue) {
            statusEl.setText("Name is required.");
            return;
          }

          const aliases = aliasesValue
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          try {
            await this.registry.addEntry({ name: nameValue, aliases, type: typeValue });
            new Notice(`Chronicle: "${nameValue}" registered as ${typeValue}.`);
            this.close();
          } catch (err) {
            statusEl.setText(
              err instanceof Error ? err.message : "Failed to register entity."
            );
          }
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
