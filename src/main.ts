import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { ChronicleSettings, DEFAULT_SETTINGS } from "./types";
import type { ConflictRecord } from "./types";
import { ChronicleSettingTab } from "./settings";
import { RegistryManager } from "./registry/RegistryManager";
import { RegisterEntityModal } from "./registry/RegisterEntityModal";
import { BibleManager } from "./bible/BibleManager";
import { EntitySuggestModal } from "./bible/EntitySuggestModal";
import { ExtractionEngine } from "./extraction/ExtractionEngine";
import { ScanResultModal } from "./extraction/ScanResultModal";
import { ConflictManager } from "./conflict/ConflictManager";
import { ConflictLogModal } from "./conflict/ConflictLogModal";
import { ConflictModal } from "./conflict/ConflictModal";
import { buildGutterExtension, dispatchConflicts } from "./conflict/GutterExtension";
import { PresenceAnalyzer } from "./matrix/PresenceAnalyzer";
import { PresenceMatrixView, MATRIX_VIEW_TYPE } from "./matrix/PresenceMatrixView";
import { TimelineAnalyzer } from "./timeline/TimelineAnalyzer";
import { TimelineView, TIMELINE_VIEW_TYPE } from "./timeline/TimelineView";
import { SetAnchorModal } from "./timeline/SetAnchorModal";
import { AutoSetupModal } from "./autosetup/AutoSetupModal";

export default class ChroniclePlugin extends Plugin {
  settings: ChronicleSettings;
  registry: RegistryManager;
  bible: BibleManager;
  conflictManager: ConflictManager;
  extraction: ExtractionEngine;
  presenceAnalyzer: PresenceAnalyzer;
  timelineAnalyzer: TimelineAnalyzer;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registry = new RegistryManager(this.app, this.settings);
    this.bible = new BibleManager(this.app, this.settings);
    this.conflictManager = new ConflictManager(this.app, this.settings);

    // Ensure vault structure exists silently on load
    await this.registry.ensureRegistryExists();
    await this.conflictManager.ensureConflictLogExists();

    // Extraction engine (now includes ConflictManager)
    this.extraction = new ExtractionEngine(
      this.app,
      this.settings,
      this.registry,
      this.bible,
      this.conflictManager
    );

    // Presence matrix analyser
    this.presenceAnalyzer = new PresenceAnalyzer(
      this.app,
      this.settings,
      this.registry,
      this.bible
    );

    // Timeline analyser
    this.timelineAnalyzer = new TimelineAnalyzer(this.app, this.settings);

    // Register the presence matrix leaf view
    this.registerView(
      MATRIX_VIEW_TYPE,
      (leaf) => new PresenceMatrixView(leaf, this.presenceAnalyzer, this.settings)
    );

