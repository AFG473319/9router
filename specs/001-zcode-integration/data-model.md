# Data Model: ZCode Integration

**Feature**: `001-zcode-integration` | **Date**: 2026-09-14

AFRouter persists nothing. All state is ZCode-owned, in `~/.zcode/v2/config.json`. Shapes below are documented from a live config (2026-09-14) and are the contract the settings route reads/writes.

## Entities

### ZCodeConfig (read/write, external)

Top-level JSON object. Only the `provider` map is touched; every other key is preserved as-is.

```json
{ "provider": { "<id>": ZCodeProviderEntry } }
```

- `id`: `builtin:<slug>` for ZCode-shipped entries, UUID string for custom entries (observed both).

### ZCodeProviderEntry (read/write)

```json
{
  "name": "AFRouter",
  "kind": "openai-compatible",
  "options": { "apiKey": "<afrouter-key>", "baseURL": "http://localhost:20128/v1" },
  "source": "custom",
  "models": { "<modelId>": ZCodeModelEntry }
}
```

- Lookup key: `name === "AFRouter"` **and** `source === "custom"` (D4). Creation key: fresh UUID.
- `kind` is always `"openai-compatible"` for our entry. `options.baseURL` normalized to end with `/v1`.
- `models` merge semantics (FR-004): applied models are merged in; pre-existing sibling keys are never dropped or reordered.

### ZCodeModelEntry (read/write, per model)

```json
{
  "name": "<display name>",
  "reasoning": { "enabled": true, "variants": ["low","high","max"], "defaultVariant": "max" },
  "limit": { "context": 1000000, "output": 131072 },
  "modalities": { "input": ["text","image"], "output": ["text"] },
  "zcode": { "modalitiesConfigured": true, "afrouter": true, "priority": 100 }
}
```

| Field | Source | Rules |
|---|---|---|
| key (model ID) | user selection | exact API model ID, verbatim |
| `limit.context` | catalog `capabilities.contextWindow` | number; fallback 200000 when unverified |
| `limit.output` | catalog `capabilities.maxOutput` | number; fallback 32000 when unverified |
| `modalities.input` | catalog `vision`/`videoInput`/`audioInput` | `["text"]` + `image`/`video`/`audio` appended when flags true; `pdf` ignored (no ZCode equivalent) |
| `modalities.output` | constant | always `["text"]` |
| `reasoning` | catalog `reasoning` | present only when true; defaults per D6; user-tuned `variants`/`defaultVariant` never overwritten |
| `name`, `zcode.priority` | card/user | never overwritten on re-apply (FR-005) |
| `zcode.afrouter` | AFRouter write | ownership marker (D2); DELETE removes only entries carrying it |

### AFRouterModelCatalog (read-only)

`GET /v1/models` response — array of `{ id, capabilities: { vision, pdf, audioInput, videoInput, reasoning, thinkingFormat, thinkingCanDisable, contextWindow, maxOutput, … }, context_length, max_completion_tokens, owned_by }`. Authoritative for every spec value (D1). Models absent here fall back to static caps, then conservative defaults + unverified flag.

### ApplyStatus (route response, transient)

```json
{
  "installed": true,
  "hasAFRouter": true,
  "configPath": "C:\\Users\\<u>\\.zcode\\v2\\config.json",
  "zcode": { "models": ["<id>", "…"], "baseURL": "http://localhost:20128/v1", "unverified": ["<id>"] },
  "ambiguousEntry": false
}
```

Drives the card's Connected / Not configured / Other state (FR-012) via `matchKnownEndpoint`. The card renders model chips from `models` (the entry's real contents — user-added included) and gates per-model removal on `afrouterModels`; hydration is signature-guarded and skipped while the model modal is open so a status refresh never clobbers an in-progress selection.

## State transitions

| From | Trigger | To |
|---|---|---|
| no config file | GET | `installed: false` (card shows install guidance + Manual Config) |
| config file, no AFRouter entry | POST | entry created (fresh UUID), models merged |
| entry exists, apply subset | POST | models merged; user entries untouched; `afrouter` marker set on written models |
| entry exists, reset | DELETE | `afrouter`-marked models removed; entry removed only when zero models remain |
| corrupt config | GET/POST | GET → safe empty status (never 500); POST → refuse + report; backup untouched |

## Invariants

1. **User data never lost** (SC-002): merge is additive; deletes are marker-scoped; pre-apply timestamped backup always exists.
2. **ZCode-owned files untouched** (FR-011): route code reads/writes only `~/.zcode/v2/config.json` (+ its `.tmp`/backups).
3. **Never 500 on bad input file** (SC-004): parse failures degrade to "no config" status.
4. **Specs never invented** (FR-006): every written number/flag traces to the live catalog, static registry fallback, or the documented conservative default + unverified flag.
