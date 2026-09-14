# Feature Specification: ZCode Integration

**Feature Branch**: `001-zcode-integration`

**Created**: 2026-09-14

**Status**: Draft

**Input**: User description: "Add ZCode support to the CLI-tools page so AFRouter can automatically connect ZCode to itself, something like Hermes/OpenCode — detect a local ZCode installation, read its model config, and write/merge a 9Router provider entry pointing at AFRouter."

## Clarifications

### Session 2026-09-14

- Q: Should the first version ship the dashboard card only, or include the CLI launcher menu integration too? → A: Dashboard card only in v1; CLI launcher parity deferred to a follow-up.
- Q: When the user clicks Apply, should the write silently merge or show a preview diff first? → A: Silent merge on Apply, matching Hermes/OpenCode behavior; timestamped backup plus atomic write covers safety.
- Q: If ZCode is running while Apply writes its config, what should happen? → A: Atomic write plus backup, and tell the user to restart ZCode if running.
- Q: Should the card offer single-model apply, multi-model management, or both? → A: Multi-model list management (OpenCode style).
- Q: Should Reset remove the whole 9Router entry or only AFRouter-added models? → A: Remove only AFRouter-added models, keep user-added ones.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect ZCode to AFRouter from the dashboard (Priority: P1)

A user running AFRouter and ZCode on the same machine opens the dashboard CLI-tools page, expands the ZCode card, picks an endpoint, an API key, and one or more models, and clicks Apply. ZCode's model picker then offers those models routed through AFRouter.

**Why this priority**: This is the entire value of the feature — one-click routing of ZCode traffic through AFRouter. Everything else is refinement.

**Independent Test**: With ZCode installed locally, expand the ZCode card, select one model, and click Apply. Then parse `~/.zcode/v2/config.json` and confirm a provider entry named `9Router` exists with the chosen model and the AFRouter base URL. Click Reset and confirm the entry is removed.

**Acceptance Scenarios**:

1. **Given** ZCode is installed (its config file exists) and AFRouter has an active provider, **When** the user applies one model with the local endpoint, **Then** `config.json` contains a `9Router` entry with `kind: "openai-compatible"`, the AFRouter `/v1` base URL, and the model key present in its `models` map.
2. **Given** the `9Router` entry already points at the selected endpoint, **When** the card status is evaluated, **Then** the card shows the "Connected" state.
3. **Given** the user clicks Reset, **When** the reset completes, **Then** the `9Router` entry no longer routes to AFRouter and the card leaves the "Connected" state.

---

### User Story 2 - Manage multiple ZCode models with catalog-accurate specs (Priority: P2)

A user adds several AFRouter models to ZCode at once, refreshes their specs from AFRouter's live model catalog, or removes a single model without disturbing the rest.

**Why this priority**: Real ZCode configs carry many models (22 in the observed config). Single-model-only support would force tedious repeated applies and risk wiping user data on overwrite.

**Independent Test**: Apply with two models, verify both model keys exist with correct `limit`/`modalities`/`reasoning` blocks. Remove one model, verify the other remains untouched.

**Acceptance Scenarios**:

1. **Given** an existing `9Router` entry with user models, **When** the user applies additional models, **Then** the new models are merged into the existing `models` map and pre-existing model entries are preserved byte-for-byte.
2. **Given** AFRouter's `/v1/models` catalog reports capabilities for a model, **When** the model is written to ZCode config, **Then** its `limit`, `modalities`, and `reasoning` blocks match the catalog (reasoning block present only when the catalog reports reasoning support).

---

### User Story 3 - Manual config for remote machines (Priority: P3)

A user whose ZCode runs on a different machine (or who prefers to configure by hand) copies a ready-made JSON snippet from the Manual Config modal into their ZCode config.

**Why this priority**: Covers remote-machine setups, but the dashboard-local flow (US1/US2) delivers the core value alone. CLI launcher menu parity is deferred to a follow-up (clarified 2026-09-14).

**Independent Test**: Open Manual Config, copy the snippet into a ZCode config on another machine, and confirm ZCode lists the model.

**Acceptance Scenarios**:

1. **Given** ZCode is not detected locally, **When** the user opens the card, **Then** they see guidance plus a working Manual Config snippet instead of a dead end.

---

### Edge Cases

