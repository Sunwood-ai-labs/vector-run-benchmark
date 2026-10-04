# VECTOR RUN 3×3 比較録画

## 比較内容

正式動画は9枠で、Kai、Eos、Sol、Nox、Lux、Vega、rule、idleのnative CLI traceを8本だけ再生します。Sol-Reasoningはゲームtraceを作らず、pinnedな results/sol-reasoning/verification.json が証明する配布元HTTP 401・model_access_blocked・neural forward 0を静的カード「未測定:配布元401」として表示します。スコアやgame failureにはしません。

8 traceは同じq3 seed 101 cohortです。q3は1回のSystemOne requestあたりaction/commit/dangerの3問、dispatch機会は別に16 physics ticksごとです。7モデルの同時推論映像ではなく、Colabごとのtraceを共通の実ブラウザー時計で1×再生します。

Kaiなど6つのremote traceでは、`.game.json` と対応する `.runner.json` を読み、`runner.gameReport.sha256` が実際のgame report bytesと一致することを確認します。runnerが記録した元filenameと公開report filenameが異なる場合も、実SHAが一致する場合だけ受理し、両名をcapture manifestへ記録します。隣接するverification JSONはmodel・game/benchmark commitを確認し、nested pinsと従来のtop-level fieldsの両方を読みます。`weak_provenance_quarantined` または `aggregateEligible:false` があれば拒否し、runner/verification sidecarのSHA256もcapture manifestへ記録します。これはpublic sanitizeで原本とrunner記録のhashがずれたKai R1のようなtraceを録画cohortへ入れないためです。

## 固定された検証gate

すべてのreportはnative vector-run-decision-bench/v1 のまま読み、report間で同じ結果schemaへ変換しません。8 traceそれぞれについて、measurement commit 717f02dc9852b88c253ace32f42fcb6d780ed0d3、sourceDigest d7f9de9c3aaf0e22669dd54e916f9a854ea33b2339f83c183438f4c93be5357a、実agent、seed 101、q3、structured-visible-state-v1、120 Hz、jump-2、30秒horizon、tick 3600のright-censoring、raw request/response、raw probabilities、decision/action/inputの対応、tick 0 initialStateとtick 1..finalTick frame列を個別に検証します。

Remote late replyをmeasured no-responseとして扱う場合は、原文JSONの measurements.neural_forward_calls >= 1、整合する neural_forward_batches の実 input_ids_shape、report hardware metadataのGPU identityがすべて必要です。hardware文字列だけでは実測扱いになりません。100 msを超える入力traceまたは録画時のbrowser frame gap、tile start spreadは録画gateを落とします。

Sol-Reasoningの静的カードは、formal-results manifestに宣言されたverification fileを直接検証します。game/benchmark pin、model revision、401、0 SystemOne call、0 forward、cacheなし、q3/q64双方でgame fileがないことを確認します。カードは再生iframe、距離、score、clear/failure表示を持ちません。

## ソース先行の確認

T3 previewの録画を使うときは preview_status の後に preview_open を行います。明示的にautomation host unavailableと分かった場合だけPlaywright Chromium fallbackを使い、その理由をhandoffへ記録します。録画ブラウザーはviewport 1920×1080、device scale factor 1です。

Replay start spreadはinput change dispatch時刻ではなく、各game iframeのstate badgeが実際に`REPLAY`へ変わった時刻の最大差で計算します。録画前にcapture modeが有効、preflight gateが非表示、9枠がdisplay orderどおりに1920×1080 viewport内へ収まり、Sol-Reasoningにiframeがないことも検査します。

録画scriptは最初に全8 traceとReasoning証拠を読み、全gateを通すまでブラウザーを開きません。--capture を付けない実行は検証済みsource SHA manifestだけを作ります。physics、game app、CLI、observerには変更を加えません。

    node scripts/record-comparison.mjs --formal-results C:/Prj/decision-lane/handoffs/formal-results.json --output-dir C:/Prj/decision-lane/videos

録画は既定でheadless Chromiumを使います。headless再生が100 msのframe gap gateに届かない環境では `--capture --headed` を付け、通常のChrome/Edge描画で再試行します。どちらも実ブラウザー時計での1×再生として計測し、100 msを超えれば録画を失敗扱いにします。

source変更を先にcommitし、親のhandoffへSHAとCPU test結果を知らせます。正式録画は親のformal-results manifestに列挙された8本が個別gateを通ってから始めます。

## 録画・出力QA

正式録画はbrowser clock上で30秒の物理traceを1×再生し、terminal結果を3秒保持します。time_limitはtick 3600でright-censoredのまま表示します。全tileの結果は共通時計が終わるまで残します。出力MP4はnotebook repositoryの videos/ に置きます。

録画後はffprobeでMP4 codec・解像度・duration・frame rateを確認し、ffmpegで全フレームをdecodeします。開始・中間・終端の代表PNGを同じ videos/ 配下に抽出し、1920×1080・3×3 layout・静的Reasoning card・末尾のterminal holdを目視します。QA reportにsource manifest SHA、実browser duration、tile start spread、最大frame gap、decode結果、PNG pathsを記録します。すべて通るまでは正式MP4としてhandoffしません。

`capture-inputs.json`は録画開始前に書くimmutable snapshotです。`capture-qa.json`はその実在file名とSHA256を参照し、MP4・PNG・probe・decodeの結果を持ちます。QAのshaをinputs manifestへ書き戻さず、手動visual QA更新後にもhashの循環やstale `qaSha256`が発生しない形を保ちます。
