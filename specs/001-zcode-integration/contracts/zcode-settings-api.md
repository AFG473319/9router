# Contracts: ZCode Integration

**Feature**: `001-zcode-integration` | **Date**: 2026-09-14

Two interfaces: the dashboard HTTP route (AFRouter exposes) and the ZCode config file (AFRouter writes). Config-file shape is fully specified in [data-model.md](../data-model.md); this file pins the HTTP contract. Auth and transport follow the existing cli-tools routes (same-origin dashboard session).

## POST /api/cli-tools/zcode-settings — Apply (merge)

Request:

```json
{
  "baseUrl": "http://localhost:20128/v1",
  "apiKey": "sk_… | null",
  "models": ["cl/z-ai/glm-5.3-flash", "nvidia/moonshotai/kimi-k3"]
}
```

- `baseUrl` required; `/v1` normalized server-side.
- `apiKey` optional; when absent the existing entry's key is kept (new entry: empty string, ZCode treats `apiKeyRequired: false` fine for local).
- `models` required, non-empty array of exact model IDs.

Response `200`:

```json
{
  "success": true,
  "message": "ZCode settings applied successfully!",
  "configPath": "C:\\…\\config.json",
  "backupPath": "C:\\…\\config.json.bak-20260914-101500",
  "written": ["cl/z-ai/glm-5.3-flash"],
  "unverified": [],
  "restartAdvice": true
}
```

- `written`: models actually written this call. `unverified`: subset with fallback specs (FR-006 flag).
- `restartAdvice` always true when a write happened (clarification Q3 — UI shows "restart ZCode if running").

Errors: `400` (missing baseUrl/models), `409`-style payload `{ success: false, error }` on corrupt config (write refused, backup untouched), `500` only for unexpected I/O failure after backup.

## GET /api/cli-tools/zcode-settings — Status

Response `200` (never 500 for missing/corrupt config — SC-004):

```json
{
  "installed": true,
  "hasAFRouter": true,
  "configPath": "C:\\…\\config.json",
  "zcode": {
    "models": ["<all model keys in entry>"],
    "afrouterModels": ["<keys carrying zcode.afrouter marker>"],
    "unverified": ["<keys written with fallback specs>"],
    "baseURL": "http://localhost:20128/v1"
  },
  "ambiguousEntry": false
}
```

Not-installed: `{ "installed": false, "zcode": null, "message": "ZCode is not installed" }`.

Card contract: model chips render from `models` (everything actually in the entry, user-added included); the remove affordance renders only for ids present in `afrouterModels`, and the client must drop a chip only when the DELETE response reports `removed > 0`.

## DELETE /api/cli-tools/zcode-settings — Reset

Query: `?model=<id>` for single-model removal; absent = remove all `afrouter`-marked models.

Response `200`:

```json
{ "success": true, "message": "Removed 3 AFRouter models from ZCode", "entryRemoved": false }
```

- Marker-scoped only (FR-008): user-added models in the same entry survive; `entryRemoved: true` only when the entry's models map becomes empty (entry deleted; pre-delete backup still written).
- Unknown `model` id → `200` with `removed: 0` semantics (idempotent), not an error.

## Card registration contract (internal)

Tool id `zcode` must appear in exactly four places, matching existing tools:
1. `CLI_TOOLS.zcode` in `src/shared/constants/cliTools.js` (`configType: "custom"`, image `/providers/zcode.png`).
2. `STATUS_GETTERS.zcode` in `src/app/api/cli-tools/all-statuses/route.js`.
3. `ZCodeToolCard` export in `components/index.js`.
4. `case "zcode"` in `ToolDetailClient.js` `renderToolCard()`.

## ZCode config file contract (external)

Documented normatively in [data-model.md](../data-model.md): entry located by `name === "AFRouter"` + `source === "custom"`; writes are backup → temp → atomic rename; only `~/.zcode/v2/config.json` is ever touched (`setting.json`, `~/.zcode/cli/config.json` are read/write-forbidden, FR-011).
