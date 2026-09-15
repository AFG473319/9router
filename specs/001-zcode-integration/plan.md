# Implementation Plan: ZCode Integration

**Branch**: `001-zcode-integration` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-zcode-integration/spec.md`

## Summary

Add a ZCode card to the AFRouter dashboard CLI-tools page that detects a local ZCode installation via `~/.zcode/v2/config.json`, and on Apply merges a `AFRouter` provider entry (`kind: "openai-compatible"`) pointing at AFRouter's `/v1` endpoint, with model specs sourced from AFRouter's live `/v1/models` catalog. Reset removes only AFRouter-added models. Mirrors the Hermes/OpenCode card + settings-route pattern; no engine (`open-sse/`) changes — all app-side (`src/`) work.

## Technical Context

**Language/Version**: JavaScript (ESM), Node ≥ 20 (Next.js 15 App Router server routes)

**Primary Dependencies**: Next.js 15 (App Router), React 18, shared UI components, plain `fs/promises` for file I/O

**Storage**: N/A — AFRouter-side state is zero; all state lives in ZCode's own `~/.zcode/v2/config.json` (external, ZCode-owned)

**Testing**: vitest (independent `tests/` package), judged against `tests/__baseline__/verify-no-regression.mjs` per constitution

**Target Platform**: AFRouter dashboard (Next.js server routes + React cards), cross-platform home-dir paths (Windows/macOS/Linux via `os.homedir()`)

**Performance Goals**: Status endpoint answers in < 500 ms including config parse; Apply completes in < 2 s including backup + atomic write

**Constraints**: Must not corrupt or clobber ZCode-owned data (silent merge, ownership-tracked delete); never 500 on corrupt/missing config; preserve user-tuned model fields (`variants`, `defaultVariant`, `name`, `priority`); never touch `setting.json` or `~/.zcode/cli/config.json`; plain JS/ESM only, no TypeScript

**Scale/Scope**: One new API route + one card component + registry additions; single-machine scope (dashboard and ZCode co-located); ~6 files touched/added

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Impact | Assessment |
|---|-----------|--------|------------|
| I | Engine-App Boundary Discipline | none | All work is app-side (`src/` + `public/`); zero `open-sse/` changes. |
| II | Translation Correctness via Pivot and Direct Routes | none | No translator work in scope. |
| III | Credential and Request Security (NON-NEGOTIABLE) | low | Route returns config contents to the dashboard (same as existing tool cards). API key handling reuses the ApiKeySelect flow; the ZCode config's `options.apiKey` is the user's own AFRouter key stored in their own home dir. No secrets logged; no X-Forwarded-For handling touched. |
| IV | Data Integrity via SQLite Adapter Chain | none | No AFRouter-side persistence added; ZCode's config JSON is external, not AFRouter state. |
| V | Regression-Gated Quality | low | New tests go under `tests/unit/` and are judged with `verify-no-regression.mjs`; provider registry/alias untouched so `verify-*.mjs` provider checks are not triggered. All changes must pass `npx eslint .` and Conventional Commits. |

**Pre-design gate: PASS** — no violations. Post-design re-check (end of this file): **PASS**.

## Project Structure

### Documentation (this feature)

```text
specs/001-zcode-integration/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output ($speckit-tasks — NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
src/
├── shared/constants/cliTools.js                # register `zcode` entry in CLI_TOOLS
├── app/api/cli-tools/zcode-settings/route.js   # NEW: GET / POST / DELETE
├── app/api/cli-tools/all-statuses/route.js     # import + register zcode getter
└── app/(dashboard)/dashboard/cli-tools/
    ├── components/ZCodeToolCard.js             # NEW: card UI (OpenCode-style multi-model)
    ├── components/index.js                     # export ZCodeToolCard
    └── [toolId]/ToolDetailClient.js            # case "zcode" → ZCodeToolCard

public/providers/zcode.png                      # icon asset

tests/unit/zcode-settings.test.js               # NEW: route unit tests (parse/merge/delete ownership)

open-sse/                                       # untouched — no engine changes
```

**Structure Decision**: Follow the established `<tool>-settings` route + `<Tool>ToolCard` component pattern (Hermes/OpenCode precedent). Registration touches four known integration points: `CLI_TOOLS` constants, `all-statuses` batch route, `components/index.js`, and the `ToolDetailClient` card switch.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — design stays within existing patterns; no new abstractions.

## Post-Design Constitution Re-Check

*GATE: Re-evaluated after Phase 1 artifacts (data-model.md, contracts/, quickstart.md) were produced.*

| # | Principle | Assessment |
|---|-----------|------------|
| I | Engine-App Boundary | PASS — artifacts confirm zero `open-sse/` surface changes; contracts define only dashboard HTTP routes + ZCode config file shapes. |
| II | Translation Correctness | PASS — no translators, no pivot logic in scope. |
| III | Credential & Request Security | PASS — API contract returns config data to the authenticated dashboard only, consistent with existing cli-tools routes; no logging of secrets; no IP/forwarding-header code touched. |
| IV | Data Integrity via SQLite | PASS — no AFRouter-side persistence; external JSON file handled with backup + atomic write. |
| V | Regression-Gated Quality | PASS — unit tests planned under `tests/unit/` judged via `verify-no-regression.mjs`; eslint + Conventional Commits required. |

**Post-design gate: PASS** — no violations; complexity tracking table remains empty.
