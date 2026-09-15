# Tasks: ZCode Integration

**Input**: Design documents from `/specs/001-zcode-integration/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/zcode-settings-api.md ✅, quickstart.md ✅

**Tests**: Test tasks (T011, T015) are included and flagged **[optional]** per repo convention — justified here because the route performs destructive file writes (backup/atomic-replace of the user's ZCode config), which is exactly the kind of code that warrants regression tests. Include or drop with the flag visible.

**Organization**: Tasks grouped by user story. Story mapping: US1 = connect + reset flow (P1), US2 = multi-model management + spec fidelity (P2), US3 = manual config / not-installed guidance (P3). Design decisions referenced as D1–D6 from `research.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 / US3
- Exact file paths in every description

## Path Conventions

Single Next.js project: `src/` at repo root, tests in `tests/unit/`. No `open-sse/` changes (constitution Principle I).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Static assets and registry entry so the tool exists in the dashboard.

- [x] T001 [P] Add icon asset `public/providers/zcode.png` (32×32-pixel-friendly square PNG consistent with existing `/providers/*.png` cards; fall back to a neutral monogram if no official logo asset is available)
- [x] T002 Register tool id `zcode` in `CLI_TOOLS` in `src/shared/constants/cliTools.js` — `configType: "custom"`, `image: "/providers/zcode.png"`, description "ZCode AI coding agent", plus notes: info "AFRouter writes a `AFRouter` provider entry into `~/.zcode/v2/config.json`"; warning "Config path: Linux/macOS ~/.zcode/v2/config.json • Windows %USERPROFILE%\\.zcode\\v2\\config.json"; warning "ZCode loads config at session start — restart ZCode after Apply if it is running."

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Route file skeleton with shared config-I/O helpers + status endpoint + card registration glue. No user story work starts before this phase.

**⚠ CRITICAL**: US1–US3 all depend on the helpers in T003 and the GET contract in T004.

- [x] T003 Create `src/app/api/cli-tools/zcode-settings/route.js` with shared helpers (no handlers yet): (a) path resolution via `path.join(os.homedir(), ".zcode", "v2", "config.json")` — never hardcode Windows/POSIX variants; (b) `readConfig()` safe parse: `ENOENT` → `{ installed: false }`, JSON parse error → `{ corrupt: true }`, never throws to handler (SC-004); (c) entry lookup per D4: scan top-level `provider` map for entry with `name === "AFRouter"` **and** `source === "custom"` (ignore `builtin:*` lookalikes; return first match + `ambiguousEntry` flag when >1); (d) `writeConfigAtomic()` per D3: timestamped backup `config.json.bak-<YYYYMMDD-HHmmss>` via `fs.copyFile`, serialize full JSON with 2-space indent, write `config.json.tmp`, `fs.rename` tmp→config with up to 3 retries on `EPERM`/`EACCES` at 150 ms delay, fail cleanly with backup intact
- [x] T004 Implement `GET` in `src/app/api/cli-tools/zcode-settings/route.js` per contract `specs/001-zcode-integration/contracts/zcode-settings-api.md`: `{ installed, hasAFRouter, configPath, zcode: { models, afrouterModels (keys with `zcode.afrouter === true`), unverified, baseURL }, ambiguousEntry }`; not-installed → `{ installed: false, zcode: null, message: "ZCode is not installed" }`; corrupt file → `{ installed: true, corrupt: true, zcode: null }` — no 500 in any missing/corrupt case (SC-004)
- [x] T005 [P] Register the getter in `src/app/api/cli-tools/all-statuses/route.js` — import `GET as zcodeGet` from `../zcode-settings/route` and add `zcode: zcodeGet` to `STATUS_GETTERS`
- [x] T006 [P] Export `ZCodeToolCard` from `src/app/(dashboard)/dashboard/cli-tools/components/index.js` and add `case "zcode": return <ZCodeToolCard …commonProps />` to `renderToolCard()` in `src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js`; create the card file initially as a status-only stub (fetches GET, renders installed/configured badge) — interactive flow lands in T010

---

## Phase 3: User Story 1 — Connect ZCode to AFRouter (Priority: P1)

**Story goal**: Local user expands the ZCode card, applies one or more models, and ZCode routes through AFRouter; Reset undoes it.

**Independent test**: Apply one model → parse `~/.zcode/v2/config.json`, confirm `AFRouter` entry (`kind: "openai-compatible"`, AFRouter baseURL, model key present); Reset → entry no longer routes to AFRouter, card leaves Connected.

