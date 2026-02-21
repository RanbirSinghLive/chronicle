import { App, Modal, Notice, Setting } from "obsidian";
import type { EntityType } from "../types";
import type { RegistryManager } from "./RegistryManager";

export class RegisterEntityModal extends Modal {
  private registry: RegistryManager;
  private llmEnabled: boolean;

  constructor(app: App, registry: RegistryManager, llmEnabled = false) {
    super(app);
    this.registry = registry;
    this.llmEnabled = llmEnabled;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Register Entity" });

    let nameValue = "";
    let aliasesValue = "";
    let typeValue: EntityType = "character";
    let llmOptIn: boolean | undefined = undefined; // undefined = follow global setting

    new Setting(contentEl)
      .setName("Name")
      .setDesc("The primary name Chronicle will search for in your scenes.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. Elena")
          .onChange((val) => {
            nameValue = val.trim();
          });
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

    // Only show the LLM opt-in toggle when Tier 2 is globally enabled
    if (this.llmEnabled) {
      new Setting(contentEl)
        .setName("LLM extraction (Tier 2)")
        .setDesc(
          "Include this entity in Tier 2 LLM extraction runs. Leave on to follow the global setting."
        )
        .addDropdown((drop) =>
          drop
            .addOptions({
              default: "Follow global setting",
              yes: "Always include",
              no: "Exclude from LLM",
            })
            .setValue("default")
            .onChange((val) => {
              llmOptIn = val === "default" ? undefined : val === "yes";
            })
        );
    }

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

          const entry = { name: nameValue, aliases, type: typeValue } as Parameters<typeof this.registry.addEntry>[0];
          if (typeof llmOptIn === "boolean") entry.llmOptIn = llmOptIn;

          try {
            await this.registry.addEntry(entry);
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
