# Quickstart: ZCode Integration

**Feature**: `001-zcode-integration` | **Date**: 2026-09-14

End-to-end validation that the ZCode card connects ZCode to AFRouter. Run from repo root with the dashboard built/running and at least one active provider connection.

## Prerequisites

- AFRouter running (`PORT=20128`, dashboard reachable at `/dashboard`, logged in).
- ZCode installed locally (its config exists at `~/.zcode/v2/config.json`). To exercise the not-installed path, temporarily rename the config file.
- Node ≥ 20 (for the verification one-liners).

## Scenario 1 — Apply & verify config (US1 + US2)

1. Open `/dashboard/cli-tools`, expand the **ZCode** card → status should read **Not configured** (or **Connected** if previously applied).
2. Pick endpoint (default local), API key, and 1–2 models; click **Apply**. Expect success message with restart advice.
3. Verify on disk:

   ```sh
   node -e "const c=require(require('os').homedir()+'/.zcode/v2/config.json');const e=Object.values(c.provider).find(v=>v.name==='9Router'&&v.source==='custom');console.log(e.options.baseURL, Object.keys(e.models))"
   ```

   Expect the applied baseURL and model IDs. Confirm a timestamped `config.json.bak-*` sibling was created. Expect per-model shape per [data-model.md](data-model.md) — e.g. reasoning block present iff catalog `reasoning` is true; `zcode.afrouter: true` on written models.

## Scenario 2 — User data survives merge & reset (SC-002, FR-004/008)

1. Hand-add a model under the `9Router` entry's `models` (any key, minimal shape, no `zcode.afrouter` marker).
2. Apply a different model from the card. Verify the hand-added model is still present byte-identical.
3. Click **Reset**. Verify: AFRouter-marked models gone, hand-added model still present, entry retained (`entryRemoved: false`). Delete the hand-added model by hand afterwards.

## Scenario 3 — Corrupt-config safety (SC-004)

1. Write invalid JSON into `~/.zcode/v2/config.json`.
2. Reopen the ZCode card → status shows a safe not-configured state, no error toast from a 500.
3. Apply → route refuses with a clear error; file left untouched. Restore the file from the latest `.bak-*` (or let ZCode recreate it).

## Scenario 4 — Manual Config & remote machine (US3)

1. Rename the local config away (simulates ZCode absent). Card shows guidance + **Manual Config**.
2. Copy the snippet into a real `config.json` on another machine (or paste locally after restoring), launch ZCode, open the model picker → the 9Router provider lists the snippet's models.

## Scenario 5 — ZCode round-trip (D2 risk check)

1. With models applied, relaunch ZCode and open its model picker: the 9Router provider lists the applied models.
2. Change a setting inside ZCode that rewrites its config, then re-check `config.json`: the `zcode.afrouter` markers on AFRouter-written models must survive (if ZCode strips unknown `zcode` keys, D2's fallback plan activates — report it).

## Regression & lint gate (constitution V)

```sh
cd tests && npx vitest run unit/zcode-settings.test.js   # new route tests
npx eslint .                                             # clean
```

Judge the full suite with `tests/__baseline__/verify-no-regression.mjs` — never raw pass counts.
