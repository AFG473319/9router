"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const PROVIDER_NAME = "9Router";

// Conservative fallback for IDs that resolve in neither the live catalog nor
// the static registry (FR-006) — written with specs flagged "unverified".
const FALLBACK_SPECS = { context: 200000, output: 32000, input: ["text"] };

const getConfigPath = () => path.join(os.homedir(), ".zcode", "v2", "config.json");

// Safe config read: ENOENT -> { installed: false }; unparseable -> { corrupt: true }.
// Never throws to the handler — the UI must never see a 500 for a bad user file (SC-004).
const readConfig = async () => {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    try {
      return { data: JSON.parse(raw) };
    } catch {
      return { corrupt: true };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { notInstalled: true };
    return { corrupt: true };
  }
};

// Locate the AFRouter entry per research D4: match on name + source, never on a
// hardcoded map key (builtin entries use `builtin:<slug>` keys, custom use UUIDs).
const findAFRouterEntry = (config) => {
  if (!config || typeof config !== "object") return { entry: null, ambiguous: false };
  const providers = config.provider && typeof config.provider === "object" ? config.provider : {};
  const hits = Object.values(providers).filter(
    (v) => v && v.name === PROVIDER_NAME && v.source === "custom"
  );
  return { entry: hits[0] || null, ambiguous: hits.length > 1 };
};

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Write sequence per research D3: timestamped backup -> temp file -> atomic rename
// with EPERM/EACCES retries (Windows file-lock races with ZCode/AV).
const writeConfigAtomic = async (config) => {
  const configPath = getConfigPath();
  const backupPath = `${configPath}.bak-${timestamp()}`;
  await fs.copyFile(configPath, backupPath);
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, configPath);
      break;
    } catch (error) {
      if ((error.code === "EPERM" || error.code === "EACCES") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw error;
    }
  }
  return { backupPath };
};

const listModelKeys = (entry) => Object.keys((entry && entry.models) || {});

const isAFRouterAdded = (modelEntry) => !!(modelEntry && modelEntry.zcode && modelEntry.zcode.afrouter === true);

// T007 (D1 + FR-005/FR-006): resolve specs from the live catalog —
// self-fetch of our own /v1/models (no auth), falling back to the static
// registry, then conservative fallback + unverified flag. Never invent values.
const resolveLiveCatalog = async () => {
  try {
    const port = process.env.PORT || 20128;
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data : [];
    const byId = new Map();
    for (const m of models) {
      if (m?.id && m.capabilities) byId.set(m.id, m.capabilities);
    }
    return byId;
  } catch {
    return null;
  }
};

const capsToSpec = (caps) => ({
  context: caps.contextWindow,
  output: caps.maxOutput,
  input: [
    "text",
    caps.vision ? "image" : null,
    caps.videoInput ? "video" : null,
    caps.audioInput ? "audio" : null,
  ].filter(Boolean),
  reasoning: caps.reasoning === true,
});

