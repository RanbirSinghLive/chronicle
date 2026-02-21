import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type { ChronicleSettings, SceneTemporalRecord } from "../types";
import type { TimelineAnalyzer } from "./TimelineAnalyzer";

export const TIMELINE_VIEW_TYPE = "chronicle-timeline";

type TimelineMode = "narrative" | "story-time";

const MARKER_LABEL: Record<string, string> = {
  relative_forward: "↓",
  relative_backward: "↑",
  same_day: "→",
  absolute: "◆",
};

export class TimelineView extends ItemView {
  private analyzer: TimelineAnalyzer;
  private settings: ChronicleSettings;
  private mode: TimelineMode = "narrative";
  private records: SceneTemporalRecord[] = [];
  private openSetAnchor: (filePath: string) => void;

  private narrativeBtn!: HTMLButtonElement;
  private storyBtn!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    analyzer: TimelineAnalyzer,
    settings: ChronicleSettings,
    openSetAnchor: (filePath: string) => void
  ) {
    super(leaf);
    this.analyzer = analyzer;
    this.settings = settings;
    this.openSetAnchor = openSetAnchor;
  }

  getViewType(): string {
    return TIMELINE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Timeline";
  }

  getIcon(): string {
    return "clock";
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
    contentEl.addClass("chronicle-timeline-container");

    // Toolbar
    const toolbar = contentEl.createDiv({ cls: "chronicle-timeline-toolbar" });

    const refreshBtn = toolbar.createEl("button", { text: "↺ Refresh" });
    refreshBtn.addEventListener("click", () => this.refresh());

    this.narrativeBtn = toolbar.createEl("button", {
      text: "Narrative",
      cls: this.mode === "narrative" ? "chronicle-timeline-mode-active" : "",
    });
    this.narrativeBtn.addEventListener("click", () => {
      this.setMode("narrative");
    });

    this.storyBtn = toolbar.createEl("button", {
      text: "Story-time",
      cls: this.mode === "story-time" ? "chronicle-timeline-mode-active" : "",
    });
    this.storyBtn.addEventListener("click", () => {
      this.setMode("story-time");
    });

    // Loading
    const status = contentEl.createDiv({ cls: "chronicle-timeline-status" });
    status.setText("Building timeline…");

    this.records = await this.analyzer.buildTimeline();
    status.remove();

    if (this.records.length === 0) {
      contentEl.createDiv({ cls: "chronicle-timeline-status" }).setText(
        "No scene files found. Configure scene folders in Chronicle settings."
      );
      return;
    }

    this.renderRecords();
  }

  private setMode(mode: TimelineMode): void {
    this.mode = mode;
    this.narrativeBtn.className = mode === "narrative" ? "chronicle-timeline-mode-active" : "";
    this.storyBtn.className = mode === "story-time" ? "chronicle-timeline-mode-active" : "";
    this.renderRecords();
  }

  private renderRecords(): void {
    const existing = this.contentEl.querySelector(".chronicle-timeline-scroll");
    if (existing) existing.remove();

    const scroll = this.contentEl.createDiv({ cls: "chronicle-timeline-scroll" });

    if (this.mode === "narrative") {
      this.renderNarrative(scroll, this.records);
    } else {
      this.renderStoryTime(scroll, this.records);
    }
  }

  private renderNarrative(container: HTMLElement, records: SceneTemporalRecord[]): void {
    const list = container.createEl("ol", { cls: "chronicle-timeline-list" });
    for (let i = 0; i < records.length; i++) {
      this.renderSceneItem(list, records[i], i + 1, false);
    }
  }

  private renderStoryTime(container: HTMLElement, records: SceneTemporalRecord[]): void {
    const resolved = records
      .filter((r) => r.resolvedPosition !== undefined)
      .sort((a, b) => (a.resolvedPosition ?? 0) - (b.resolvedPosition ?? 0));
    const unresolved = records.filter((r) => r.resolvedPosition === undefined);

    if (resolved.length > 0) {
      const list = container.createEl("ol", { cls: "chronicle-timeline-list" });
      for (let i = 0; i < resolved.length; i++) {
        this.renderSceneItem(list, resolved[i], i + 1, false);
      }
    } else if (unresolved.length > 0) {
      container.createDiv({ cls: "chronicle-timeline-status" }).setText(
        "No anchored scenes yet. Set anchors to enable story-time ordering."
      );
    }

    if (unresolved.length > 0) {
      container.createEl("h4", {
        cls: "chronicle-timeline-unresolved-heading",
        text: `Unresolved (${unresolved.length})`,
      });
      const list = container.createEl("ul", {
        cls: "chronicle-timeline-list chronicle-timeline-unresolved",
      });
      for (const rec of unresolved) {
        this.renderSceneItem(list, rec, null, true);
      }
    }
  }

  private renderSceneItem(
    parent: HTMLElement,
    rec: SceneTemporalRecord,
    index: number | null,
    showAnchorHint: boolean
  ): void {
    const li = parent.createEl("li", { cls: "chronicle-timeline-item" });
    if (rec.resolvedPosition === undefined) {
      li.addClass("chronicle-timeline-item-unresolved");
    }

    const header = li.createDiv({ cls: "chronicle-timeline-item-header" });

    const nameBtn = header.createEl("button", {
      cls: "chronicle-timeline-scene-btn",
      text: this.sceneName(rec.scenePath),
      title: rec.scenePath,
    });
    nameBtn.addEventListener("click", () => this.openScene(rec.scenePath));

    if (rec.anchor !== undefined) {
      header.createEl("span", {
        cls: "chronicle-timeline-anchor-badge",
        text: `pos ${rec.anchor}`,
        title: "Story-time anchor",
      });
    }

    if (rec.markers.length > 0) {
      const markersEl = li.createDiv({ cls: "chronicle-timeline-markers" });
      for (const m of rec.markers.slice(0, 3)) {
        markersEl.createEl("span", {
          cls: `chronicle-timeline-marker chronicle-timeline-marker-${m.type}`,
          text: `${MARKER_LABEL[m.type] ?? "◇"} ${m.text}`,
          title: `${m.type} (line ${m.line})`,
        });
      }
      if (rec.markers.length > 3) {
        markersEl.createEl("span", {
          cls: "chronicle-timeline-marker-more",
          text: `+${rec.markers.length - 3} more`,
        });
      }
    }

    if (showAnchorHint) {
      const hint = li.createEl("button", {
        cls: "chronicle-timeline-set-anchor-hint",
        text: "Set anchor…",
        title: "Set a story-time position for this scene",
      });
      hint.addEventListener("click", () => this.openSetAnchor(rec.scenePath));
    }
  }

  private sceneName(path: string): string {
    const parts = path.split("/");
    const base = parts[parts.length - 1];
    return base.replace(/\.md$/, "");
  }

  private async openScene(scenePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(scenePath);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }
}
