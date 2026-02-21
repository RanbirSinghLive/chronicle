import { App, PluginSettingTab, Setting } from "obsidian";
import type ChroniclePlugin from "./main";

export class ChronicleSettingTab extends PluginSettingTab {
  plugin: ChroniclePlugin;

  constructor(app: App, plugin: ChroniclePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Chronicle" });

    // ── Section 1: Vault Structure ───────────────────────────────────────────

    containerEl.createEl("h3", {
      text: "Vault Structure",
      cls: "chronicle-settings-heading",
    });

    new Setting(containerEl)
      .setName("Bible folder path")
      .setDesc(
        "Where Chronicle stores generated bible notes. Relative to vault root."
      )
      .addText((text) =>
        text
          .setPlaceholder("_chronicle/bible")
          .setValue(this.plugin.settings.bibleFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.bibleFolderPath = value.trim() || "_chronicle/bible";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Registry path")
      .setDesc("Path to the entity registry file. Relative to vault root.")
      .addText((text) =>
        text
          .setPlaceholder("_chronicle/registry.md")
          .setValue(this.plugin.settings.registryPath)
          .onChange(async (value) => {
            this.plugin.settings.registryPath = value.trim() || "_chronicle/registry.md";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Scene folders")
      .setDesc(
        "Restrict extraction to these folders (comma-separated). Leave empty to scan all folders."
      )
      .addText((text) =>
        text
          .setPlaceholder("scenes, chapters/act1")
          .setValue(this.plugin.settings.sceneFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.sceneFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Section 2: Extraction Behaviour ─────────────────────────────────────

    containerEl.createEl("h3", {
      text: "Extraction Behaviour",
      cls: "chronicle-settings-heading",
    });

    new Setting(containerEl)
      .setName("Scan on save")
      .setDesc(
        "Run extraction automatically when a scene file is saved. Disable for large vaults if performance is an issue."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.scanOnSave)
          .onChange(async (value) => {
            this.plugin.settings.scanOnSave = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Extraction window")
      .setDesc(
        "How many paragraphs around an entity mention to scan for attributes. Default: 1."
      )
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.extractionWindow))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.extractionWindow = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Absence warning threshold")
      .setDesc(
        "Number of consecutive scenes without an appearance before an absence flag is raised. Default: 5."
      )
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.absenceWarningThreshold))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.absenceWarningThreshold = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── Section 3: LLM Extraction ────────────────────────────────────────────

    containerEl.createEl("h3", {
      text: "LLM Extraction (Tier 2)",
      cls: "chronicle-settings-heading",
    });

    // Container for the LLM sub-settings — shown/hidden based on the toggle
    const llmSection = containerEl.createDiv();
    llmSection.style.display = this.plugin.settings.llmEnabled ? "" : "none";

    // Ollama-specific settings — shown only when provider is "ollama"
    let ollamaSettingEl: HTMLElement | null = null;
    let ollamaModelSettingEl: HTMLElement | null = null;

    new Setting(containerEl)
      .setName("Enable LLM extraction")
      .setDesc(
        "Use a language model for richer extraction (emotional state, relationships, arbitrary attributes). Requires an API key or local Ollama instance."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.llmEnabled)
          .onChange(async (value) => {
            this.plugin.settings.llmEnabled = value;
            llmSection.style.display = value ? "" : "none";
            await this.plugin.saveSettings();
          })
      );

    new Setting(llmSection)
      .setName("LLM provider")
      .setDesc("Which AI provider to use for Tier 2 extraction.")
      .addDropdown((drop) =>
        drop
          .addOptions({
            anthropic: "Anthropic (Claude) — recommended",
            openai: "OpenAI",
            ollama: "Ollama (local)",
          })
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (value) => {
            this.plugin.settings.llmProvider = value as "anthropic" | "openai" | "ollama";
            const showOllama = value === "ollama" ? "" : "none";
            if (ollamaSettingEl) ollamaSettingEl.style.display = showOllama;
            if (ollamaModelSettingEl) ollamaModelSettingEl.style.display = showOllama;
            await this.plugin.saveSettings();
          })
      );

    new Setting(llmSection)
      .setName("API key")
      .setDesc(
        "Your Anthropic or OpenAI API key. Stored locally in your vault's plugin data — never sent anywhere except your chosen provider."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value;
            await this.plugin.saveSettings();
          });
      });

    const ollamaSetting = new Setting(llmSection)
      .setName("Ollama endpoint")
      .setDesc("URL of your local Ollama server.")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.ollamaEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.ollamaEndpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    const ollamaModelSetting = new Setting(llmSection)
      .setName("Ollama model")
      .setDesc("Name of the Ollama model to use (e.g. llama3.2, mistral, phi3).")
      .addText((text) =>
        text
          .setPlaceholder("llama3.2")
          .setValue(this.plugin.settings.ollamaModel)
          .onChange(async (value) => {
            this.plugin.settings.ollamaModel = value.trim() || "llama3.2";
            await this.plugin.saveSettings();
          })
      );

    ollamaSettingEl = ollamaSetting.settingEl;
    ollamaModelSettingEl = ollamaModelSetting.settingEl;
    const isOllama = this.plugin.settings.llmProvider === "ollama";
    ollamaSettingEl.style.display = isOllama ? "" : "none";
    ollamaModelSettingEl.style.display = isOllama ? "" : "none";

    // ── Section 4: Integration ───────────────────────────────────────────────

    containerEl.createEl("h3", {
      text: "Integration",
      cls: "chronicle-settings-heading",
    });

    new Setting(containerEl)
      .setName("Longform compile integration")
      .setDesc(
        "Run a Chronicle scan before Longform compiles your manuscript and surface any unresolved hard conflicts."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.compileIntegration)
          .onChange(async (value) => {
            this.plugin.settings.compileIntegration = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Section 5: Conflict Display ──────────────────────────────────────────

    containerEl.createEl("h3", {
      text: "Conflict Display",
      cls: "chronicle-settings-heading",
    });

    new Setting(containerEl)
      .setName("Show conflict gutter")
      .setDesc(
        "Display conflict markers in the editor gutter, similar to code linting indicators."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.conflictGutter)
          .onChange(async (value) => {
            this.plugin.settings.conflictGutter = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Hard conflict colour")
      .setDesc("Gutter icon colour for direct attribute contradictions.")
      .addDropdown((drop) =>
        drop
          .addOptions({ red: "Red", orange: "Orange", purple: "Purple" })
          .setValue(this.plugin.settings.hardConflictColour)
          .onChange(async (value) => {
            this.plugin.settings.hardConflictColour = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Soft conflict colour")
      .setDesc("Gutter icon colour for differing-but-not-contradictory descriptions.")
      .addDropdown((drop) =>
        drop
          .addOptions({ yellow: "Yellow", blue: "Blue", green: "Green" })
          .setValue(this.plugin.settings.softConflictColour)
          .onChange(async (value) => {
            this.plugin.settings.softConflictColour = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
