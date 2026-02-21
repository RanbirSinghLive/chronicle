import { requestUrl } from "obsidian";
import type { ChronicleSettings, RegistryEntry } from "../types";

/** Raw Tier 2 response shape after parsing. */
export interface Tier2Result {
  [entityName: string]: {
    [attribute: string]: { value: string; quote: string };
  };
}

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_MODEL = "gpt-4o-mini";

export class LlmClient {
  constructor(private settings: ChronicleSettings) {}

  // ── Public ───────────────────────────────────────────────────────────────

  /**
   * Send scene text to the configured LLM and return extracted facts.
   * @throws if the API key is missing or the provider call fails.
   */
  async extract(
    sceneBody: string,
    entities: RegistryEntry[]
  ): Promise<Tier2Result> {
    if (entities.length === 0) return {};

    const provider = this.settings.llmProvider;
    if (provider !== "ollama" && !this.settings.llmApiKey.trim()) {
      throw new Error(
        `Chronicle: LLM extraction is enabled but no API key is set for "${provider}".`
      );
    }

    const prompt = this.buildPrompt(sceneBody, entities);
    let raw: string;

    switch (provider) {
      case "anthropic":
        raw = await this.callAnthropic(prompt);
        break;
      case "openai":
        raw = await this.callOpenAI(prompt);
        break;
      case "ollama":
        raw = await this.callOllama(prompt);
        break;
      default:
        throw new Error(`Chronicle: Unknown LLM provider "${provider}".`);
    }

    return this.parseResponse(raw, entities);
  }

  // ── Private: prompt ───────────────────────────────────────────────────────

  private buildPrompt(sceneBody: string, entities: RegistryEntry[]): string {
    const entityList = entities
      .map((e) => {
        const aliases =
          e.aliases.length > 0
            ? ` (also known as: ${e.aliases.join(", ")})`
            : "";
        return `- ${e.name}${aliases} [${e.type}]`;
      })
      .join("\n");

    return [
      "You are a story continuity assistant. Given the scene below, extract new factual information about the listed entities.",
      "Return ONLY a JSON object matching the schema. Do not infer or speculate — only extract facts that are directly stated.",
      "",
      "Entities:",
      entityList,
      "",
      'Schema: { "entity_name": { "attribute_name": { "value": "extracted value", "quote": "verbatim passage ≤30 words" } } }',
      "",
      "Extract attributes such as: emotional state, relationships, occupation, goals, beliefs, and physical details not covered by standard Tier 1 patterns.",
      "Do not include: hair color, eye color, height, build, age, voice, complexion, or location — those are handled separately.",
      "Return ONLY the JSON object. No markdown, no explanation.",
      "",
      "Scene:",
      sceneBody,
    ].join("\n");
  }

  // ── Private: provider calls ───────────────────────────────────────────────

  private async callAnthropic(prompt: string): Promise<string> {
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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      throw new Error(
        `Anthropic API error ${resp.status}: ${resp.text.slice(0, 200)}`
      );
    }

    const data = resp.json as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content?.[0]?.text ?? "";
  }

  private async callOpenAI(prompt: string): Promise<string> {
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
        max_tokens: 1024,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      throw new Error(
        `OpenAI API error ${resp.status}: ${resp.text.slice(0, 200)}`
      );
    }

    const data = resp.json as {
      choices: Array<{ message: { content: string } }>;
    };
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
      throw new Error(
        `Ollama API error ${resp.status}: ${resp.text.slice(0, 200)}`
      );
    }

    const data = resp.json as { response: string };
    return data.response ?? "";
  }

  // ── Private: response parsing ─────────────────────────────────────────────

  private parseResponse(raw: string, entities: RegistryEntry[]): Tier2Result {
    let text = raw.trim();

    // Strip markdown code fences if the model wrapped the JSON
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Last resort: find the outermost { ... } block
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return {};
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return {};
      }
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const result: Tier2Result = {};

    for (const [key, attrs] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      const canonicalName = this.matchEntityName(key, entities);
      if (!canonicalName) continue;
      if (typeof attrs !== "object" || attrs === null) continue;

      result[canonicalName] = {};
      for (const [attr, val] of Object.entries(
        attrs as Record<string, unknown>
      )) {
        if (typeof val !== "object" || val === null) continue;
        const { value, quote } = val as Record<string, unknown>;
        if (typeof value === "string" && value.trim()) {
          result[canonicalName][attr.toLowerCase().trim()] = {
            value: value.trim(),
            quote: typeof quote === "string" ? quote.trim() : "",
          };
        }
      }
    }

    return result;
  }

  /** Case-insensitive match of an LLM-returned name against registry entries (names + aliases). */
  private matchEntityName(key: string, entities: RegistryEntry[]): string | null {
    const keyLower = key.toLowerCase().trim();
    for (const entry of entities) {
      if (entry.name.toLowerCase() === keyLower) return entry.name;
      if (entry.aliases.some((a) => a.toLowerCase() === keyLower)) {
        return entry.name;
      }
    }
    return null;
  }
}
