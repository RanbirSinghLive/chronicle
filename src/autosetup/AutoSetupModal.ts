import { App, Modal, Notice, TFile } from "obsidian";
import type { ChronicleSettings, RegistryEntry } from "../types";
import type { RegistryManager } from "../registry/RegistryManager";
import type { BibleManager } from "../bible/BibleManager";
import type { ExtractionEngine } from "../extraction/ExtractionEngine";
import { stripFrontmatter, setFrontmatterKey } from "../utils/vault";
import {
  EntityDiscoveryClient,
  DiscoveredEntity,
  ScenePosition,
} from "./EntityDiscoveryClient";
import { MATRIX_VIEW_TYPE } from "../matrix/PresenceMatrixView";
import { TIMELINE_VIEW_TYPE } from "../timeline/TimelineView";

type Step =
  | "options"
  | "discovery"
  | "confirmation"
  | "setup"
  | "timeline-confirm"
  | "complete";

interface FileResult {
  filePath: string;
  entities: DiscoveredEntity[];
  error?: string;
}

interface ModalState {
  step: Step;
  doTimeline: boolean;
  sceneFiles: TFile[];
  existingEntries: RegistryEntry[];
  fileResults: FileResult[];
  merged: DiscoveredEntity[];
  approved: Set<number>;
  setupSummary: string;
  positionResults: ScenePosition[];
  errors: string[];
}

export class AutoSetupModal extends Modal {
  private state: ModalState;
  private discovery: EntityDiscoveryClient;

  constructor(
    app: App,
    private settings: ChronicleSettings,
    private registry: RegistryManager,
    private bible: BibleManager,
    private extraction: ExtractionEngine
  ) {
    super(app);
    this.discovery = new EntityDiscoveryClient(settings);
    this.state = {
      step: "options",
      doTimeline: false,
      sceneFiles: [],
      existingEntries: [],
      fileResults: [],
      merged: [],
      approved: new Set(),
      setupSummary: "",
      positionResults: [],
      errors: [],
    };
  }

