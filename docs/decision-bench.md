# Decision 2.0 realtime bench

`structured-visible-state-v1` は、画面上で見える現在状態だけを使うpixelベンチとは別条件です。SystemOneにはJSONの可視状態を送り、未来の障害物、seed、RNG、コース生成情報は含めません。

## 実行

```sh
node scripts/decision-bench.mjs --agent remote --seeds 101,202,303,404,505 --questions 64 --max-seconds 30 --max-jumps 2 --model MODEL --url http://127.0.0.1:8780/v1/systemone --metadata metadata.json --output artifacts/decision-bench/q64/results.json --trace
node scripts/decision-bench.mjs --agent rule --seeds 101,202,303,404,505 --questions 64 --max-seconds 30 --max-jumps 2 --metadata metadata.json --output artifacts/decision-bench/q64/rule.json --trace
node scripts/decision-bench.mjs --agent idle --seeds 101,202,303,404,505 --questions 64 --max-seconds 30 --max-jumps 2 --metadata metadata.json --output artifacts/decision-bench/q64/idle.json --trace
node scripts/verify-decision-trace.mjs artifacts/decision-bench/q64/results.json artifacts/decision-bench/q64/rule.json artifacts/decision-bench/q64/idle.json
```

`--questions` は**1リクエスト内の問数**です。q3は`action`/`commit`/`danger`、q64はその3問に`p0`〜`p60`を加えます。probeはq64だけに含み、明示的な合成booleanです。どちらも16 tickごと（約133.3 ms）にdispatchを続け、未完了リクエストは1件に保ちます。推論中も120 Hzで進みます。30秒を超える上限は指定できず、30秒はtick 3600で終了します。100 msを超える時計gapはinvalidになります。

SystemOne応答は`answers`内の対象問と値を検証します。top-levelの`model`/`usage`/`measurements`やanswer内の`type`/`probabilities`等の追加metadataを許容し、完全なrequest/response本文を`rawRequestBody`/`rawResponse`へ保存します。生成textやrationaleは受け付けません。`--metadata`の`model`、`hardware`、`gameCommit`もreportへ保持します。

## 出力と検証

report schemaは`vector-run-decision-bench/v1`です。主なtop-level fieldsは`game`、`variant`、`agent`、`model`、`hardware`、`gameCommit`、`metadata`、`episodes`、`runs`です。各runは`initialState`をtick 0で持ち、`frameSnapshots`はtick 1から`finalTick`まで連続します。`inputLogs`のeventは`tick=N`、`applicationTick=N+1`です。既存replayと同じく、入力はtick Nの状態に適用してN+1へstepします。`actions`には`wait`も記録しますが、waitはheldを維持するno-opで`inputLogs`には入りません。

`decisions`は16 tickごとの各機会を記録し、`skips`は`request_outstanding`または`idle_baseline`を記録します。遅れて届いた正常回答は`late_answer_not_applied`としてraw本文とprobabilitiesを残し、`applicationTick`はnullです。欠落・不正回答は`invalid_response`、null actionとして記録し、releaseへ置き換えません。

衝突runは既存`replayRecord`で照合します。`time_limit`はcensoredとして専用validatorでsnapshotと`finalSnapshotHash`を再計算し、collision/clearやsummarize対象にはしません。9本を検証するときは同じq3またはq64のreportだけを一度に渡してください。