- What happens when `~/.zcode/v2/config.json` does not exist (ZCode never launched)? The tool reports not-installed but still offers Manual Config.
- How does the system handle an unparseable (corrupt) `config.json`? The status endpoint returns a safe "no config" result, never a 500 that the UI misreads as "installed".
- What happens when ZCode is running and holding the config file? Writes use an atomic write (temp file + rename) plus a timestamped backup so a concurrent ZCode write cannot leave a half-written file; on success the UI advises the user to restart ZCode if it is running, since ZCode loads config at session start.
- How are non-local endpoints handled (tunnel/tailscale URLs)? Endpoint matching reuses the existing `matchKnownEndpoint` helper so "Connected" vs "Other" states stay consistent with other cards.
- What happens when no `9Router` entry exists yet? POST creates one under a fresh UUID key; lookup is always by `"name": "9Router"`, never by a hardcoded key.
- Active-model selection: ZCode tracks the selected provider/model in `setting.json` (`modelProviderFamilySelectedKeys`), not in `config.json`. AFRouter writes provider + models only and never touches `setting.json`; the user picks the model inside ZCode.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST detect a local ZCode installation via `config.json` existence (no `zcode` binary exists on PATH, so binary probing is a best-effort fallback only).
- **FR-002**: System MUST read and parse `~/.zcode/v2/config.json`, resolving paths via `os.homedir()` for Windows/macOS/Linux compatibility.
- **FR-003**: System MUST locate the 9Router provider entry by `"name": "9Router"` within the top-level `provider` map (builtin entries use `builtin:<slug>` keys, custom entries use UUID keys — neither may be hardcoded).
- **FR-004**: System MUST merge applied models into the existing `models` map, preserving all pre-existing model entries.
- **FR-005**: System MUST build each model entry in the observed ZCode shape: exact API model ID as key, `limit.context` from catalog `contextWindow`, `limit.output` from catalog `maxOutput`, `modalities.input` always containing `text` plus `image`/`video`/`audio` exactly when the catalog reports `vision`/`videoInput`/`audioInput` (the catalog `pdf` flag has no ZCode equivalent and MUST be ignored), `modalities.output` always `["text"]`, and `zcode: { modalitiesConfigured: true }`. When the catalog reports reasoning support the entry MUST include a `reasoning` block defaulting to `{ enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" }` (the dominant observed convention — the catalog exposes no variant list, so variants MUST NOT be derived from `thinkingFormat` or related fields); when it does not, the block MUST be omitted. Merge and refresh MUST preserve a pre-existing entry's `variants`, `defaultVariant`, `name`, and `priority` and MUST never overwrite them.
- **FR-006**: System MUST resolve model specs from AFRouter's live `GET /v1/models` catalog entry (its `capabilities` object plus top-level `context_length` / `max_completion_tokens`) and MUST NOT invent context/output limits or capability flags. Model IDs that resolve only as combos or source-aliases (e.g. `oc/…` IDs listed only as `opencode/…`) and have no direct catalog entry MUST be written with conservative fallback specs (context 200000, output 32000, text-only input) and MUST be flagged to the user as unverified rather than silently given invented capabilities.
- **FR-007**: System MUST back up `config.json` (timestamped copy next to the original) before every write and perform atomic writes.
- **FR-008**: System MUST expose GET (status: installed / hasAFRouter / models / baseURL), POST (merge-write entry), and DELETE (remove a single model, or the whole entry only when no models remain) under `/api/cli-tools/zcode-settings`, following the Hermes/OpenCode route shape. The route MUST track which model keys AFRouter added so DELETE removes only those and preserves user-added models under the same entry.
- **FR-009**: System MUST register the tool in `CLI_TOOLS` (`configType: "custom"`), the `all-statuses` batch route, the components index, and the `ToolDetailClient` card switch.
- **FR-010**: System MUST provide a Manual Config modal with a copy-paste JSON snippet for the `9Router` provider entry.
- **FR-011**: System MUST NOT read or write `~/.zcode/v2/setting.json` or `~/.zcode/cli/config.json` (active-model selection and plugin config are ZCode-owned).
- **FR-012**: System MUST report status as Connected / Not configured / Other using the shared endpoint-matching helper, consistent with existing cards.

### Key Entities

- **ZCodeProviderEntry**: The `9Router` object inside ZCode's `provider` map — `name`, `kind: "openai-compatible"`, `options` (`apiKey`, `baseURL`), `source: "custom"`, and a `models` map.
- **ZCodeModelEntry**: One model under the entry, keyed by exact API model ID, carrying `limit`, `modalities`, optional `reasoning`, and the `zcode` marker block.
- **AFRouterModelCatalog**: The live `GET /v1/models` response — the authoritative source for every spec value written into a model entry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with local ZCode and an active AFRouter provider completes connection (expand card → Apply → model visible in ZCode picker after reload) in under 2 minutes.
- **SC-002**: Applying new models to a config with pre-existing user models preserves 100% of pre-existing model entries (verified by diff).
- **SC-003**: Card status matches ground truth in all probed states (missing file, corrupt file, entry absent, entry pointing at AFRouter, entry pointing elsewhere).
- **SC-004**: A corrupt or missing `config.json` never produces a 500 from the status endpoint.

## Assumptions

- Dashboard server and ZCode run on the same machine for auto-config (same constraint as Hermes/OpenCode); remote machines use Manual Config.
- ZCode's config path (`~/.zcode/v2/config.json`) and provider-entry shape are stable and documented here from direct observation of a live config on 2026-09-14.
- The ZCode card follows the multi-model OpenCode-style UX (model list management), not the single-model Hermes input.
- ZCode picks up config changes on next session or model-picker reload; the UI states this so users do not expect instant hot-reload.
- `public/providers/zcode.png` icon asset will be added alongside the card.
- Scope is the dashboard integration (US1–US2); CLI launcher menu parity (part of US3) is included only if it stays a thin reuse of the same settings endpoint.
- Per repo convention: plain JavaScript (ESM), no version bumps or CHANGELOG edits in the feature diff, `npx eslint .` clean.
