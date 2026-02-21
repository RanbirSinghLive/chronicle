import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { CellPresence, ChronicleSettings, PresenceMatrix } from "../types";
import type { PresenceAnalyzer } from "./PresenceAnalyzer";

export const MATRIX_VIEW_TYPE = "chronicle-presence-matrix";

const SYMBOLS: Record<CellPresence, string> = {
  active:    "●",
  mentioned: "◦",
  pov:       "P",
  absent:    "—",
};

const LABELS: Record<CellPresence, string> = {
  active:    "active role",
  mentioned: "mentioned",
  pov:       "POV",
  absent:    "absent",
};

export class PresenceMatrixView extends ItemView {
  private analyzer: PresenceAnalyzer;
  private settings: ChronicleSettings;
  private matrix: PresenceMatrix | null = null;
  private gapMode = false;

  constructor(
    leaf: WorkspaceLeaf,
    analyzer: PresenceAnalyzer,
    settings: ChronicleSettings
  ) {
    super(leaf);
    this.analyzer = analyzer;
    this.settings = settings;
  }

  getViewType(): string {
    return MATRIX_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Presence Matrix";
  }

  getIcon(): string {
    return "grid";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {
    // nothing to clean up
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chronicle-matrix-container");

    // Toolbar
    const toolbar = contentEl.createDiv({ cls: "chronicle-matrix-toolbar" });

    const refreshBtn = toolbar.createEl("button", { text: "↺ Refresh" });
    refreshBtn.addEventListener("click", () => this.refresh());

    const gapBtn = toolbar.createEl("button", {
      text: this.gapMode ? "Gap mode: ON" : "Gap mode: OFF",
      cls:  this.gapMode ? "chronicle-matrix-gap-btn-active" : "",
    });
    gapBtn.addEventListener("click", () => {
      this.gapMode = !this.gapMode;
      if (this.matrix) this.renderMatrix(this.matrix);
    });

    // Loading state
    const status = contentEl.createDiv({ cls: "chronicle-matrix-status" });
    status.setText("Building matrix…");

    this.matrix = await this.analyzer.buildMatrix();
    status.remove();

    if (this.matrix.scenes.length === 0) {
      contentEl.createDiv({ cls: "chronicle-matrix-status" }).setText(
        "No scene files found. Configure scene folders in Chronicle settings."
      );
      return;
    }
    if (this.matrix.characters.length === 0) {
      contentEl.createDiv({ cls: "chronicle-matrix-status" }).setText(
        "No character entries in the registry."
      );
      return;
    }

    this.renderMatrix(this.matrix);
  }

  private renderMatrix(matrix: PresenceMatrix): void {
    // Remove any existing table
    const existing = this.contentEl.querySelector(".chronicle-matrix-scroll");
    if (existing) existing.remove();

    const gaps = this.gapMode
      ? this.computeGaps(matrix, this.settings.absenceWarningThreshold)
      : new Set<string>();

    const scroll = this.contentEl.createDiv({ cls: "chronicle-matrix-scroll" });
    const table  = scroll.createEl("table", { cls: "chronicle-matrix-table" });

    // ── Header row ────────────────────────────────────────────────────────
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    // Top-left corner cell (scene column header)
    headerRow.createEl("th", { text: "Scene", cls: "chronicle-matrix-th-scene" });

    for (const charName of matrix.characters) {
      const th = headerRow.createEl("th", { cls: "chronicle-matrix-th-char" });
      const btn = th.createEl("button", {
        text: charName,
        cls:  "chronicle-matrix-header-btn",
        title: `Open bible note for ${charName}`,
      });
      btn.addEventListener("click", () => this.openBibleNote(charName));
    }

    // ── Body rows ─────────────────────────────────────────────────────────
    const tbody = table.createEl("tbody");

    for (let rowIdx = 0; rowIdx < matrix.scenes.length; rowIdx++) {
      const sceneRow = matrix.scenes[rowIdx];
      const tr = tbody.createEl("tr");

      // Scene label cell
      const sceneTd = tr.createEl("td", { cls: "chronicle-matrix-td-scene" });
      const sceneBtn = sceneTd.createEl("button", {
        text:  sceneRow.sceneLabel,
        cls:   "chronicle-matrix-scene-btn",
        title: sceneRow.scenePath,
      });
      sceneBtn.addEventListener("click", () => this.openScene(sceneRow.scenePath));

      // Character presence cells
      for (const charName of matrix.characters) {
        const cell      = sceneRow.cells[charName];
        const presence  = cell?.presence ?? "absent";
        const gapKey    = `${rowIdx}:${charName}`;
        const isGap     = gaps.has(gapKey);

        const td = tr.createEl("td", {
          cls: [
            "chronicle-matrix-cell",
            `chronicle-matrix-cell-${presence}`,
            isGap ? "chronicle-matrix-gap" : "",
          ]
            .filter(Boolean)
            .join(" "),
          title: `${charName} — ${LABELS[presence]} in ${sceneRow.sceneLabel}${
            cell?.location ? ` (at ${cell.location})` : ""
          }`,
        });
        td.setText(SYMBOLS[presence]);
      }
    }
  }

  /** Gap keys are `"rowIdx:charName"` strings. */
  private computeGaps(
    matrix: PresenceMatrix,
    threshold: number
  ): Set<string> {
    const result = new Set<string>();

    for (const charName of matrix.characters) {
      let run: number[] = [];  // row indices of the current absence streak

      const flush = () => {
        if (run.length >= threshold) {
          for (const idx of run) result.add(`${idx}:${charName}`);
        }
        run = [];
      };

      for (let i = 0; i < matrix.scenes.length; i++) {
        const presence = matrix.scenes[i].cells[charName]?.presence ?? "absent";
        if (presence === "absent") {
          run.push(i);
        } else {
          flush();
        }
      }
      flush(); // trailing run
    }

    return result;
  }

  private async openScene(scenePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(scenePath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  private async openBibleNote(charName: string): Promise<void> {
    const safe = charName.replace(/[/\\:*?"<>|]/g, "-");
    const path = `${this.settings.bibleFolderPath}/${safe}.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }
}