  onOpen(): void {
    this.renderStep();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── Step rendering ──────────────────────────────────────────────────────────

  private renderStep(): void {
    const { contentEl } = this;
    contentEl.empty();

    switch (this.state.step) {
      case "options":
        this.renderOptions();
        break;
      case "discovery":
        this.renderDiscovery();
        break;
      case "confirmation":
        this.renderConfirmation();
        break;
      case "setup":
        this.renderSetup();
        break;
      case "timeline-confirm":
        this.renderTimelineConfirm();
        break;
      case "complete":
        this.renderComplete();
        break;
    }
  }

  // ── Step 1: Options ─────────────────────────────────────────────────────────

  private renderOptions(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Auto-Setup from Draft" });
    contentEl.createEl("p", {
      text: "Chronicle will scan your scene files, discover entities, register them, create bible notes, and run a full scan.",
      cls: "chronicle-modal-desc",
    });

    // Timeline opt-in
    const timelineRow = contentEl.createDiv({ cls: "chronicle-autosetup-option-row" });
    const timelineCheck = timelineRow.createEl("input", { type: "checkbox" });
    timelineCheck.id = "chronicle-autosetup-timeline";
    timelineCheck.checked = this.state.doTimeline;
    timelineCheck.addEventListener("change", () => {
      this.state.doTimeline = timelineCheck.checked;
    });
    const timelineLabel = timelineRow.createEl("label");
    timelineLabel.htmlFor = "chronicle-autosetup-timeline";
    timelineLabel.setText("Also assign story-time positions for the timeline");

    const btnRow = contentEl.createDiv({ cls: "chronicle-autosetup-btn-row" });
    const startBtn = btnRow.createEl("button", {
      text: "Start Discovery →",
      cls: "mod-cta",
    });
    startBtn.addEventListener("click", () => void this.beginDiscovery());
  }

  private async beginDiscovery(): Promise<void> {
    this.state.existingEntries = await this.registry.loadEntries();
    this.state.sceneFiles = this.collectSceneFiles();
    this.state.fileResults = [];
    this.state.errors = [];

    if (this.state.sceneFiles.length === 0) {
      new Notice("Chronicle: No scene files found.");
      this.close();
      return;
    }

    this.state.step = "discovery";
    this.renderStep();
    void this.runDiscovery();
  }

  // ── Step 2: Discovery progress ──────────────────────────────────────────────

  private renderDiscovery(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Discovering Entities…" });
    const total = this.state.sceneFiles.length;
    contentEl.createEl("p", {
      text: `Scanning ${total} scene file${total !== 1 ? "s" : ""}…`,
    });
    contentEl.createEl("p", { cls: "chronicle-autosetup-progress", attr: { id: "chronicle-discovery-progress" } });
  }

  private async runDiscovery(): Promise<void> {
    const excludeNames = this.state.existingEntries.flatMap((e) => [
      e.name,
      ...e.aliases,
    ]);

    const progressEl = document.getElementById("chronicle-discovery-progress");

    for (let i = 0; i < this.state.sceneFiles.length; i++) {
      const file = this.state.sceneFiles[i];
      if (progressEl) {
        progressEl.textContent = `Scene ${i + 1} of ${this.state.sceneFiles.length}: ${file.basename}`;
      }

      try {
        const content = await this.app.vault.read(file);
        const body = stripFrontmatter(content);
        const entities = await this.discovery.discoverEntities(
          body,
          file.path,
          excludeNames
        );
        this.state.fileResults.push({ filePath: file.path, entities });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.fileResults.push({ filePath: file.path, entities: [], error: msg });
        this.state.errors.push(`${file.basename}: ${msg}`);
      }
    }

    this.state.merged = this.deduplicateEntities(
      this.state.fileResults,
      this.state.existingEntries
    );

    // Default-approve high + medium confidence
    this.state.approved = new Set(
      this.state.merged
        .map((_, i) => i)
        .filter((i) => this.state.merged[i].confidence !== "low")
    );

    this.state.step = "confirmation";
    this.renderStep();
  }

  // ── Step 3: Confirmation table ──────────────────────────────────────────────

  private renderConfirmation(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Review Discovered Entities" });

    if (this.state.merged.length === 0) {
      contentEl.createEl("p", {
        text: "No new entities discovered. All entities may already be registered.",
      });
      const btnRow = contentEl.createDiv({ cls: "chronicle-autosetup-btn-row" });
      const doneBtn = btnRow.createEl("button", { text: "Done" });
      doneBtn.addEventListener("click", () => this.close());
      return;
    }

    contentEl.createEl("p", {
      text: "Review and edit the discovered entities. Uncheck any you don't want to register.",
      cls: "chronicle-modal-desc",
    });

    const table = contentEl.createEl("table", { cls: "chronicle-autosetup-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    ["", "Name", "Type", "Confidence", "Aliases", "Reason"].forEach((h) =>
      headerRow.createEl("th", { text: h })
    );

    const tbody = table.createEl("tbody");
    const nameInputs: HTMLInputElement[] = [];
    const aliasInputs: HTMLInputElement[] = [];

    this.state.merged.forEach((entity, i) => {
      const row = tbody.createEl("tr");

      // Checkbox
      const checkTd = row.createEl("td");
      const checkbox = checkTd.createEl("input", { type: "checkbox" });
      checkbox.checked = this.state.approved.has(i);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.state.approved.add(i);
        } else {
          this.state.approved.delete(i);
        }
        updateRegisterBtn();
      });

      // Name (editable)
      const nameTd = row.createEl("td");
      const nameInput = nameTd.createEl("input", { type: "text", value: entity.name });
      nameInput.addClass("chronicle-autosetup-name-input");
      nameInput.addEventListener("change", () => {
        this.state.merged[i].name = nameInput.value.trim();
      });
      nameInputs.push(nameInput);

      // Type (dropdown)
      const typeTd = row.createEl("td");
      const typeSelect = typeTd.createEl("select");
      ["character", "location", "object", "faction"].forEach((t) => {
        const opt = typeSelect.createEl("option", { value: t, text: t });
        if (t === entity.type) opt.selected = true;
      });
      typeSelect.addEventListener("change", () => {
        this.state.merged[i].type = typeSelect.value as DiscoveredEntity["type"];
      });

      // Confidence badge
      const confTd = row.createEl("td");
      confTd.createEl("span", {
        text: entity.confidence,
        cls: `chronicle-confidence-${entity.confidence}`,
      });

      // Aliases (editable)
      const aliasesTd = row.createEl("td");
      const aliasInput = aliasesTd.createEl("input", {
        type: "text",
        value: entity.aliases.join(", "),
      });
      aliasInput.addClass("chronicle-autosetup-alias-input");
      aliasInput.setAttribute("placeholder", "comma-separated");
      aliasInput.addEventListener("change", () => {
        this.state.merged[i].aliases = aliasInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      });
      aliasInputs.push(aliasInput);

      // Reason
      row.createEl("td", { text: entity.reason, cls: "chronicle-autosetup-reason" });
    });

