/**
 * Unit tests for /api/cli-tools/zcode-settings (ZCode integration).
 *
 * Covers the destructive config-write paths against a temp "home" dir:
 *  - GET never 500s on missing/corrupt config (SC-004)
 *  - POST creates the 9Router entry (UUID key) and stamps the afrouter
 *    ownership marker on written models (research D2)
 *  - POST refresh preserves user-tuned fields (variants/name/priority, FR-005)
 *  - DELETE is marker-scoped: user-added models survive (FR-008)
 *  - DELETE removes the whole entry only when its models map empties
 *
 * os.homedir is redirected to a per-test temp dir; global.fetch is rejected so
 * spec resolution takes the deterministic static-registry/fallback path.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: null }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => (state.home ? state.home : actual.homedir());
  return { ...actual, default: { ...actual, homedir } };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: () => ({ contextWindow: Number.NaN, maxOutput: Number.NaN }),
}));

// Reject every fetch so resolveModelSpecs() takes the fallback path (deterministic).
const realFetch = global.fetch;
global.fetch = () => Promise.reject(new Error("offline test"));

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/zcode-settings/route.js");

const configPath = () => path.join(state.home, ".zcode", "v2", "config.json");

function writeFixture(obj) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

function findEntry(config) {
  return Object.values(config.provider).find((v) => v.name === "9Router" && v.source === "custom");
}

function post(body) {
  return POST({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-settings-test-"));
});

afterAll(() => {
  global.fetch = realFetch;
  state.home = null;
});

describe("GET /api/cli-tools/zcode-settings", () => {
  it("returns installed:false (never 500) when the config file is missing", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.zcode).toBeNull();
  });

  it("returns corrupt:true (never 500) when the config file is invalid JSON", async () => {
    writeFixtureRaw("{not json");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.corrupt).toBe(true);
    expect(res.body.zcode).toBeNull();
  });

  it("reports the 9Router entry with afrouterModels separated", async () => {
    writeFixture({
      provider: {
        "user-entry": {
          name: "9Router",
          source: "custom",
          kind: "openai-compatible",
          options: { baseURL: "http://localhost:20128/v1" },
          models: {
            "mine/custom-model": { zcode: { modalitiesConfigured: true } },
            "cl/z-ai/glm-5.3-flash": { zcode: { modalitiesConfigured: true, afrouter: true } },
          },
        },
      },
    });
    const res = await GET();
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.zcode.models).toHaveLength(2);
    expect(res.body.zcode.afrouterModels).toEqual(["cl/z-ai/glm-5.3-flash"]);
    expect(res.body.ambiguousEntry).toBe(false);
  });
});

function writeFixtureRaw(text) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), text);
}

describe("POST /api/cli-tools/zcode-settings", () => {
  it("rejects missing baseUrl or models with 400", async () => {
    const res = await post({ baseUrl: "", models: [] });
    expect(res.status).toBe(400);
  });

  it("creates the entry under a fresh UUID key with marker + fallback specs, never touching other providers", async () => {
    writeFixture({ provider: { "builtin:zai": { name: "Z.ai - Coding Plan", source: "builtin" } } });
    const res = await post({ baseUrl: "http://localhost:20128", apiKey: "sk_x", models: ["unknown/model-x"] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.unverified).toEqual(["unknown/model-x"]);

    const cfg = readConfigFile();
    const keys = Object.keys(cfg.provider);
    expect(keys).toContain("builtin:zai");
    const entryKey = keys.find((k) => cfg.provider[k].name === "9Router" && cfg.provider[k].source === "custom");
    expect(entryKey).toMatch(/^[0-9a-f-]{36}$/);
    const entry = cfg.provider[entryKey];
    expect(entry.kind).toBe("openai-compatible");
    expect(entry.options.baseURL).toBe("http://localhost:20128/v1");
    const m = entry.models["unknown/model-x"];
    expect(m.limit).toEqual({ context: 200000, output: 32000 });
    expect(m.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(m.reasoning).toBeUndefined();
    expect(m.zcode.afrouter).toBe(true);
  });

  it("omits the reasoning block for models without reasoning support", async () => {
    writeFixture({ provider: {} });
    await post({ baseUrl: "http://localhost:20128/v1", models: ["unknown/no-reasoning-model"] });
    const cfg = readConfigFile();
    expect(findEntry(cfg).models["unknown/no-reasoning-model"].reasoning).toBeUndefined();
  });

  it("refreshes limit/modalities of an existing model but preserves variants/name/priority (FR-005)", async () => {
    writeFixture({
      provider: {
        existing: {
          name: "9Router",
          source: "custom",
          kind: "openai-compatible",
          options: { apiKey: "old", baseURL: "http://old:1/v1" },
          models: {
            "cl/z-ai/glm-5.3-flash": {
              name: "My GLM",
              reasoning: { enabled: true, variants: ["enabled", "off"], defaultVariant: "enabled" },
              limit: { context: 1, output: 2 },
              modalities: { input: ["text"], output: ["text"] },
              zcode: { modalitiesConfigured: true, afrouter: true, priority: 100 },
            },
          },
        },
      },
    });
    const res = await post({ baseUrl: "http://localhost:20128/v1", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    const entry = findEntry(cfg);
    const m = entry.models["cl/z-ai/glm-5.3-flash"];
    expect(m.name).toBe("My GLM");
    expect(m.reasoning.variants).toEqual(["enabled", "off"]);
    expect(m.reasoning.defaultVariant).toBe("enabled");
    expect(m.zcode.priority).toBe(100);
    expect(m.limit.output).toBe(32000);
    expect(entry.options.baseURL).toBe("http://localhost:20128/v1");
  });

  it("preserves pre-existing user-added models byte-identical (FR-004)", async () => {
    const userModel = { limit: { context: 999, output: 9 }, modalities: { input: ["text"], output: ["text"] } };
    writeFixture({
      provider: {
        existing: {
          name: "9Router",
          source: "custom",
          kind: "openai-compatible",
          options: { apiKey: "k", baseURL: "http://x/v1" },
          models: { "mine/hand-added": userModel },
        },
      },
    });
    await post({ baseUrl: "http://x/v1", models: ["unknown/new-model"] });
    const cfg = readConfigFile();
    expect(findEntry(cfg).models["mine/hand-added"]).toEqual(userModel);
  });

  it("refuses to write when the config is corrupt (file untouched)", async () => {
    writeFixtureRaw("{corrupt");
    const res = await post({ baseUrl: "http://x/v1", models: ["m"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{corrupt");
  });
});

describe("DELETE /api/cli-tools/zcode-settings", () => {
  function deleteFixture() {
    return {
      provider: {
        e1: {
          name: "9Router",
          source: "custom",
          kind: "openai-compatible",
          options: {},
          models: {
            "af/one": { zcode: { afrouter: true } },
            "af/two": { zcode: { afrouter: true } },
            "mine/keep": { zcode: { modalitiesConfigured: true } },
          },
        },
      },
    };
  }

  it("removes only marker-carrying models; user-added survive (FR-008)", async () => {
    writeFixture(deleteFixture());
    const res = await del(null);
    expect(res.body.removed).toBe(2);
    expect(res.body.entryRemoved).toBe(false);
    const entry = findEntry(readConfigFile());
    expect(Object.keys(entry.models)).toEqual(["mine/keep"]);
  });

  it("single-model delete is idempotent for user-added models (removed: 0)", async () => {
    writeFixture(deleteFixture());
    const res = await del("mine/keep");
    expect(res.body.removed).toBe(0);
    expect(findEntry(readConfigFile()).models["mine/keep"]).toBeDefined();
  });

  it("removes the entry only when its models map becomes empty", async () => {
    const f = deleteFixture();
    f.provider.e1.models = { "af/only": { zcode: { afrouter: true } } };
    writeFixture(f);
    const res = await del(null);
    expect(res.body.entryRemoved).toBe(true);
    expect(findEntry(readConfigFile())).toBeUndefined();
  });

  it("is a no-op success when there is no 9Router entry", async () => {
    writeFixture({ provider: {} });
    const res = await del(null);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
  });

  it("writes a timestamped backup next to the config before each write", async () => {
    writeFixture(deleteFixture());
    await del(null);
    const siblings = fs.readdirSync(path.dirname(configPath()));
    expect(siblings.some((f) => /^config\.json\.bak-\d{8}-\d{6}$/.test(f))).toBe(true);
  });
});
