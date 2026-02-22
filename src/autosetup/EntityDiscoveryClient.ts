import { requestUrl } from "obsidian";
import type { ChronicleSettings, EntityType } from "../types";

export interface DiscoveredEntity {
  name: string;
  type: EntityType;
  aliases: string[];
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ScenePosition {
  filePath: string;
  position: number;
  rationale: string;
}

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_MODEL = "gpt-4o-mini";

export class EntityDiscoveryClient {
  constructor(private settings: ChronicleSettings) {}

  // ── Public ──────────────────────────────────────────────────────────────────

  async discoverEntities(
    sceneBody: string,
    filePath: string,
    excludeNames: string[]
  ): Promise<DiscoveredEntity[]> {
    const prompt = this.buildDiscoveryPrompt(sceneBody, filePath, excludeNames);
    const raw = await this.callProvider(prompt, 512);
    return this.parseDiscoveryResponse(raw);
  }

  async assignTimelinePositions(
    scenes: Array<{ filePath: string; excerpt: string }>,
    knownPositions: Record<string, number>
  ): Promise<ScenePosition[]> {
    const CHUNK = 10;
    const results: ScenePosition[] = [];

    for (let i = 0; i < scenes.length; i += CHUNK) {
      const chunk = scenes.slice(i, i + CHUNK);
      const prompt = this.buildTimelinePrompt(chunk, knownPositions);
      try {
        const raw = await this.callProvider(prompt, 1024);
        const positions = this.parseTimelineResponse(raw);
        results.push(...positions);
      } catch (err) {
        console.error("Chronicle: timeline positioning chunk failed", err);
      }
    }

    return results;
  }

  // ── Private: prompts ─────────────────────────────────────────────────────────

  private buildDiscoveryPrompt(
    sceneBody: string,
    filePath: string,
    excludeNames: string[]
  ): string {
    const excludeStr =
      excludeNames.length > 0 ? excludeNames.join(", ") : "(none)";

    return [
      "You are a story bible assistant. Read this scene and identify all named entities significant enough to track in a story bible.",
      "",
      `File: ${filePath}`,
      "",
      `Already registered (DO NOT include): ${excludeStr}`,
      "",
      "Return ONLY a JSON object:",
      JSON.stringify({
        entities: [
          {
            name: "canonical name",
            type: "character | location | object | faction",
            aliases: ["optional", "alternatives"],
            confidence: "high | medium | low",
            reason: "one sentence",
          },
        ],
      }),
      "",
      "Rules:",
      "- Characters: named persons/beings with agency",
      "- Locations: named places, buildings, regions",
      "- Objects: named items with narrative significance",
      "- Factions: organizations, groups, institutions",
      "- Use the most formal/complete name as canonical",
      '- confidence "high" = named multiple times or POV/major action',
      '- confidence "medium" = named once or briefly present',
      '- confidence "low" = implied or single passing mention',
      "- Do NOT include common nouns, generic roles, or meta-text",
      "- Return ONLY the JSON.",
      "",
      "Scene:",
      sceneBody,
    ].join("\n");
  }

  private buildTimelinePrompt(
    scenes: Array<{ filePath: string; excerpt: string }>,
    knownPositions: Record<string, number>
  ): string {
    const knownLines =
      Object.entries(knownPositions).length > 0
        ? Object.entries(knownPositions)
            .map(([path, pos]) => `- ${path} → position ${pos}`)
            .join("\n")
        : "(none)";

    const sceneBlocks = scenes
      .map(
        (s) =>
          `---\nFile: ${s.filePath}\nExcerpt: ${s.excerpt}\n---`
      )
      .join("\n");

    return [
      "You are a story timeline assistant. Assign each scene a story-time position (chronological order in the story world, not narrative order).",
      "",
      "Already anchored (use as fixed reference points):",
      knownLines,
      "",
      "Scenes to position:",
      sceneBlocks,
      "",
      "Return ONLY a JSON object:",
      JSON.stringify({
        positions: [
          {
            filePath: "exact path as shown above",
            position: 2.5,
            rationale: "one sentence citing textual evidence",
          },
        ],
      }),
      "",
      "Omit scenes you cannot position with confidence.",
      "Return ONLY the JSON.",
    ].join("\n");
  }