    // Register button
    const btnRow = contentEl.createDiv({ cls: "chronicle-autosetup-btn-row" });
    const warningEl = btnRow.createEl("span", { cls: "chronicle-autosetup-warning" });

    const registerBtn = btnRow.createEl("button", { cls: "mod-cta" });
    const updateRegisterBtn = () => {
      const count = this.state.approved.size;
      registerBtn.textContent = `Register ${count} ${count === 1 ? "entity" : "entities"} →`;
      registerBtn.disabled = count === 0;
      warningEl.textContent = count === 0 ? "Select at least one entity." : "";
    };
    updateRegisterBtn();

    registerBtn.addEventListener("click", () => {
      this.state.step = "setup";
      this.renderStep();
      void this.runSetup();
    });

    const backBtn = btnRow.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.state.fileResults = [];
      this.state.merged = [];
      this.state.approved = new Set();
      this.state.step = "options";
      this.renderStep();
    });
  }

  // ── Step 4: Setup progress ──────────────────────────────────────────────────

  private renderSetup(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Setting Up Chronicle…" });

    const makeStatus = (label: string, id: string) => {
      const row = contentEl.createDiv({ cls: "chronicle-autosetup-status-row" });
      row.createEl("span", { text: label });
      row.createEl("span", { text: "↻ In progress…", attr: { id }, cls: "chronicle-autosetup-status-pending" });
    };

    makeStatus("1. Registering entities", "chronicle-setup-status-1");
    makeStatus("2. Creating bible notes", "chronicle-setup-status-2");
    makeStatus("3. Running full scan", "chronicle-setup-status-3");
  }

  private setStatus(id: string, text: string, done: boolean): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = done
      ? "chronicle-autosetup-status-done"
      : "chronicle-autosetup-status-error";
  }

  private async runSetup(): Promise<void> {
    const approvedEntities = Array.from(this.state.approved).map(
      (i) => this.state.merged[i]
    );
    let registered = 0;

    // 1. Register entities
    for (const entity of approvedEntities) {
      try {
        await this.registry.addEntry({
          name: entity.name,
          aliases: entity.aliases,
          type: entity.type,
        });
        registered++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Silently skip duplicates; log other errors
        if (!msg.includes("already in the registry")) {
          this.state.errors.push(`Register "${entity.name}": ${msg}`);
        }
      }
    }
    this.setStatus("chronicle-setup-status-1", `✓ Done (${registered} registered)`, true);

    // 2. Create bible notes
    try {
      const allEntries = await this.registry.loadEntries();
      const { created } = await this.bible.createAllBibleNotes(allEntries);
      this.setStatus("chronicle-setup-status-2", `✓ Done (${created} note${created !== 1 ? "s" : ""} created)`, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.errors.push(`Bible notes: ${msg}`);
      this.setStatus("chronicle-setup-status-2", "✗ Failed", false);
    }

    // 3. Full scan
    try {
      const result = await this.extraction.fullScan();
      const entityCount = result.entities.length;
      const conflictCount = result.conflicts.length;
      this.setStatus(
        "chronicle-setup-status-3",
        `✓ Done (${entityCount} ${entityCount === 1 ? "entity" : "entities"} updated, ${conflictCount} conflict${conflictCount !== 1 ? "s" : ""})`,
        true
      );
      this.state.setupSummary = `Registered ${registered} ${registered === 1 ? "entity" : "entities"}, created bible notes, scanned ${result.scannedPaths.length} scenes.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.errors.push(`Full scan: ${msg}`);
      this.setStatus("chronicle-setup-status-3", "✗ Failed", false);
      this.state.setupSummary = `Registered ${registered} ${registered === 1 ? "entity" : "entities"}.`;
    }

    setTimeout(() => {
      this.state.step = this.state.doTimeline ? "timeline-confirm" : "complete";
      this.renderStep();
    }, 600);
  }

  // ── Step 5: Timeline confirm ────────────────────────────────────────────────

  private renderTimelineConfirm(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Assign Story-Time Positions?" });
    contentEl.createEl("p", {
      text: "Chronicle can ask the LLM to assign a story-time position to each scene based on textual evidence. This only modifies YAML frontmatter — it never touches your prose.",
      cls: "chronicle-modal-desc",
    });
    contentEl.createEl("p", {
      text: "You can always adjust positions manually using the \"Set scene time anchor\" command.",
      cls: "chronicle-modal-desc",
    });

    const btnRow = contentEl.createDiv({ cls: "chronicle-autosetup-btn-row" });

    const assignBtn = btnRow.createEl("button", {
      text: "Assign Positions →",
      cls: "mod-cta",
    });
    assignBtn.addEventListener("click", () => {
      this.state.step = "complete"; // will transition after
      this.renderTimelineProgress();
      void this.runTimelinePositioning();
    });

    const skipBtn = btnRow.createEl("button", { text: "Skip" });
    skipBtn.addEventListener("click", () => {
      this.state.step = "complete";
      this.renderStep();
    });
  }

  private renderTimelineProgress(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Assigning Timeline Positions…" });
    contentEl.createEl("p", {
      cls: "chronicle-autosetup-progress",
      attr: { id: "chronicle-timeline-progress" },
      text: "Preparing scenes…",
    });
  }

  private async runTimelinePositioning(): Promise<void> {
    const updateProgress = (text: string) => {
      const el = document.getElementById("chronicle-timeline-progress");
      if (el) el.textContent = text;
    };

    // Build 300-word excerpts
    const scenes: Array<{ filePath: string; excerpt: string }> = [];
    const knownPositions: Record<string, number> = {};

    for (const file of this.state.sceneFiles) {
      try {
        const content = await this.app.vault.read(file);

        // Check for existing anchor
        const anchorMatch = content.match(/^chronicle-anchor:\s*([\d.]+)/m);
        if (anchorMatch) {
          knownPositions[file.path] = parseFloat(anchorMatch[1]);
        }

        const body = stripFrontmatter(content);
        const words = body.split(/\s+/).filter(Boolean);
        const excerpt = words.slice(0, 300).join(" ");
        scenes.push({ filePath: file.path, excerpt });
      } catch {
        // Skip unreadable files
      }
    }

    updateProgress(`Asking LLM to position ${scenes.length} scenes…`);

    try {
      this.state.positionResults = await this.discovery.assignTimelinePositions(
        scenes,
        knownPositions
      );

      updateProgress(`Writing positions to ${this.state.positionResults.length} scenes…`);

      let written = 0;
      for (const pos of this.state.positionResults) {
        const file = this.app.vault.getAbstractFileByPath(pos.filePath);
        if (!(file instanceof TFile)) continue;
        try {
          const content = await this.app.vault.read(file);
          await this.app.vault.modify(
            file,
            setFrontmatterKey(content, "chronicle-anchor", pos.position)
          );
          written++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.state.errors.push(`Timeline write "${pos.filePath}": ${msg}`);
        }
      }

      this.state.setupSummary +=
        ` Assigned story-time positions to ${written} scene${written !== 1 ? "s" : ""}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.errors.push(`Timeline positioning: ${msg}`);
    }

    this.state.step = "complete";
    this.renderStep();
  }

  // ── Step 6: Complete ────────────────────────────────────────────────────────

  private renderComplete(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Setup Complete" });

    if (this.state.setupSummary) {
      contentEl.createEl("p", { text: this.state.setupSummary });
    }

    if (this.state.errors.length > 0) {
      const details = contentEl.createEl("details");
      details.createEl("summary", {
        text: `${this.state.errors.length} warning${this.state.errors.length !== 1 ? "s" : ""}`,
        cls: "chronicle-autosetup-warning",
      });
      const ul = details.createEl("ul");
      for (const err of this.state.errors) {
        ul.createEl("li", { text: err });
      }
    }

    const btnRow = contentEl.createDiv({ cls: "chronicle-autosetup-btn-row" });

    const matrixBtn = btnRow.createEl("button", { text: "Open Presence Matrix" });
    matrixBtn.addEventListener("click", () => void this.openView(MATRIX_VIEW_TYPE, false));

    const timelineBtn = btnRow.createEl("button", { text: "Open Timeline" });
    timelineBtn.addEventListener("click", () => void this.openView(TIMELINE_VIEW_TYPE, true));

    const doneBtn = btnRow.createEl("button", { text: "Done", cls: "mod-cta" });
    doneBtn.addEventListener("click", () => this.close());
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private collectSceneFiles(): TFile[] {
    const { bibleFolderPath, registryPath, sceneFolders } = this.settings;
    const biblePath = bibleFolderPath.replace(/\/$/, "");
    const registryDir = registryPath.substring(0, registryPath.lastIndexOf("/"));

    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => {
        if (f.path.startsWith(biblePath + "/")) return false;
        if (registryDir && f.path.startsWith(registryDir + "/")) return false;
        if (sceneFolders.length === 0) return true;
        return sceneFolders.some((folder) =>
          f.path.startsWith(folder.replace(/\/$/, "") + "/")
        );
      })
      .sort((a, b) => a.stat.mtime - b.stat.mtime);
  }

  private deduplicateEntities(
    fileResults: FileResult[],
    existingEntries: RegistryEntry[]
  ): DiscoveredEntity[] {
    const existingNames = new Set(
      existingEntries.flatMap((e) => [
        e.name.toLowerCase(),
        ...e.aliases.map((a) => a.toLowerCase()),
      ])
    );

    // Merge by canonical name (case-insensitive) + alias overlap
    const merged = new Map<string, DiscoveredEntity>();

    for (const { entities } of fileResults) {
      for (const entity of entities) {
        const key = entity.name.toLowerCase();

        // Skip if already registered
        if (existingNames.has(key)) continue;
        if (entity.aliases.some((a) => existingNames.has(a.toLowerCase()))) continue;

        if (merged.has(key)) {
          const existing = merged.get(key)!;
          // Upgrade confidence if higher
          const order = { high: 2, medium: 1, low: 0 };
          if (order[entity.confidence] > order[existing.confidence]) {
            existing.confidence = entity.confidence;
          }
          // Union aliases
          const aliasSet = new Set([
            ...existing.aliases.map((a) => a.toLowerCase()),
          ]);
          for (const alias of entity.aliases) {
            if (!aliasSet.has(alias.toLowerCase())) {
              existing.aliases.push(alias);
              aliasSet.add(alias.toLowerCase());
            }
          }
        } else {
          merged.set(key, { ...entity, aliases: [...entity.aliases] });
        }
      }
    }

    const TYPE_ORDER = { character: 0, location: 1, object: 2, faction: 3 };
    const CONF_ORDER = { high: 0, medium: 1, low: 2 };

    return Array.from(merged.values()).sort((a, b) => {
      const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      if (typeDiff !== 0) return typeDiff;
      return CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence];
    });
  }

  private async openView(viewType: string, sidebar: boolean): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(viewType);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
    } else {
      const leaf = sidebar
        ? this.app.workspace.getRightLeaf(false)
        : this.app.workspace.getLeaf("tab");
      if (leaf) {
        await leaf.setViewState({ type: viewType, active: true });
        this.app.workspace.revealLeaf(leaf);
      }
    }
  }
}