    // Register the timeline leaf view
    this.registerView(
      TIMELINE_VIEW_TYPE,
      (leaf) =>
        new TimelineView(
          leaf,
          this.timelineAnalyzer,
          this.settings,
          (filePath: string) => {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
              new SetAnchorModal(this.app, file).open();
            }
          }
        )
    );

    // CM6 gutter extension for conflict markers
    if (this.settings.conflictGutter) {
      this.registerEditorExtension(
        buildGutterExtension(
          this.settings.hardConflictColour,
          this.settings.softConflictColour,
          (record: ConflictRecord) => {
            new ConflictModal(
              this.app,
              record,
              this.conflictManager,
              this.bible,
              () => this.refreshGutterForActiveEditor()
            ).open();
          }
        )
      );
    }

    // Settings tab
    this.addSettingTab(new ChronicleSettingTab(this.app, this));

    // Ribbon icon — quick access to the registry
    this.addRibbonIcon("book-open", "Chronicle: Open registry", () => {
      this.registry.openInEditor();
    });

    // ── Commands ──────────────────────────────────────────────────────────────

    this.addCommand({
      id: "register-entity",
      name: "Register new entity",
      callback: () => {
        new RegisterEntityModal(this.app, this.registry, this.settings.llmEnabled).open();
      },
    });

    this.addCommand({
      id: "open-registry",
      name: "Open entity registry",
      callback: async () => {
        await this.registry.openInEditor();
      },
    });

    this.addCommand({
      id: "create-bible-note",
      name: "Create bible note for entity",
      callback: async () => {
        const entries = await this.registry.loadEntries();
        if (entries.length === 0) {
          new Notice(
            "Chronicle: No entities in registry. Use 'Register new entity' first."
          );
          return;
        }
        new EntitySuggestModal(this.app, entries, async (entry) => {
          const created = await this.bible.createBibleNote(entry);
          if (created) {
            new Notice(`Chronicle: Created bible note for "${entry.name}".`);
            const path = this.bible.bibleNotePath(entry.name);
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              await this.app.workspace.getLeaf(false).openFile(file);
            }
          } else {
            new Notice(
              `Chronicle: Bible note for "${entry.name}" already exists.`
            );
          }
        }).open();
      },
    });

    this.addCommand({
      id: "create-all-bible-notes",
      name: "Create bible notes for all registry entries",
      callback: async () => {
        const entries = await this.registry.loadEntries();
        if (entries.length === 0) {
          new Notice("Chronicle: No entities in registry.");
          return;
        }
        const { created, skipped } = await this.bible.createAllBibleNotes(entries);
        const createdStr = `${created} note${created !== 1 ? "s" : ""} created`;
        const skippedStr = skipped > 0 ? `, ${skipped} already existed` : "";
        new Notice(`Chronicle: ${createdStr}${skippedStr}.`, 4000);
      },
    });

    // ── Extraction commands ────────────────────────────────────────────────────

    this.addCommand({
      id: "full-scan",
      name: "Full scan (all scenes)",
      callback: async () => {
        new Notice("Chronicle: Scanning…");
        const result = await this.extraction.fullScan();
        new ScanResultModal(this.app, result).open();
      },
    });

    // ── Conflict commands ──────────────────────────────────────────────────────

    this.addCommand({
      id: "view-conflict-log",
      name: "View conflict log",
      callback: () => {
        new ConflictLogModal(this.app, this.conflictManager, this.bible).open();
      },
    });

    // ── Presence Matrix ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-presence-matrix",
      name: "Open presence matrix",
      callback: async () => {
        const existing = this.app.workspace.getLeavesOfType(MATRIX_VIEW_TYPE);
        if (existing.length > 0) {
          this.app.workspace.revealLeaf(existing[0]);
        } else {
          const leaf = this.app.workspace.getLeaf("tab");
          await leaf.setViewState({ type: MATRIX_VIEW_TYPE, active: true });
          this.app.workspace.revealLeaf(leaf);
        }
      },
    });

    // ── Timeline Sidebar ───────────────────────────────────────────────────────

    this.addCommand({
      id: "open-timeline",
      name: "Open timeline sidebar",
      callback: async () => {
        const existing = this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
        if (existing.length > 0) {
          this.app.workspace.revealLeaf(existing[0]);
        } else {
          const leaf = this.app.workspace.getRightLeaf(false);
          if (leaf) {
            await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
            this.app.workspace.revealLeaf(leaf);
          }
        }
      },
    });

    this.addCommand({
      id: "set-scene-anchor",
      name: "Set scene time anchor",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          new Notice("Chronicle: Open a scene file first.");
          return;
        }
        new SetAnchorModal(this.app, view.file).open();
      },
    });

    this.addCommand({
      id: "auto-setup-from-draft",
      name: "Auto-setup from draft",
      callback: () => {
        if (!this.settings.llmEnabled) {
          new Notice("Chronicle: Enable LLM extraction in settings to use Auto-setup.");
          return;
        }
        new AutoSetupModal(
          this.app,
          this.settings,
          this.registry,
          this.bible,
          this.extraction
        ).open();
      },
    });

    // ── Gutter refresh on tab switch ──────────────────────────────────────────
    // Each editor's conflictStateField starts at [] when the EditorView is
    // first created (e.g. after a tab is closed and reopened). Re-dispatch
    // whenever the user switches to a file that has active conflicts.

    if (this.settings.conflictGutter) {
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", async (leaf) => {
          const view = leaf?.view;
          if (!(view instanceof MarkdownView) || !view.file) return;
          const filePath = view.file.path;
          const allActive = await this.conflictManager.getActiveConflicts();
          const fileConflicts = allActive.filter((c) => c.newScene === filePath);
          if (fileConflicts.length > 0) {
            // Small delay so the EditorView is fully mounted before dispatch.
            setTimeout(() => this.dispatchConflictsToFile(filePath, fileConflicts), 50);
          }
        })
      );
    }

    // ── On-save extraction listener ───────────────────────────────────────────

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (
          !this.settings.scanOnSave ||
          !(file instanceof TFile) ||
          file.extension !== "md"
        ) {
          return;
        }

        // Skip Chronicle's own generated files — they're not scene files and
        // their writes (conflicts.md, bible notes) would otherwise re-trigger
        // an extraction scan and reset the debounce timer.
        const chronicleDir = this.settings.registryPath.substring(
          0, this.settings.registryPath.lastIndexOf("/")
        );
        if (chronicleDir && file.path.startsWith(chronicleDir + "/")) return;

        if (debounceTimer !== null) clearTimeout(debounceTimer);

        debounceTimer = setTimeout(async () => {
          debounceTimer = null;
          try {
            const result = await this.extraction.scanFile(file);

            // Dispatch updated conflicts to the gutter for this specific file
            if (this.settings.conflictGutter) {
              const allActive = await this.conflictManager.getActiveConflicts();
              const fileConflicts = allActive.filter((c) => c.newScene === file.path);
              console.log(
                `Chronicle gutter: file=${file.path} ` +
                `fileConflicts=${fileConflicts.length} allActive=${allActive.length}`
              );
              this.dispatchConflictsToFile(file.path, fileConflicts);
            }

            if (result.entities.length === 0 && result.conflicts.length === 0) return;

            const changeParts = result.entities.flatMap((e) =>
              e.changes.map((c) =>
                c.newValue === null
                  ? `${e.entityName} ← ${c.attribute}: cleared`
                  : `${e.entityName} ← ${c.attribute}: ${c.newValue}`
              )
            );

            const conflictParts = result.conflicts.map(
              (c) => `⚠ ${c.entity}: ${c.attribute} conflict`
            );

            const parts = [...changeParts, ...conflictParts];
            if (parts.length === 0) return;

            const display = parts.slice(0, 3);
            if (parts.length > 3) display.push(`…and ${parts.length - 3} more`);
            new Notice(`Chronicle: ${display.join(", ")}`, 4000);
          } catch (err) {
            console.error("Chronicle: extraction error", err);
          }
        }, 800);
      })
    );

    console.log("Chronicle loaded.");
  }

  onunload(): void {
    console.log("Chronicle unloaded.");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Dispatch a filtered conflict list to all open editors for `filePath`.
   * Only conflicts whose `newScene === filePath` should be included.
   */
  private dispatchConflictsToFile(filePath: string, fileConflicts: ConflictRecord[]): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.file?.path !== filePath) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const editorView = (view.editor as any).cm as EditorView | undefined;
      if (editorView) {
        console.log(`Chronicle gutter: dispatching ${fileConflicts.length} conflicts`);
        dispatchConflicts(editorView, fileConflicts);
      } else {
        console.warn("Chronicle gutter: editor.cm is undefined for", filePath);
      }
    });
  }

  private async refreshGutterForActiveEditor(): Promise<void> {
    if (!this.settings.conflictGutter) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;
    const allConflicts = await this.conflictManager.getActiveConflicts();
    const fileConflicts = allConflicts.filter((c) => c.newScene === view.file!.path);
    this.dispatchConflictsToFile(view.file.path, fileConflicts);
  }
}
