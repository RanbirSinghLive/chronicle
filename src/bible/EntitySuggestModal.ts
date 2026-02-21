import { App, FuzzyMatch, FuzzySuggestModal } from "obsidian";
import type { RegistryEntry } from "../types";

export class EntitySuggestModal extends FuzzySuggestModal<RegistryEntry> {
  private entries: RegistryEntry[];
  private onChoose: (entry: RegistryEntry) => void;

  constructor(
    app: App,
    entries: RegistryEntry[],
    onChoose: (entry: RegistryEntry) => void
  ) {
    super(app);
    this.entries = entries;
    this.onChoose = onChoose;
    this.setPlaceholder("Type to search entities by name or alias...");
  }

  getItems(): RegistryEntry[] {
    return this.entries;
  }

  /**
   * The fuzzy scorer runs against this string.
   * Including aliases means searching "Ellie" surfaces Elena's entry.
   */
  getItemText(entry: RegistryEntry): string {
    return [entry.name, ...entry.aliases].join(" ");
  }

  renderSuggestion(match: FuzzyMatch<RegistryEntry>, el: HTMLElement): void {
    const entry = match.item;
    el.createEl("div", { text: entry.name });
    const subtitle =
      entry.type +
      (entry.aliases.length > 0 ? " · " + entry.aliases.join(", ") : "");
    el.createEl("div", { text: subtitle, cls: "chronicle-suggest-subtitle" });
  }

  onChooseItem(entry: RegistryEntry, _evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(entry);
  }
}
