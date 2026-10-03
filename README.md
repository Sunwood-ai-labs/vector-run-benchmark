# VECTOR RUN

A deterministic endless runner for repeatable browser-control experiments. Original geometric graphics; no Chrome assets or JevDash source.

自動で右へ走り続ける、再現性重視のブラウザゲームです。同じ Seed なら同じコース。1段・2段ジャンプを切り替え、移動距離を比較できます。

## ローカルで起動する / Run locally

Node.js 20以上が必要です。外部パッケージのインストールは不要です。

```sh
git clone https://github.com/Sunwood-ai-labs/vector-run-benchmark.git
cd vector-run-benchmark
npm test
npm run serve
```

Open http://127.0.0.1:4173 in your browser. Press **ランを開始**. Use Space, ↑, W, the jump button, or tap the play area. To change the port, set `PORT`; to allow a phone on the same trusted network to connect, explicitly set `HOST=0.0.0.0` and open your computer's local IP with that port. The default server binds only to loopback.

```sh
npm run test:http
PORT=4174 npm run serve
```

`npm test` includes 25 engine, simulated-DOM application, compatibility and real local HTTP checks. GitHub Actions runs the same suite on pushes and pull requests.

**検証状況:** 自動テスト25件とローカル HTTP 起動を確認済み。実ブラウザのプレイ操作・PC/モバイル画面のスクリーンショットレビューは未完了です。自動テストの合格を視覚確認済みとは扱いません。[QA の手順と検証範囲](docs/QA.md) を参照してください。

## 操作とルール / Jump rules

- **2段ジャンプ（default）:** Press once to jump. Release and press again while airborne for a second jump. The second press resets upward velocity to 600 world units/s. Maximum two jumps before landing.
- **1段ジャンプ:** The original one-jump rule remains selectable. Land, release, then press again.
- Landing restores the jump allowance. Holding a key never auto-jumps. Inputs beyond the allowance are ignored, not buffered. Release does not shorten the trajectory.
- Physics are fixed at 120 Hz in the same 800 × 360 world for every viewport.

## Benchmark protocol

Primary score is distance travelled / 10, in game metres. Survival seconds, speed, difficulty, and latency measurements are separate fields.

Speed starts at 250 world units/s and increases to 580 over 150 seconds. Difficulty levels rise every 15 seconds to level 10. Obstacle spacing decreases while remaining feasible for the one-jump rule. The course remains endless after the speed cap. The same seed generates the same course in both jump modes; the additional action changes the task, so their scores must be compared separately.

The real-time loop continues while an agent thinks and never discards valid catch-up timesteps. A frame gap over 100 ms, hidden tab, focus loss, or clock error ends the run as invalid. There is no pause or hidden assistance. The first terminal result is immutable.

Default seeds: 101, 202, 303, 404, 505. Each cohort takes the **first valid completed benchmark** per seed. Cohorts have an exact engine version, configuration fingerprint, jump-rule ID, and controller category (manual, agent, or no input). The UI selects the current jump rule and controller separately. Mixed manual/agent runs, practice, cancellations, invalid runs and offline replays are excluded. Incomplete seed sets are labelled preliminary.

This is local, self-reported measurement, not an anti-cheat system. Compare identical cohorts and comparable devices/observation pipelines. A runner score is not a general model-capability score.

## Exports and legacy replay

JSON includes version, rule ID, max jumps, configuration and its non-cryptographic FNV fingerprint, seed, input receipt and acceptance ticks, terminal-state fingerprint, clock checks, and environment metadata. CSV is a flat run summary. History exists only in page memory; reload clears it. Download any results you need to keep.

Import an exported JSON to replay its final run, or replay a history row. A replay recomputes and verifies input acceptance and the terminal state; it never creates a benchmark score. Version 1.0.0 records are replayed by the unchanged `dist/engine-v1.js` legacy engine. New runs use version 1.1.0 with `jump-1/v1` or `jump-2/v1`; incompatible rule/config combinations are rejected.

Imports are limited to 5 MiB, 100,000 inputs and one hour per run to avoid accidental UI lockups. Longer live runs can still be exported for external analysis.

## Agent interface

The page exposes `window.vectorRun` and, when supported by the browser, five proposed WebMCP tools:

- `start_run` / `start({seed, mode, maxJumps})`: starts live time; maxJumps is 1 or 2, default 2
- `capture_frame` / `captureFrame()`: current canvas pixels, capture tick and observation ID
- `jump` / `jump({observationId})`: press jump
- `release_jump` / `release({observationId})`: release jump
- `get_run_result` / `result()`: public current score or the last completed result

The normal observation API returns pixels, not future obstacles or hidden course state. Optional observation IDs measure capture-to-command receipt age, including downstream observation, inference and transport delay. They do not measure pure model inference time. Manual inputs have no invented decision latency. Commands without an observation ID produce no latency sample.

WebMCP registration and action contracts have simulated-context tests; actual supported-browser WebMCP behavior remains unverified.

## Files

- `dist/`: deployable static game
- `scripts/serve.mjs`: dependency-free local server
- `tests/`: deterministic, application-fixture, compatibility, and HTTP smoke tests

No analytics, accounts, database, external model calls, paid GPU experiments, private deployment metadata, or saved user gameplay logs are required by the public source. No license has been selected in this repository.