// Resolve model IDs -> per-ID spec + unverified list. Catalog first, static
// registry second, conservative fallback (flagged) last.
const resolveModelSpecs = async (ids) => {
  const catalog = await resolveLiveCatalog();
  const specs = new Map();
  const unverified = [];
  for (const id of ids) {
    let caps = catalog?.get(id) || null;
    if (!caps) {
      const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
      const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : null;
      const staticCaps = getCapabilitiesForModel(provider, bare);
      if (staticCaps && Number.isFinite(staticCaps.contextWindow)) {
        caps = staticCaps;
      }
    }
    if (caps && Number.isFinite(caps.contextWindow) && Number.isFinite(caps.maxOutput)) {
      specs.set(id, { ...capsToSpec(caps), verified: true });
    } else {
      specs.set(id, { ...FALLBACK_SPECS, reasoning: false, verified: false });
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

// T007: exact ZCode model-entry shape per data-model.md. Brand-new entries get
// the dominant reasoning convention (research D6); user-tuned fields on
// existing entries are preserved by mergeModelEntries (FR-005).
const buildModelEntry = (spec) => {
  const entry = {
    limit: { context: spec.context, output: spec.output },
    modalities: { input: spec.input, output: ["text"] },
    zcode: { modalitiesConfigured: true, afrouter: true },
  };
  if (spec.reasoning) {
    entry.reasoning = { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" };
  }
  return entry;
};

// T012 (FR-005): merge applied models additively. Existing keys are refreshed
// ONLY on limit/modalities — reasoning variants/defaultVariant, name and
// zcode.priority of a pre-existing entry are never overwritten. New keys get
// the full built shape including the afrouter ownership marker (D2).
const mergeModels = (entry, specs) => {
  const models = entry.models && typeof entry.models === "object" ? entry.models : {};
  for (const [id, spec] of specs) {
    const existing = models[id];
    if (existing && typeof existing === "object") {
      models[id] = {
        ...existing,
        limit: { context: spec.context, output: spec.output },
        modalities: { input: spec.input, output: ["text"] },
      };
    } else {
      models[id] = buildModelEntry(spec);
    }
  }
  entry.models = models;
  return entry;
};

const findEntryKey = (config) => {
  const providers = config.provider && typeof config.provider === "object" ? config.provider : {};
  return Object.keys(providers).find(
    (k) => providers[k] && providers[k].name === PROVIDER_NAME && providers[k].source === "custom"
  ) || null;
};

// POST - merge AFRouter provider entry into ZCode config (contracts/zcode-settings-api.md)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();
    const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const result = await readConfig();
    if (result.corrupt || result.notInstalled) {
      return NextResponse.json({ success: false, error: "ZCode config is missing or unreadable — fix or restore it before applying" }, { status: 409 });
    }

    const config = result.data;
    if (!config || typeof config !== "object" || !config.provider || typeof config.provider !== "object") {
      config.provider = {};
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const { specs, unverified } = await resolveModelSpecs(modelsArray);

    // Upsert entry: fresh UUID key when absent (D4), preserve otherwise.
    let entryKey = findEntryKey(config);
    if (!entryKey) {
      entryKey = crypto.randomUUID();
      config.provider[entryKey] = {
        name: PROVIDER_NAME,
        kind: "openai-compatible",
        options: { apiKey: apiKey || "", baseURL: normalizedBaseUrl },
        source: "custom",
        models: {},
      };
    }
    const entry = config.provider[entryKey];
    entry.kind = "openai-compatible";
    entry.source = "custom";
    entry.options = {
      ...entry.options,
      baseURL: normalizedBaseUrl,
      ...(apiKey ? { apiKey } : {}),
    };

    mergeModels(entry, specs);
    const { backupPath } = await writeConfigAtomic(config);

    return NextResponse.json({
      success: true,
      message: "ZCode settings applied successfully!",
      configPath: getConfigPath(),
      backupPath,
      written: modelsArray,
      unverified,
      restartAdvice: true,
    });
  } catch (error) {
    console.log("Error applying zcode settings:", error);
    return NextResponse.json({ error: "Failed to apply zcode settings" }, { status: 500 });
  }
}

// DELETE - marker-scoped removal (D2 / FR-008): only models carrying
// zcode.afrouter === true are removed; user-added models in the same entry
// survive. The entry itself is deleted only when its models map becomes empty.
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const result = await readConfig();
    if (result.corrupt || result.notInstalled) {
      return NextResponse.json({ success: true, message: "No ZCode config to reset", removed: 0, entryRemoved: false });
    }

    const config = result.data;
    const entryKey = findEntryKey(config);
    if (!entryKey) {
      return NextResponse.json({ success: true, message: "No 9Router entry in ZCode config", removed: 0, entryRemoved: false });
    }

    const entry = config.provider[entryKey];
    const models = entry.models && typeof entry.models === "object" ? entry.models : {};
    let removed = 0;
    for (const key of Object.keys(models)) {
      const matches = modelToRemove ? key === modelToRemove : true;
      if (matches && isAFRouterAdded(models[key])) {
        delete models[key];
        removed++;
      }
    }

    let entryRemoved = false;
    if (Object.keys(models).length === 0) {
      delete config.provider[entryKey];
      entryRemoved = true;
    }

    if (removed > 0 || entryRemoved) {
      await writeConfigAtomic(config);
    }

    return NextResponse.json({
      success: true,
      message: entryRemoved
        ? "9Router entry removed from ZCode"
        : `Removed ${removed} AFRouter model${removed === 1 ? "" : "s"} from ZCode`,
      removed,
      entryRemoved,
    });
  } catch (error) {
    console.log("Error resetting zcode settings:", error);
    return NextResponse.json({ error: "Failed to reset zcode settings" }, { status: 500 });
  }
}
// GET - report install + AFRouter routing status per contracts/zcode-settings-api.md
export async function GET() {
  try {
    const result = await readConfig();
    if (result.notInstalled) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        configPath: getConfigPath(),
        zcode: null,
        message: "ZCode is not installed",
      });
    }
    if (result.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath: getConfigPath(),
        zcode: null,
      });
    }
    const { entry, ambiguous } = findAFRouterEntry(result.data);
    const models = entry ? listModelKeys(entry) : [];
    // T013: flag entry models whose specs are not resolvable from the live
    // catalog or static registry so the card can badge them (FR-006).
    let unverified = [];
    if (entry && models.length > 0) {
      const { specs } = await resolveModelSpecs(models);
      unverified = models.filter((k) => specs.get(k) && !specs.get(k).verified);
    }
    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!entry,
      configPath: getConfigPath(),
      ambiguousEntry: ambiguous,
      zcode: {
        models,
        afrouterModels: entry ? models.filter((k) => isAFRouterAdded(entry.models[k])) : [],
        unverified,
        baseURL: entry?.options?.baseURL || null,
      },
    });
  } catch (error) {
    console.log("Error checking zcode settings:", error);
    return NextResponse.json({ error: "Failed to check zcode settings" }, { status: 500 });
  }
}
