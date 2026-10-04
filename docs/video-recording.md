# VECTOR RUN 3×3 比較動画

## 比較条件

動画はこのリポジトリの `dist/index.html` が使うゲーム画面とCanvas描画を9枚並べ、Colabで個別実行したtraceを1×で再生します。9本のモデル推論を同時実行した映像ではありません。最初のcohortはseed 101、120 Hz、30秒、`jump-2/v1`、`structured-visible-state-v1` です。pixel observationとは別条件として表示します。

9枠はKai、Eos、Sol、SolReasoning、Nox、Lux、Vega、rule、idleです。9本とも同じq3またはq64 cohortに揃えます。GPU aliasなどの表示は各CLI reportの `hardware` metadataにある値だけを使います。

各reportの `game.commit` は frozen measurementCommit `717f02dc9852b88c253ace32f42fcb6d780ed0d3`、`game.sourceDigest` は `d7f9de9c3aaf0e22669dd54e916f9a854ea33b2339f83c183438f4c93be5357a` と個別照合します。9本同士の一致だけでは通しません。GPU aliasはreport metadataの表示値です。

## CLI reportとDecision 2.0

動画gateは `vector-run-decision-bench/v1` のCLI reportを直接読みます。動画専用manifestや別のdecision rowへ変換しません。各reportの `agent.kind/model` で枠を判別し、`runs` からseed 101を選びます。

`--questions 3|64` は1回のSystemOne requestに入れる質問数です。dispatch回数の制限ではありません。

- q3は `action`（choice）、`commit`（noul）、`danger`（score）の3問で、request stateに `probes` を含めません。
- q64はその3問に `p0`〜`p60` の61問を加え、request stateに61個の合成booleanを含めます。各probeは値がtrueかを尋ね、trueなら1、falseなら0で回答する日本語instructionです。
- 両cohortとも16 physics ticksごとに機会を記録し、remote requestは最大1件ずつ処理します。推論中も120 Hzの物理時計は進みます。

traceにはCLIの `decisions` と `skips` をそのまま残します。remoteの `rawRequest:null/status:'skipped_outstanding'` 行は `skips` の `request_outstanding` と照合します。`rule` はraw requestを持たないlocal `answered` decision、`idle` はraw requestを持たない `idle_no_action` decisionと `idle_baseline` skipです。これらは9枠の一部で、model requestとして扱いません。

実remote dispatchでは `rawRequest`, `rawRequestBody`, `rawResponse` を保持します。CLIの `rawResponse` はHTTP body原文のJSON文字列です。gateは検証時だけparseし、元文字列を変更しません。responseのtop-level `model` / `usage` / `measurements` とanswer内の `type` / `probabilities` metadataは許容し、各質問の必須answer fieldと数値を検証します。生成text/rationale、欠落・不正answerは受け付けません。raw action probabilitiesもtrace内の値と照合します。

q64のbooleanは明示的にrequest stateへ合成され、未来のcourse情報から作られません。action instructionは日本語で800×360 viewport、groundY 278、player固定box x=116 / width=34 / height=42、y/vyの上向き正、障害物xの画面左端基準、held状態とrelease後の再pressを説明します。

## tick、再生、終了条件

CLI reportでは `initialState` がtick 0、`frameSnapshots` はtick 1から `finalTick` までです。gateは両者をつないだ全状態列をcanonical engineで照合します。

各physical input logの `tick=N` はengineが入力eventを受けたtickで、`applicationTick=N+1` のstep直前に入力されます。offline replay recordでもlegacy `inputs[].tick=N` を保ち、NからN+1へのstep前に適用します。jumpとreleaseの受理結果、全visible state、`finalSnapshotHash` を再計算して照合します。

30秒のhorizonはphysical tick 3600まで進みます。100 msを超えるclock gap、`runtimeGameInvalidErrors`、`responseErrors`、trace mismatchがあるrunは除外します。`time_limit` はtick 3600でright-censoredとして示し、clearとは扱いません。各runのterminal画面を保持したまま共通時計を進め、最長33秒（30秒 + 最終結果3秒）表示します。

terminal後に届いた有効responseは `lateReply:true`, `status:'late_answer_not_applied'`, `completionTick:null`, `applicationTick:null` と原文JSONで保持します。measured no-in-time-responseとして表示するには、raw response内のproduction backend hook記録 `measurements.neural_forward_calls`（1以上の整数）と `measurements.neural_forward_batches`（呼び出し数と一致し、各 `input_ids_shape` とbatch/token寸法が整合する配列）、および `report.hardware.gpu` 等の実GPU identity metadataが必要です。CPU fixtureの `forward_performed/device` とhardware metadata単独はforward根拠になりません。これらのhook記録とGPU identityの両方がないrunはunmeasuredとして正式再生gateを通しません。

## 素材の配置と録画

各model/controlの結果はnotebook repositoryの `results/` に置きます。gateに渡すのはq3またはq64で揃えた9個のnative CLI reportです。出力MP4とQA reportはnotebook repositoryの `videos/` に保存し、game repositoryへは入りません。

正式録画はCLI measurement contractがfreezeされ、9つの実traceが揃ってから行います。素材不足、q cohort混在、raw wire/state/input/fingerprint不一致、clock invalid、未測定late resultがある場合は録画を始めません。rule/idle fallbackやdummy traceは使いません。

## 素材待ち画面とQA

T3 preview hostを使えない場合は `npm run serve` 後に `http://127.0.0.1:4173/comparison/index.html` を開きます。q3/q64 request size、16-tick cadence、tick対応、正式trace待ちを表示します。

正式録画ではMP4をffprobeで検査し、全フレームをdecodeします。開始付近・中間・終端付近の代表3フレームを目視し、duration・実時間・jitter・source SHAをQA reportへ記録します。動画はColab traceの1× replayであることを画面内に明記します。
