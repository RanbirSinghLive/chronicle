# Chronicle — Product Requirements Document

**Version:** 0.1 (Pre-development)  
**Status:** Draft  
**Author:** Ranbir  
**Last Updated:** February 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [Target Users](#4-target-users)
5. [Plugin Architecture Overview](#5-plugin-architecture-overview)
6. [Feature Specifications](#6-feature-specifications)
   - 6.1 Story Bible
   - 6.2 Extraction Engine
   - 6.3 Conflict Detection
   - 6.4 Timeline Sidebar
   - 6.5 Character Presence Matrix
7. [Data Model](#7-data-model)
8. [Settings and Configuration](#8-settings-and-configuration)
9. [Integration Contracts](#9-integration-contracts)
10. [Build Order and Milestones](#10-build-order-and-milestones)
11. [Open Questions](#11-open-questions)
12. [Out of Scope](#12-out-of-scope)

---

## 1. Executive Summary

Chronicle is an Obsidian community plugin for longform fiction writers. It reads the prose you've already written, builds a live story bible from it, and surfaces continuity conflicts — contradictory character descriptions, timeline inconsistencies, impossible character locations — without requiring any manual metadata entry.

The goal is to give writers the continuity-checking capabilities of dedicated fiction software (Scrivener, Fictionary, Plottr) while keeping them inside Obsidian's plain-text, local-first environment. Chronicle is read-only with respect to prose: it never modifies scene files, only its own generated bible notes.

---

## 2. Problem Statement

### The core workflow failure

Longform writers in Obsidian currently manage continuity through manual effort: maintaining separate character sheets, cross-referencing scene metadata in Dataview, or simply re-reading the manuscript before each writing session. This works at 20,000 words and breaks down at 80,000.

Existing plugins address adjacent problems but not this one:

- **Longform** handles scene organization and manuscript compilation. It has no awareness of the content of scenes.
- **Dataview** enables powerful queries over frontmatter, but requires manual, consistent data entry per scene — a discipline almost no writer maintains past the first draft.
- **RPG Manager** addresses TTRPG campaign management with overlapping concerns (characters, locations, factions) but is designed for a different use case and workflow.

### The specific pains this creates

**Continuity errors accumulate invisibly.** A character's eye colour changes between chapters. An object established as destroyed reappears. A character is in two cities on the same story-day. These errors aren't caught until editing, beta readers, or (worst case) publication.

**Writers waste time re-reading instead of writing.** Before writing a scene involving a secondary character they haven't touched in 30,000 words, writers must search back through the manuscript to recall physical details, relationships, and last known location.

**The story bible is never current.** When maintained manually, the bible reflects what the writer *planned*, not what they *actually wrote*. These diverge constantly during drafting.

---

## 3. Goals and Non-Goals

### Goals

- Extract character attributes, locations, and temporal markers from prose automatically, requiring no manual data entry to get value.
- Surface continuity conflicts inline in the editor, similar to code linting, without blocking writing.
- Maintain a human-readable, human-editable story bible as real Obsidian notes.
- Provide a scene timeline view that shows narrative order vs. story-time order.
- Provide a character presence matrix showing where each character appears across scenes.
- Work entirely offline with no external services required (Tier 1).
- Integrate cleanly alongside Longform without depending on it.

### Non-Goals

- Chronicle will not modify prose files under any circumstances.
- Chronicle will not replace Longform's scene organization or compile features.
- Chronicle will not provide AI writing assistance, suggestions, or generation.
- Chronicle will not sync data to external services.
- Chronicle will not support non-fiction or non-narrative writing workflows.
- Chronicle will not provide grammar or style checking.

---

## 4. Target Users

### Primary: The Committed Obsidian Fiction Writer

A writer who has already chosen Obsidian as their primary writing environment and has a draft in progress. They likely use Longform for scene management. They have 30,000+ words written and are beginning to feel the continuity management pain acutely. They are comfortable installing community plugins but are not developers.

**Their key frustration:** "I have to re-read my whole manuscript every time I need to remember what colour Elena's hair is."

### Secondary: The Obsidian Power User Starting a Novel

A writer who uses Obsidian extensively for notes and knowledge management and wants to write fiction without switching to dedicated fiction software. They are more technically comfortable, likely already use Dataview, and will engage deeply with Chronicle's settings and configuration options.

**Their key frustration:** "I don't want to maintain a character sheet manually — I just want the system to know what I've already written."

### Out of Scope Users

- Screenwriters (different structural needs, better served by Fountain plugin)
- Non-fiction or academic writers
- Writers who haven't yet started their draft

---

## 5. Plugin Architecture Overview

Chronicle operates in three layers:

```
┌─────────────────────────────────────────────────────────┐
│                     OBSIDIAN VAULT                       │
│                                                         │
│  /scenes/         /worldbuilding/    /_chronicle/       │
│  ch01-dawn.md     characters/        bible/             │
│  ch02-binding.md  locations/         Elena.md           │
│  ch03-oath.md                        The-Vault.md       │
│                                      _timeline.md       │
└─────────────────┬───────────────────────────────────────┘
                  │ reads (never writes)
                  ▼
┌─────────────────────────────────────────────────────────┐
│              CHRONICLE EXTRACTION ENGINE                  │
│                                                         │
│  Entity Registry  →  Pattern Matcher  →  Fact Store     │
│  (known names)       (regex + NLP)       (per-entity)   │
│                                                         │
│  Optional: LLM Extraction Layer (Tier 2)                │
└─────────────────┬───────────────────────────────────────┘
                  │ reads/writes
                  ▼
┌─────────────────────────────────────────────────────────┐
│                   CHRONICLE BIBLE                        │
│                                                         │
│  Markdown notes in /_chronicle/bible/                   │
│  Human-readable, human-editable                         │
│  Manual edits take precedence over extracted facts      │
└─────────────────┬───────────────────────────────────────┘
                  │ reads
                  ▼
┌─────────────────────────────────────────────────────────┐
│                   CHRONICLE VIEWS                        │
│                                                         │
│  Conflict Gutter  │  Timeline Sidebar  │  Presence Matrix│
│  (inline editor)  │  (leaf panel)      │  (leaf panel)   │
└─────────────────────────────────────────────────────────┘
```

**Key principle:** The extraction engine reads scene files and writes to bible files. The conflict detector reads scene files and bible files but writes nothing. The views read bible files and render UI. Scene files are never touched by any Chronicle component.

---

## 6. Feature Specifications

### 6.1 Story Bible

#### Overview

The story bible is a folder of Chronicle-managed Obsidian notes at `/_chronicle/bible/` (path configurable). Each entity — character, location, object — has its own markdown file. These are real notes: they appear in graph view, can be linked to from scene notes, and can be edited manually by the writer.

#### Bible Note Structure

Each bible note follows this format:

```markdown
---
chronicle-type: character
chronicle-managed: true
chronicle-version: 1
attributes:
  hair: copper
  eyes: blue
  first-appearance: "scenes/ch01-dawn.md"
  last-seen: "scenes/ch07-binding.md"
manual-overrides:
  eyes: "hazel (corrected from blue — was a draft error)"
aliases:
  - "Ellie"
  - "the Archivist"
---

# Elena

_Chronicle-generated profile. Edit the `manual-overrides` section to correct extraction errors. Manual overrides always take precedence._

## Extracted Attributes

| Attribute | Value | First Mentioned | Source |
|-----------|-------|----------------|--------|
| Hair | copper | ch01-dawn.md | "Elena's copper hair caught the light" |
| Eyes | hazel | ch01-dawn.md | (manual override) |

## Appearances

| Scene | Role | Chapter |
|-------|------|---------|
| ch01-dawn.md | POV | 1 |
| ch03-oath.md | Supporting | 3 |

## Last Known Location

The Vault — last established in ch07-binding.md
```

#### Bible Management Rules

- Chronicle creates bible notes for entities in the **entity registry** (see §6.2).
- Chronicle updates extracted attributes on each scan but never overwrites the `manual-overrides` section.
- If a writer deletes a bible note, Chronicle re-creates it on the next scan (from the entity registry). To permanently exclude an entity, it must be removed from the registry.
- Writers can add free-form notes anywhere in the document below Chronicle's managed sections; these are preserved across updates.
- Chronicle marks its managed sections with HTML comments: `<!-- chronicle:start -->` and `<!-- chronicle:end -->`. Content outside these markers is never touched.

---

### 6.2 Extraction Engine

#### Overview

The extraction engine scans scene files and populates the story bible. It operates in two tiers: Tier 1 is always-on pattern matching requiring no external services; Tier 2 is optional LLM-powered extraction.

#### Entity Registry

Before extraction can run, the writer must seed the entity registry: a list of character names, aliases, location names, and key objects. This is the **only manual setup step required to use Chronicle**.

The registry lives at `/_chronicle/registry.md`:

```yaml
---
chronicle-registry: true
---

## Characters

- name: Elena
  aliases: [Ellie, "the Archivist"]
  type: character

- name: Marcus
  aliases: ["the Chancellor"]
  type: character

## Locations

- name: The Vault
  aliases: ["the Archive", "Vault of Accord"]
  type: location

## Objects

- name: Binding Oath
  aliases: ["the Oath", "the Accord"]
  type: object
```

Chronicle provides a command to add entities to the registry directly from the command palette: **"Chronicle: Register new entity"**. This opens a modal with fields for name, aliases, and type.

#### Tier 1: Pattern Matching

Tier 1 extraction runs as follows, in order of priority:

**Physical attribute extraction** scans for patterns near entity name mentions:

| Pattern | Example | Extracted |
|---------|---------|-----------|
| `{adj} {entity}` | "copper-haired Elena" | Elena → hair: copper |
| `{entity}'s {adj} {noun}` | "Elena's copper hair" | Elena → hair: copper |
| `{entity} {verb} {adj} {noun}` | "Elena had copper hair" | Elena → hair: copper |
| `{entity}, {adj}` (appositive) | "Elena, pale and tired," | Elena → complexion: pale |

The attribute dictionary maps noun headwords to attribute categories: `hair, eyes, height, build, age, voice`. Tier 1 extracts within these categories only; it does not extract arbitrary attributes.

**Location extraction** tracks entity placement:

| Pattern | Example | Extracted |
|---------|---------|-----------|
| `{entity} entered {location}` | "Elena entered the Vault" | Elena → location: The Vault |
| `{entity} arrived at {location}` | "Marcus arrived at the Vault" | Marcus → location: The Vault |
| `{entity} was in {location}` | "Elena was in the Archive" | Elena → location: The Vault (alias resolved) |
| `{entity} left {location}` | "Elena left the Vault" | Elena → location: null |

**Temporal marker extraction** identifies time anchors for timeline ordering:

| Pattern | Type | Example |
|---------|------|---------|
| `{N} days later` | Relative forward | "Three days later" |
| `{N} days earlier` | Relative backward | "Two weeks earlier" |
| `the next {period}` | Relative forward | "The next morning" |
| `that {period}` | Same-day | "That afternoon" |
| Day/date references | Absolute | "On the fourteenth day of the Accord" |

Temporal markers are stored per-scene, not per-entity. They feed the timeline view (§6.4).

**Extraction scope:** Tier 1 runs on the paragraph containing an entity mention, plus one paragraph before and after (the extraction window). It does not scan the entire scene for each entity — this keeps performance acceptable on large files.

#### Tier 2: LLM Extraction (Optional)

Tier 2 sends scene text to a language model for richer extraction: emotional state, relationship dynamics, foreshadowing flags, and attributes outside Tier 1's dictionary.

**Configuration:** Writers opt in per-entity or globally in settings. They provide an API key (Anthropic, OpenAI, or local Ollama endpoint). Tier 2 never runs without explicit opt-in.

**Prompt structure:**

```
You are a story continuity assistant. Given the scene below, extract new factual information about the listed entities. Return only a JSON object matching the schema. Do not infer or speculate — only extract facts that are directly stated.

Entities: [list from registry]
Schema: { "entity_name": { "attribute_name": { "value": string, "quote": string } } }

Scene:
[scene text]
```

The `quote` field captures the verbatim source passage (≤ 30 words) for display in the conflict popover.

**Merge behaviour:** Tier 2 results are merged with Tier 1 results. In cases of conflict between tiers, Tier 1 takes precedence (pattern matching is more precise for the attribute categories it covers).

#### Scan Triggers

| Trigger | Scope | Performance target |
|---------|-------|-------------------|
| On file save | Changed file only | < 200ms |
| Command: "Chronicle: Full scan" | All scene files | < 5s for 100K word vault |
| On Longform compile | All files in project | Before compile output |
| On vault open | Changed files since last scan | Background, non-blocking |

---

### 6.3 Conflict Detection

#### Overview

Conflict detection compares facts in newly-scanned scene passages against the current story bible. Conflicts are surfaced as gutter markers in the editor, similar to linting indicators in a code editor.

#### Conflict Types

**Hard conflicts** — a fact directly contradicts a prior established fact.

Examples:
- Elena's eyes described as "brown" in ch09 when bible records "hazel" (established ch01)
- Marcus described as "arriving in the Vault" in ch12, but his last known location (ch11) is "the Northern Gate" with no intervening travel

Hard conflicts display as a red gutter icon (⚠) on the relevant line.

**Soft conflicts** — a fact is new and doesn't contradict anything, but differs from a prior description in a way that may be intentional or may be an error.

Examples:
- A location described differently than its previous description (renovation? intentional contrast?)
- A character's relationship to another character described in a way that contradicts prior implication

Soft conflicts display as a yellow gutter icon (◈) on the relevant line.

**Absence warnings** — a named character hasn't appeared in a configurable number of scenes. This is not a conflict but a structural flag.

Absence warnings appear in the Timeline sidebar, not in the editor gutter.

#### Conflict Popover

Clicking a gutter icon opens a floating popover containing:

- The conflicting prior passage (≤ 2 sentences, with scene filename and a clickable link to jump there)
- The attribute in question and its two competing values
- Two action buttons: **Dismiss** (marks as intentional, removes warning) and **Update Bible** (marks the new description as authoritative, updates the bible)
- A text field to add a note explaining the dismissal (stored in bible under `dismissed-conflicts`)

#### Conflict Storage

Dismissed conflicts are stored in the relevant bible note's frontmatter under `dismissed-conflicts`. This prevents re-triggering on subsequent scans:

```yaml
dismissed-conflicts:
  - scene: ch09-council.md
    attribute: eyes
    value: brown
    note: "Elena is wearing colored contacts at the council — intentional"
    dismissed-at: 2026-02-10
```

---

### 6.4 Timeline Sidebar

#### Overview

The timeline sidebar is a dedicated Obsidian leaf panel (right sidebar) that visualizes scenes on a temporal axis. It has two modes switchable by toggle:

**Narrative order** — scenes in the order they appear in the manuscript (matches Longform scene order if Longform is installed). This is the default view.

**Story-time order** — scenes reordered by when their events occur in the story world, inferred from temporal markers extracted by the engine plus user-set anchors.

#### Rendering

Each scene is represented as a node on a vertical timeline axis:

```
◉ ch01-dawn.md          Day 1, morning         (anchor)
│
◉ ch02-binding.md       Day 1, afternoon       (inferred)
│
◉ ch05-interlude.md     3 weeks before Day 1   (inferred — flashback)
│
◎ ch03-oath.md          Day unknown            (unresolved — dashed border)
│
◉ ch04-aftermath.md     Day 4                  (inferred)
```

Nodes with unresolved placement are shown with dashed borders and a "Set manually" affordance that opens a modal to specify the scene's temporal position.

#### Anchor System

Writers set explicit time anchors on scenes via the command palette: **"Chronicle: Set scene time anchor"**. Anchors are stored in scene frontmatter:

```yaml
---
chronicle-anchor: "Day 1, Year 3 of the Accord"
---
```

Once an anchor is set, Chronicle uses it as a fixed point and resolves relative temporal markers in surrounding scenes outward from it.

#### Absence Warnings

When in story-time order, scenes where a registered entity was expected (based on last-known location and next appearance) but doesn't appear are flagged with a small indicator. Clicking it shows which entity is absent and how many scenes they've been missing.

---

### 6.5 Character Presence Matrix

#### Overview

The character presence matrix is a tabular view accessible as an Obsidian leaf panel. Rows are scenes; columns are registered characters (and optionally locations and objects). A cell is filled when the character appears in that scene.

#### Cell Types

| Symbol | Meaning |
|--------|---------|
| ● (filled) | Character has a speaking or active role |
| ◦ (open) | Character is mentioned but not present |
| P | POV character for this scene |
| — | Character does not appear |

Role classification (speaking vs. mentioned) is inferred from whether dialogue is attributed to the character in the scene. This is a heuristic (dialogue attribution patterns like `"..." Elena said`), not guaranteed correct. Writers can correct cell types manually.

#### Interactions

- Clicking a filled cell opens the corresponding scene in the editor.
- Clicking a character column header opens their bible note.
- Hovering a cell shows a tooltip with the character's extracted location in that scene.
- A "Gap detector" mode highlights columns where a character is absent for more than N consecutive scenes (N configurable, default 5).

---

## 7. Data Model

### Entity Types

```typescript
type EntityType = "character" | "location" | "object" | "faction"

interface RegistryEntry {
  name: string
  aliases: string[]
  type: EntityType
  sceneFolder?: string  // restrict extraction to specific folder
  excluded?: boolean    // exclude from extraction entirely
}

interface ExtractedFact {
  attribute: string       // e.g. "hair", "eyes", "location"
  value: string           // e.g. "copper", "hazel", "The Vault"
  sourceScene: string     // vault-relative path
  sourceLine: number
  sourceQuote: string     // verbatim passage ≤ 30 words
  extractedBy: "tier1" | "tier2" | "manual"
  extractedAt: string     // ISO timestamp
}

interface ConflictRecord {
  type: "hard" | "soft"
  entity: string
  attribute: string
  priorValue: string
  priorScene: string
  newValue: string
  newScene: string
  newLine: number
  status: "active" | "dismissed"
  dismissalNote?: string
  dismissedAt?: string
}

interface SceneTemporalRecord {
  scenePath: string
  anchor?: string          // manually set anchor string
  markers: TemporalMarker[]
  resolvedPosition?: number  // story-time ordinal, null if unresolved
}

interface TemporalMarker {
  type: "relative_forward" | "relative_backward" | "absolute" | "same_day"
  text: string             // the extracted text
  line: number
}
```

---

## 8. Settings and Configuration

All settings are exposed via the standard Obsidian settings panel under "Chronicle."

| Setting | Default | Description |
|---------|---------|-------------|
| Bible folder path | `_chronicle/bible` | Where Chronicle stores generated notes |
| Registry path | `_chronicle/registry.md` | Where the entity registry lives |
| Scene folders | (empty — all folders) | Restrict extraction to specific folders |
| Scan on save | true | Run extraction when a scene file is saved |
| Extraction window | 1 paragraph | How many paragraphs around a mention to scan |
| Absence warning threshold | 5 scenes | Scenes without appearance before absence flag |
| LLM extraction | disabled | Enable Tier 2 extraction |
| LLM provider | anthropic | anthropic / openai / ollama |
| LLM API key | (empty) | Stored securely in Obsidian's secret store |
| Ollama endpoint | http://localhost:11434 | For local model use |
| Compile integration | true | Run Chronicle scan before Longform compile |
| Conflict gutter | true | Show gutter icons in editor |
| Hard conflict colour | red | Gutter icon colour for hard conflicts |
| Soft conflict colour | yellow | Gutter icon colour for soft conflicts |

---

## 9. Integration Contracts

### Longform Integration

Chronicle detects Longform by checking for the Longform plugin in the installed plugin list. When present:

- The "Scene folders" setting defaults to the active Longform project's scene folder.
- Chronicle registers a callback on Longform's compile event to run a full scan before compilation and surface any unresolved hard conflicts in a modal (with option to proceed anyway).
- The Presence Matrix uses Longform's scene ordering for its row order.

Chronicle functions fully without Longform. When Longform is absent, scene folders must be configured manually.

### Graph View

Bible notes are real Obsidian markdown files and appear in graph view naturally. Writers can link to them from scene files using standard Obsidian wikilinks: `[[Elena]]` resolves to `_chronicle/bible/Elena.md` if no other note named Elena exists.

### Dataview

Chronicle's bible note frontmatter is Dataview-compatible. Writers can build their own queries over Chronicle-managed data. Chronicle does not depend on Dataview but does not conflict with it.

---

## 10. Build Order and Milestones

### Milestone 1: Manual Bible (v0.1)

**Goal:** Prove the vault structure and note format work well before any automation.

Deliverables:
- Plugin scaffold with settings panel
- Registry note format and management commands ("Register entity", "Open registry")
- Manual bible note creation from registry entries
- Basic template for character/location/object notes
- No extraction — all bible content is manually entered

**Success criterion:** A writer can use Chronicle as a structured manual story bible, with Obsidian's graph view showing entity relationships, without any automated extraction. Value is already present.

---

### Milestone 2: Tier 1 Extraction (v0.2)

**Goal:** The bible populates itself from prose.

Deliverables:
- On-save extraction for the saved file
- Physical attribute extraction (hair, eyes, height, build, age, voice)
- Location tracking (entered, arrived, was in)
- Bible note auto-update with source quotes
- "Chronicle: Full scan" command
- Extraction diff view (what changed in this scan)

**Success criterion:** A writer can seed the registry with character names, write a scene, save it, and see the character's bible note update with physical attributes extracted from the prose — without any manual data entry.

---

### Milestone 3: Conflict Detection (v0.3)

**Goal:** Writers see continuity problems as they write.

Deliverables:
- Hard conflict detection (direct attribute contradiction)
- Soft conflict detection (differing descriptions)
- Editor gutter icons
- Conflict popover with source passage and action buttons
- Dismiss / Update bible workflow
- Conflict log view

**Success criterion:** A writer introduces an intentional inconsistency (changes a character's eye colour mid-draft) and Chronicle flags it within 200ms of saving the file.

---

### Milestone 4: Presence Matrix (v0.4)

**Goal:** Writers can see their character coverage at a glance.

Deliverables:
- Character × scene matrix view
- Speaking / mentioned / POV cell types
- Absence gap highlighting
- Click-to-navigate on cells and headers

**Success criterion:** A writer can open the matrix and immediately identify that a secondary character hasn't appeared in 12 consecutive scenes.

---

### Milestone 5: Timeline Sidebar (v0.5)

**Goal:** Writers can see their narrative structure vs. story-time structure.

Deliverables:
- Narrative order mode (mirrors scene order)
- Temporal marker extraction
- Story-time order mode with resolved and unresolved nodes
- Anchor system ("Set scene time anchor" command)
- Absence warnings in story-time view

**Success criterion:** A writer with a non-linear narrative can toggle to story-time order and see their flashbacks correctly repositioned on the timeline.

---

### Milestone 6: LLM Extraction (v0.6)

**Goal:** Deeper extraction for writers who want it.

Deliverables:
- Tier 2 extraction prompt and response parsing
- Anthropic API integration
- OpenAI API integration
- Ollama local model integration
- Merge logic with Tier 1 results
- Per-entity LLM opt-in toggle

**Success criterion:** A writer with an Anthropic API key can enable Tier 2 extraction and see relationship dynamics and emotional states populated in their bible notes — attributes Tier 1 could not capture.

---

## 11. Open Questions

**Q1: Entity registry seeding UX.** The registry is currently a manual step. Is there a reasonable way to suggest entities from an existing draft on first-run? (Risk: false positives, especially for common words used as character names.)

**Q2: Aliases and name resolution.** Character aliases create ambiguity. "The Chancellor" might refer to different characters in different books. How should Chronicle handle alias collision, especially for writers working on a series in a single vault?

**Q3: Conflict resolution for intentional unreliable narrators.** Some writers deliberately have narrators describe the same person differently across scenes. Is the dismiss workflow sufficient, or should Chronicle support an "unreliable narrator" mode that suppresses physical attribute conflicts for a specific POV character?

**Q4: Performance ceiling.** At what word count does on-save Tier 1 extraction become perceptible? Initial estimate is ~200ms for a 3,000-word scene against a 50-entity registry. Needs benchmarking at 200K words and 200 entities.

**Q5: Series vs. single-novel scoping.** A writer with three novels in a single vault needs Chronicle to scope correctly to each project. The current design uses folder scoping, but is this sufficient for complex vault structures?

**Q6: Mobile.** Obsidian mobile has constraints (no Node.js APIs). What subset of Chronicle features is feasible on iOS/Android? Minimum viable: read-only bible access. Conflict detection and extraction may require desktop.

---

## 12. Out of Scope

The following are explicitly excluded from Chronicle's scope for the initial release series (v0.1–v0.6):

- **Writing assistance:** Chronicle does not suggest prose, complete sentences, or offer stylistic feedback. It is purely an observational tool.
- **Export:** Chronicle does not export the story bible to any format. Bible notes are Obsidian markdown files; writers can export them using existing Obsidian export workflows.
- **Collaboration:** Chronicle is designed for single-writer use. Multi-user conflict scenarios (two writers editing the same vault) are not handled.
- **Non-English prose:** Tier 1 pattern matching is English-only. Tier 2 LLM extraction may work in other languages but is not tested or supported.
- **Automatic plot analysis:** Chronicle does not analyse story structure, pacing, act breaks, or dramatic arc. It tracks facts, not narrative quality.
- **Cloud sync:** All data lives in the vault. Chronicle has no server component and makes no network requests except for optional Tier 2 LLM API calls.
- **Grammar and spelling:** Existing plugins (LanguageTool integration, etc.) handle this. Chronicle does not duplicate it.
- **Template management:** Chronicle provides bible note templates for its own use but does not provide a general-purpose template system. Templater handles that.

---

*Chronicle is built on the principle that the manuscript is the source of truth. The story bible should be a reflection of what you wrote, not a separate document you maintain in parallel.*
