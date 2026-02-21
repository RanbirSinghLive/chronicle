import type { TemporalMarker } from "../types";

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an";

const UNIT =
  "day|days|week|weeks|month|months|year|years|hour|hours|night|nights";

const PERIOD =
  "morning|day|night|evening|afternoon|midday|week|month|year";

const FORWARD_PATTERNS: RegExp[] = [
  // "three days later", "a week later"
  new RegExp(`\\b(?:\\d+|${NUMBER_WORDS})\\s+(?:${UNIT})\\s+later\\b`, "gi"),
  // "the next morning / day / night / week"
  new RegExp(`\\bthe\\s+next\\s+(?:${PERIOD})\\b`, "gi"),
  // "the following morning / day / …"
  new RegExp(`\\bthe\\s+following\\s+(?:${PERIOD})\\b`, "gi"),
];

const BACKWARD_PATTERNS: RegExp[] = [
  // "three days earlier / before / ago"
  new RegExp(
    `\\b(?:\\d+|${NUMBER_WORDS})\\s+(?:${UNIT})\\s+(?:earlier|before|ago)\\b`,
    "gi"
  ),
  // "the previous morning / day / …"
  new RegExp(`\\bthe\\s+previous\\s+(?:${PERIOD})\\b`, "gi"),
  // "the night / morning / day before"
  new RegExp(`\\bthe\\s+(?:${PERIOD})\\s+before\\b`, "gi"),
];

const SAME_DAY_PATTERNS: RegExp[] = [
  // "later that morning / day / evening"
  new RegExp(`\\blater\\s+that\\s+(?:${PERIOD})\\b`, "gi"),
  // "that same morning / evening / night"
  new RegExp(`\\bthat\\s+(?:same\\s+)?(?:${PERIOD})\\b`, "gi"),
  // "earlier that day / morning"
  new RegExp(`\\bearlier\\s+that\\s+(?:${PERIOD})\\b`, "gi"),
];

export class TemporalExtractor {
  extract(content: string): TemporalMarker[] {
    const lines = content.split("\n");
    const markers: TemporalMarker[] = [];
    const seen = new Set<string>();

    const scan = (patterns: RegExp[], type: TemporalMarker["type"]) => {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const text = match[0];
          const lineNum = this.lineOf(content, match.index, lines);
          const key = `${type}:${text.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            markers.push({ type, text, line: lineNum });
          }
        }
      }
    };

    scan(FORWARD_PATTERNS, "relative_forward");
    scan(BACKWARD_PATTERNS, "relative_backward");
    scan(SAME_DAY_PATTERNS, "same_day");

    return markers.sort((a, b) => a.line - b.line);
  }

  private lineOf(content: string, index: number, lines: string[]): number {
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      pos += lines[i].length + 1; // +1 for \n
      if (pos > index) return i + 1;
    }
    return lines.length;
  }
}
