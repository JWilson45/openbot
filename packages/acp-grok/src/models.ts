import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_GROK_MODEL = "grok-4.6";
export const DEFAULT_REASONING_EFFORT = "high";

export type GrokEffort = {
  id: string;
  value: string;
  label: string;
  description: string;
  default?: boolean;
};

export type GrokModelInfo = {
  id: string;
  name: string;
  description: string;
  defaultEffort: string;
  reasoningEfforts: GrokEffort[];
};

const FALLBACK_MODELS: GrokModelInfo[] = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    description: "SpaceXAI's latest frontier model",
    defaultEffort: "high",
    reasoningEfforts: [
      effort("xhigh", "Extra High", "Highest effort and reasoning"),
      effort("high", "High", "Higher quality with extensive reasoning", true),
      effort("medium", "Medium", "Balanced effort"),
      effort("low", "Low", "Quick, fast replies"),
    ],
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    description: "Previous frontier model",
    defaultEffort: "high",
    reasoningEfforts: [
      effort("high", "High", "Highest quality with extensive reasoning", true),
      effort("medium", "Medium", "Balanced effort"),
      effort("low", "Low", "Quick, fast replies"),
    ],
  },
];

function effort(value: string, label: string, description: string, isDefault = false): GrokEffort {
  return { id: value, value, label, description, default: isDefault };
}

export function listGrokModels(openbotHome?: string, userHome = process.env.HOME || homedir()): GrokModelInfo[] {
  const paths = [
    openbotHome ? join(openbotHome, "grok-home", "models_cache.json") : "",
    join(userHome, ".grok", "models_cache.json"),
  ].filter(Boolean);
  for (const p of paths) {
    const parsed = readModelsCache(p);
    if (parsed.length) return parsed;
  }
  return FALLBACK_MODELS;
}

export function resolveBotInference(
  catalog: GrokModelInfo[],
  model?: string | null,
  effort?: string | null,
): { model: string; reasoningEffort: string } {
  const models = catalog.length ? catalog : FALLBACK_MODELS;
  const chosen = models.find((m) => m.id === String(model ?? "").trim()) ?? models[0]!;
  const allowed = chosen.reasoningEfforts;
  const want = String(effort ?? "").trim();
  const pick =
    allowed.find((e) => e.value === want || e.id === want) ??
    allowed.find((e) => e.default) ??
    allowed.find((e) => e.value === chosen.defaultEffort) ??
    allowed[0];
  return { model: chosen.id, reasoningEffort: pick?.value ?? DEFAULT_REASONING_EFFORT };
}

function readModelsCache(path: string): GrokModelInfo[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      models?: Record<string, { info?: Record<string, unknown> } | Record<string, unknown>>;
    };
    const out: GrokModelInfo[] = [];
    for (const [id, entry] of Object.entries(raw.models ?? {})) {
      const info = ((entry as { info?: Record<string, unknown> }).info ?? entry) as Record<string, unknown>;
      if (info.hidden === true) continue;
      const efforts = Array.isArray(info.reasoning_efforts)
        ? (info.reasoning_efforts as Array<Record<string, unknown>>).map((e) => ({
            id: String(e.id ?? e.value ?? ""),
            value: String(e.value ?? e.id ?? ""),
            label: String(e.label ?? e.value ?? e.id ?? ""),
            description: String(e.description ?? ""),
            default: Boolean(e.default),
          }))
        : [];
      const cleaned = efforts.filter((e) => e.value);
      const defaultEffort =
        cleaned.find((e) => e.default)?.value ??
        String(info.reasoning_effort ?? DEFAULT_REASONING_EFFORT);
      out.push({
        id: String(info.id ?? id),
        name: String(info.name ?? id),
        description: String(info.description ?? ""),
        defaultEffort,
        reasoningEfforts: cleaned.length
          ? cleaned
          : FALLBACK_MODELS[0]!.reasoningEfforts,
      });
    }
    return out;
  } catch {
    return [];
  }
}
