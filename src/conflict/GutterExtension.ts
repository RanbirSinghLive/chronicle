import { StateField, StateEffect } from "@codemirror/state";
import type { Extension, Transaction } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { ConflictRecord } from "../types";

// ── State ─────────────────────────────────────────────────────────────────────

/** Dispatched to update the conflict list for the active editor. */
export const setConflictsEffect = StateEffect.define<ConflictRecord[]>();

/** CM6 StateField holding the active conflicts for this editor instance. */
export const conflictStateField = StateField.define<ConflictRecord[]>({
  create: () => [],
  update(value, tr: Transaction) {
    for (const effect of tr.effects) {
      if (effect.is(setConflictsEffect)) return effect.value;
    }
    return value;
  },
});

// ── Gutter marker ─────────────────────────────────────────────────────────────

class ConflictMarker extends GutterMarker {
  constructor(
    private record: ConflictRecord | null,
    private colour: string,
    private icon: string,
    private onClick: (record: ConflictRecord) => void
  ) {
    super();
  }

  toDOM(): Node {
    const el = document.createElement("span");
    el.textContent = this.icon;
    el.style.color = this.colour;
    el.style.cursor = "pointer";
    el.style.fontStyle = "normal";
    if (this.record) {
      el.title = `Chronicle conflict — ${this.record.attribute}: "${this.record.priorValue}" vs "${this.record.newValue}". Click to resolve.`;
      el.addEventListener("click", () => this.onClick(this.record!));
    }
    return el;
  }

  eq(other: ConflictMarker): boolean {
    if (!this.record || !other.record) return !this.record && !other.record;
    return (
      other.record.entity    === this.record.entity    &&
      other.record.attribute === this.record.attribute &&
      other.record.newLine   === this.record.newLine
    );
  }
}

// ── Extension factory ─────────────────────────────────────────────────────────

/**
 * Build the Chronicle conflict gutter extension.
 *
 * @param hardColour   CSS colour for hard-conflict markers
 * @param softColour   CSS colour for soft-conflict markers
 * @param onConflictClick  Called when the user clicks a gutter marker
 */
export function buildGutterExtension(
  hardColour: string,
  softColour: string,
  onConflictClick: (record: ConflictRecord) => void
): Extension {
  return [
    conflictStateField,
    gutter({
      lineMarker(view, line) {
        const conflicts = view.state.field(conflictStateField);
        if (!conflicts.length) return null;
        const lineNum = view.state.doc.lineAt(line.from).number;

        const conflict = conflicts.find((c) => c.newLine === lineNum);
        if (!conflict) return null;

        const colour = conflict.type === "hard" ? hardColour : softColour;
        const icon   = conflict.type === "hard" ? "⚠" : "◈";
        return new ConflictMarker(conflict, colour, icon, onConflictClick);
      },

      lineMarkerChange(update) {
        // Re-render whenever the effect is dispatched or the document / viewport changes
        return (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(setConflictsEffect))
          )
        );
      },

      class: "chronicle-conflict-gutter",

      // Reserve gutter space even when there are no conflicts
      initialSpacer: () =>
        new ConflictMarker(null, "transparent", "⚠", () => {}),
    }),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Dispatch an updated conflict list to a CM6 EditorView so the gutter
 * re-renders immediately.
 */
export function dispatchConflicts(
  editorView: EditorView,
  conflicts: ConflictRecord[]
): void {
  editorView.dispatch({ effects: setConflictsEffect.of(conflicts) });
}