  // ── Private: provider dispatch ───────────────────────────────────────────────

  private async callProvider(prompt: string, maxTokens: number): Promise<string> {
    const provider = this.settings.llmProvider;
    if (provider !== "ollama" && !this.settings.llmApiKey.trim()) {
      throw new Error(
        `Chronicle: LLM key is not set for provider "${provider}".`
      );
    }

    switch (provider) {
      case "anthropic":
        return this.callAnthropic(prompt, maxTokens);
      case "openai":
        return this.callOpenAI(prompt, maxTokens);
      case "ollama":
        return this.callOllama(prompt);
      default:
        throw new Error(`Chronicle: Unknown LLM provider "${provider}".`);
    }
  }

  private async callAnthropic(prompt: string, maxTokens: number): Promise<string> {
    const resp = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": this.settings.llmApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      throw new Error(`Anthropic API error ${resp.status}: ${resp.text.slice(0, 200)}`);
    }

    const data = resp.json as { content: Array<{ type: string; text: string }> };
    return data.content?.[0]?.text ?? "";
  }

  private async callOpenAI(prompt: string, maxTokens: number): Promise<string> {
    const resp = await requestUrl({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.llmApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      throw new Error(`OpenAI API error ${resp.status}: ${resp.text.slice(0, 200)}`);
    }

    const data = resp.json as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  private async callOllama(prompt: string): Promise<string> {
    const endpoint = this.settings.ollamaEndpoint.replace(/\/$/, "");
    const resp = await requestUrl({
      url: `${endpoint}/api/generate`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.settings.ollamaModel || "llama3.2",
        prompt,
        stream: false,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      throw new Error(`Ollama API error ${resp.status}: ${resp.text.slice(0, 200)}`);
    }

    const data = resp.json as { response: string };
    return data.response ?? "";
  }

  // ── Private: response parsing ─────────────────────────────────────────────────

  private stripCodeFences(raw: string): string {
    const fenceMatch = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();
    return raw.trim();
  }

  private safeParse(text: string): unknown {
    const clean = this.stripCodeFences(text);
    try {
      return JSON.parse(clean);
    } catch {
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
  }

  private parseDiscoveryResponse(raw: string): DiscoveredEntity[] {
    const parsed = this.safeParse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

    const arr = (parsed as Record<string, unknown>)["entities"];
    if (!Array.isArray(arr)) return [];

    const VALID_TYPES: EntityType[] = ["character", "location", "object", "faction"];
    const VALID_CONFIDENCE = ["high", "medium", "low"] as const;

    const entities: DiscoveredEntity[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
      if (!name) continue;

      const rawType = typeof obj["type"] === "string" ? obj["type"].trim() : "";
      const type = VALID_TYPES.includes(rawType as EntityType)
        ? (rawType as EntityType)
        : "character";

      const rawConf = typeof obj["confidence"] === "string" ? obj["confidence"].trim() : "";
      const confidence = VALID_CONFIDENCE.includes(rawConf as "high" | "medium" | "low")
        ? (rawConf as "high" | "medium" | "low")
        : "low";

      const aliases = Array.isArray(obj["aliases"])
        ? (obj["aliases"] as unknown[])
            .filter((a) => typeof a === "string")
            .map((a) => (a as string).trim())
            .filter(Boolean)
        : [];

      const reason =
        typeof obj["reason"] === "string" ? obj["reason"].trim() : "";

      entities.push({ name, type, aliases, confidence, reason });
    }

    return entities;
  }

  private parseTimelineResponse(raw: string): ScenePosition[] {
    const parsed = this.safeParse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

    const arr = (parsed as Record<string, unknown>)["positions"];
    if (!Array.isArray(arr)) return [];

    const positions: ScenePosition[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      const filePath =
        typeof obj["filePath"] === "string" ? obj["filePath"].trim() : "";
      if (!filePath) continue;

      const rawPos = obj["position"];
      const position =
        typeof rawPos === "number"
          ? rawPos
          : typeof rawPos === "string"
          ? parseFloat(rawPos)
          : NaN;
      if (isNaN(position)) continue;

      const rationale =
        typeof obj["rationale"] === "string" ? obj["rationale"].trim() : "";

      positions.push({ filePath, position, rationale });
    }

    return positions;
  }
}