- [x] T007 [US1] Implement catalog spec resolution in `src/app/api/cli-tools/zcode-settings/route.js` (D1 + FR-005 + FR-006): `resolveModelSpecs(ids)` self-fetches `http://127.0.0.1:${process.env.PORT || 20128}/v1/models` (no auth) and maps per ID → `{ contextWindow, maxOutput, vision, videoInput, audioInput, reasoning }`; on fetch failure fall back to `getCapabilitiesForModel` imported from `open-sse/providers/capabilities.js` (grok-build route precedent); IDs found in neither get conservative fallback `{ context: 200000, output: 32000, input: ["text"] }` and land in an `unverified` list — never invent values. `buildModelEntry(id, caps)` emits the exact ZCode shape from data-model.md: key = exact API model ID verbatim; `limit.context`/`limit.output` from caps; `modalities.input` = `["text"]` + `image` when `vision`, `video` when `videoInput`, `audio` when `audioInput` (catalog `pdf` flag ignored — no ZCode equivalent); `modalities.output` always `["text"]`; `reasoning: { enabled: true, variants: ["low","high","max"], defaultVariant: "max" }` only when caps.reasoning (variants MUST NOT be derived from `thinkingFormat`/`thinkingCanDisable`/`thinkingRange`); `zcode: { modalitiesConfigured: true, afrouter: true }` ownership marker per D2
- [x] T008 [US1] Implement `POST` in `src/app/api/cli-tools/zcode-settings/route.js` per contract: require `baseUrl` + non-empty `models` array (400 otherwise); normalize `/v1`; resolve specs (T007); upsert entry — fresh `crypto.randomUUID()` key when absent, create `{ name: "AFRouter", kind: "openai-compatible", options: { apiKey, baseURL }, source: "custom", models: {} }`; merge models additively into existing `models` map (pre-existing keys preserved — FR-004); when `apiKey` absent keep existing entry's key; write via `writeConfigAtomic`; respond `{ success, message, configPath, backupPath, written, unverified, restartAdvice: true }`; corrupt config → refuse with `{ success: false, error }`, file untouched
- [x] T009 [US1] Implement `DELETE` in `src/app/api/cli-tools/zcode-settings/route.js` per contract + D2: `?model=<id>` removes that model only if it carries the `zcode.afrouter === true` marker (user-added model of same id → respond idempotently `removed: 0`, not an error); no query → remove all marker-carrying models; backup before write; delete the whole `AFRouter` entry only when its `models` map becomes empty; respond `{ success, message, entryRemoved }`
- [x] T010 [US1] Build interactive `ZCodeToolCard` in `src/app/(dashboard)/dashboard/cli-tools/components/ZCodeToolCard.js` modeled on `OpenCodeToolCard`: status hydration from GET; `BaseUrlSelect` (local/tunnel/tailscale presets) + `ApiKeySelect`; model picking via `ModelSelectModal`; Apply → POST with selected model(s) → success message shows restart advice ("Restart ZCode if it is running — it loads config at session start") and `rememberEndpoint`; Reset → DELETE; status badges Connected / Not configured / Other via `matchKnownEndpoint`; Manual Config modal with `AFRouter` entry JSON snippet (includes `zcode.afrouter` marker and `${apiKey}` placeholder)
- [x] T011 [US1] **[optional]** Add `tests/unit/zcode-settings.test.js` covering route helpers with a temp-dir config fixture: GET never-500 on missing/corrupt file; POST creates entry with UUID key + writes marker; DELETE marker-scoping (user-added model without marker survives); atomic write produces valid JSON and a timestamped backup. Judge with `tests/__baseline__/verify-no-regression.mjs`, not raw pass counts

---

## Phase 4: User Story 2 — Multi-model management with catalog-accurate specs (Priority: P2)

**Story goal**: Apply several models at once, refresh specs, remove one — without touching the rest or user-tuned fields.

**Independent test**: Apply two models → both keys exist with correct `limit`/`modalities`/`reasoning`; remove one → other untouched.

**Depends on**: Phase 2 + Phase 3 (T007–T010).

- [x] T012 [US2] Implement user-field preservation in the POST merge path of `src/app/api/cli-tools/zcode-settings/route.js` (FR-005): when a model key already exists in the entry, refresh ONLY `limit` and `modalities` from the catalog and MUST NOT overwrite existing `reasoning.variants`, `reasoning.defaultVariant`, `name`, or `zcode.priority` of that entry (quote from spec: "Merge and refresh MUST preserve a pre-existing entry's `variants`, `defaultVariant`, `name`, and `priority` and MUST never overwrite them"); brand-new keys get the full T007 shape
- [x] T013 [US2] Surface `unverified` end-to-end (FR-006): include `unverified` in GET `zcode` payload (persisted by reading which entry models lack catalog resolution at status time); card renders an "unverified specs" badge listing those IDs with their conservative fallback values
- [x] T014 [US2] Extend `ZCodeToolCard` to multi-model list management (OpenCode style): hydrate current list from GET `afrouterModels`; allow multiple adds before Apply; per-model remove button → `DELETE ?model=`; single Active-model is NOT written anywhere (ZCode tracks selection in its own `setting.json` — FR-011: never read or write `~/.zcode/v2/setting.json` or `~/.zcode/cli/config.json`)
- [x] T015 [US2] **[optional]** Extend `tests/unit/zcode-settings.test.js`: re-apply preserves user-tuned `variants`/`name`/`priority` on an existing key (T012 contract); unverified ID gets fallback specs and appears in the unverified list

---

## Phase 5: User Story 3 — Manual config & not-installed guidance (Priority: P3)

**Story goal**: No local ZCode (or remote machine) → user still succeeds via copy-paste config.

**Independent test**: Config absent → card shows guidance + working Manual Config snippet.

**Depends on**: Phase 2 (GET contract).

- [x] T016 [US3] Implement not-installed + corrupt states in `ZCodeToolCard`: when GET returns `installed: false` show install guidance ("Launch ZCode once so it creates `~/.zcode/v2/config.json`") with Manual Config button prominent; corrupt state shows a distinct "config unreadable" message pointing at the latest `config.json.bak-*`; Manual Config snippet matches the exact entry shape from data-model.md (name/kind/options/source/models + `zcode.afrouter` marker) so remotely-pasted configs get identical ownership semantics on later dashboard runs

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Constitution-mandated quality gates.

- [x] T017 Run `npx eslint .` from repo root and fix all findings in touched files (`src/app/api/cli-tools/zcode-settings/route.js`, `ZCodeToolCard.js`, `cliTools.js`, `all-statuses/route.js`, `components/index.js`, `ToolDetailClient.js`)
- [x] T018 Run `cd tests && npx vitest run unit/zcode-settings.test.js`, then judge the whole suite with `node tests/__baseline__/verify-no-regression.mjs` (never raw pass counts — constitution V); walk quickstart.md Scenarios 1–5 against the running dashboard and record results in the PR description

---

## Dependencies & Execution Order

```text
Phase 1 (T001, T002 — parallel)
  └─> Phase 2 (T003 → T004; T005 ∥ T006 after T004 lands)
        └─> Phase 3 / US1 (T007 → T008 → T009 → T010 → T011)
              └─> Phase 4 / US2 (T012 → T013 ∥ T014 → T015)
        └─> Phase 5 / US3 (T016 — needs only Phase 2 GET; can start after US1 card exists for shared components, i.e. after T010)
              └─> Phase 6 (T017 → T018 — after all phases)
```

- US2 depends on US1's POST/DELETE and card (T012 extends the merge path; T014 extends the card).
- US3 depends only on the GET contract + card shell, but practically lands after US1 to reuse the finished card file.
- MVP = Phases 1–3 (US1 fully shippable: connect + reset). US2/US3 are independent increments on top.

## Parallel Execution Examples

- After T004: run T005 and T006 concurrently (different files).
- T001 ∥ T002 ∥ T003-safe-helpers drafting (icon, constants, route skeleton are independent files).
- Within US2: T013 (route+card badge) and T014 (card list UI) touch the same card file — run T014 after T013 or sequence carefully; T012 is route-only and parallel with both.

## Implementation Strategy

1. **MVP first**: Land Phases 1–3. The card connects and resets — spec's P1 story done end-to-end with quickstart Scenarios 1–3 passing.
2. **Incremental**: US2 hardens merge semantics and multi-model UX; US3 completes guidance. Each is independently testable per its Independent Test line.
3. **Never in scope**: `open-sse/` changes, `setting.json`/`~/.zcode/cli/config.json` access, version bumps, CHANGELOG edits (repo convention + clarified scope).
