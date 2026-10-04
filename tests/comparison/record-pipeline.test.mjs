import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CAPTURE_MANIFEST_NAME,
  GAME_ROOT,
  assertExternalOutput,
  buildCaptureQaArtifact,
  buildCaptureManifest,
  discoverResultsDirBundle,
  isTerminalPlaybackState,
  loadFormalResultsBundle,
  parseArgs,
  playbackElapsedMs,
  validateCaptureLayout,
  validateBrowserTiming,
  validateCaptureQuality
} from '../../scripts/record-comparison.mjs';

const ids = ['kai','eos','sol','nox','lux','vega','rule','idle'];
const gameCommit = 'a'.repeat(40);
const sourceDigest = 'b'.repeat(64);
const benchmarkCommit = 'c'.repeat(40);

function fixtureContract() {
  const modelIds = new Map(ids.filter(id => !['rule','idle'].includes(id)).map(id => [id, id]));
  return {
    REQUIRED_RUNS:ids,
    DISPLAY_ORDER:['kai','eos','sol','solReasoning','nox','lux','vega','rule','idle'],
    MEASUREMENT_COMMIT:gameCommit,
    MEASUREMENT_SOURCE_DIGEST:sourceDigest,
    BENCHMARK_COMMIT:benchmarkCommit,
    comparisonId(report) {
      if (report?.agent?.kind === 'rule' || report?.agent?.kind === 'idle') return report.agent.kind;
      const model = String(report?.agent?.model ?? '').toLowerCase();
      if (model === 'sol reasoning') return 'solReasoning';
      return modelIds.get(model) ?? null;
    },
    validateReasoningUnavailableEvidence(evidence) {
      const valid = evidence?.fixture === 'unavailable-evidence';
      return {valid, errors:valid?[]:['fixture evidence mismatch']};
    },
    validateComparisonGate(reports, evidence) {
      const valid = reports.length === 8 && evidence?.fixture === 'unavailable-evidence' && reports.every(report => report.variant?.questionCount === 3);
      return {valid, questionCount:3, errors:valid?[]:['fixture native gate mismatch']};
    },
    buildComparisonReplayRecord(run) {
      const valid = run?.seed === 101 && run?.fixtureReplay === true;
      return {valid, record:valid?{seed:101}:null, errors:valid?[]:['fixture replay mismatch']};
    }
  };
}

async function tempRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vr-capture-test-'));
  t.after(async () => rm(directory, {recursive:true, force:true}));
  return directory;
}

function nativeReport(id) {
  const control = id === 'rule' || id === 'idle';
  return {
    schema:'vector-run-decision-bench/v1',
    game:{repo:'https://github.com/Sunwood-ai-labs/vector-run-benchmark', commit:gameCommit, sourceDigest},
    variant:{questionCount:3, systemOneQuestionCount:3},
    agent:{kind:control?id:'remote', model:control?id:id},
    runs:[{seed:101, fixtureReplay:true}]
  };
}

function formalManifest(reportPaths, evidencePath) {
  const targets = {};
  for (const id of ids) {
    targets[id] = {
      status:id === 'rule' || id === 'idle' ? 'control_trace_available' : 'measured_trace_available',
      q3Paths:[reportPaths[id]]
    };
  }
  targets['sol-reasoning'] = {
    status:'model_access_blocked',
    replay:false,
    evidence:evidencePath,
    label:'未測定: 配布元401'
  };
  return {gameCommit, benchmarkCommit, targets};
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive:true});
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writeRunnerSidecar(reportPath) {
  const bytes = await readFile(reportPath);
  const report = JSON.parse(bytes.toString('utf8'));
  const runnerPath = reportPath.slice(0, -'.game.json'.length) + '.runner.json';
  await writeJson(runnerPath, {model:{id:report.agent.model},gameReport:{file:path.basename(reportPath),sha256:createHash('sha256').update(bytes).digest('hex'),validJson:true}});
  return runnerPath;
}

async function writeVerificationSidecar(reportPath, id) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const model = report.agent.model;
  const verification = id === 'kai'
    ? {model:{id:model},pins:{game:{commit:gameCommit},benchmark:{commit:benchmarkCommit}}}
    : {model,gameCommit,benchmarkCommit};
  await writeJson(path.join(path.dirname(reportPath), 'verification.json'), verification);
}

async function makeFormalFixture(root) {
  const evidencePath = path.join(root, 'results', 'sol-reasoning', 'verification.json');
  await writeJson(evidencePath, {fixture:'unavailable-evidence'});
  const reportPaths = {};
  for (const id of ids) {
    reportPaths[id] = path.join(root, 'results', id, `${id}-q3.game.json`);
    await writeJson(reportPaths[id], nativeReport(id));
    if (!['rule','idle'].includes(id)) {
      await writeRunnerSidecar(reportPaths[id]);
      await writeVerificationSidecar(reportPaths[id], id);
    }
  }
  const formalResultsPath = path.join(root, 'handoffs', 'formal-results.json');
  await writeJson(formalResultsPath, formalManifest(reportPaths, evidencePath));
  return {formalResultsPath, evidencePath, reportPaths};
}

test('formal-results preflight loads one pinned native q3 report per target and hashes the exact source files', async t => {
  const root = await tempRoot(t);
  const fixture = await makeFormalFixture(root);
  const bundle = await loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract:fixtureContract()});
  assert.deepEqual(bundle.reports.map(item => item.id), ids);
  assert.equal(bundle.questionCount, 3);
  assert.equal(bundle.evidencePath, fixture.evidencePath);
  assert.equal(bundle.sources.length, 22);
  for (const item of bundle.sources) {
    const expected = createHash('sha256').update(await readFile(item.filePath)).digest('hex');
    assert.equal(item.sha256, expected, item.filePath);
  }
});

test('formal-results refuses pin drift, duplicate/missing q3 paths, and a Sol-Reasoning game path', async t => {
  const root = await tempRoot(t);
  const fixture = await makeFormalFixture(root);
  const contract = fixtureContract();
  const original = JSON.parse(await readFile(fixture.formalResultsPath, 'utf8'));
  await writeJson(fixture.formalResultsPath, {...original, gameCommit:'d'.repeat(40)});
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract}), /gameCommit/);
  const pinCorrect = {...original, targets:{...original.targets}};
  pinCorrect.targets.kai = {...pinCorrect.targets.kai, q3Paths:[fixture.reportPaths.kai, fixture.reportPaths.kai]};
  await writeJson(fixture.formalResultsPath, pinCorrect);
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract}), /exactly one q3Paths/);
  pinCorrect.targets.kai = {...pinCorrect.targets.kai, q3Paths:[fixture.reportPaths.kai]};
  delete pinCorrect.targets['sol-reasoning'].replay;
  pinCorrect.targets['sol-reasoning'].q3Paths = [fixture.reportPaths.sol];
  await writeJson(fixture.formalResultsPath, pinCorrect);
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract}), /Sol-Reasoning target/);
});

test('remote report provenance rejects runner SHA drift and explicit weak-provenance quarantine', async t => {
  const root = await tempRoot(t);
  const fixture = await makeFormalFixture(root);
  const report = JSON.parse(await readFile(fixture.reportPaths.kai, 'utf8'));
  await writeJson(fixture.reportPaths.kai, {...report, alteredAfterRunner:true});
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract:fixtureContract()}), /runner\.gameReport\.sha256 does not match native report bytes/);

  const cleanRoot = await tempRoot(t);
  const cleanFixture = await makeFormalFixture(cleanRoot);
  await writeJson(path.join(path.dirname(cleanFixture.reportPaths.kai), 'verification.json'), {
    privacyNormalizationProvenance:{status:'weak_provenance_quarantined',aggregateEligible:false}
  });
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:cleanFixture.formalResultsPath, contract:fixtureContract()}), /weak_provenance_quarantined or aggregateEligible:false/);
});

test('remote verification provenance accepts nested Kai pins and rejects commit or model drift', async t => {
  const root = await tempRoot(t);
  const fixture = await makeFormalFixture(root);
  const verificationPath = path.join(path.dirname(fixture.reportPaths.kai), 'verification.json');
  const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
  assert.equal(verification.pins.game.commit,gameCommit);
  assert.equal(verification.pins.benchmark.commit,benchmarkCommit);
  const badPin = structuredClone(verification);
  badPin.pins.game.commit = 'd'.repeat(40);
  await writeJson(verificationPath,badPin);
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath,contract:fixtureContract()}),/verification game commit/);
  badPin.pins.game.commit = gameCommit;
  badPin.model.id = 'other-model';
  await writeJson(verificationPath,badPin);
  await assert.rejects(loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath,contract:fixtureContract()}),/verification model/);
});

test('runner provenance accepts a published filename alias only when the exact report SHA matches', async t => {
  const root = await tempRoot(t);
  const fixture = await makeFormalFixture(root);
  const runnerPath = fixture.reportPaths.kai.slice(0, -'.game.json'.length) + '.runner.json';
  const runner = JSON.parse(await readFile(runnerPath, 'utf8'));
  runner.gameReport.file = 'kai-q3-published.game.json';
  await writeJson(runnerPath, runner);
  const bundle = await loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract:fixtureContract()});
  assert.equal(bundle.reports.length, 8);
  const manifest = buildCaptureManifest(bundle,{outputDir:path.join(root,'videos'),captureRequested:false});
  const provenance = manifest.sources.find(source=>source.kind==='runner_provenance'&&source.id==='kai');
  assert.deepEqual(provenance.reportNameMapping,{originalRunnerFilename:'kai-q3-published.game.json',publishedFilename:'kai-q3.game.json'});
});

test('results-dir discovery skips .private reports but rejects any Sol-Reasoning game report', async t => {
  const root = await tempRoot(t);
  const resultsDir = path.join(root, 'results');
  const evidencePath = path.join(resultsDir, 'sol-reasoning', 'verification.json');
  await writeJson(evidencePath, {fixture:'unavailable-evidence'});
  for (const id of ids) {
    const reportPath = path.join(resultsDir, id, `${id}.game.json`);
    await writeJson(reportPath, nativeReport(id));
    if (!['rule','idle'].includes(id)) {
      await writeRunnerSidecar(reportPath);
      await writeVerificationSidecar(reportPath,id);
    }
  }
  await writeJson(path.join(resultsDir, '.private', 'duplicate.json'), nativeReport('kai'));
  const bundle = await discoverResultsDirBundle({resultsDir, contract:fixtureContract()});
  assert.deepEqual(bundle.reports.map(item => item.id), ids);
  const forbidden = nativeReport('sol reasoning');
  await writeJson(path.join(resultsDir, 'sol-reasoning', 'game.json'), forbidden);
  await assert.rejects(discoverResultsDirBundle({resultsDir, contract:fixtureContract()}), /Sol-Reasoning game report is forbidden/);
});

test('capture manifest records relative paths, SHA256, and the static no-replay/no-score state', async t => {
  const root = await tempRoot(t);
  const fixture = await makeFormalFixture(root);
  const bundle = await loadFormalResultsBundle({formalResultsPath:fixture.formalResultsPath, contract:fixtureContract()});
  const manifest = buildCaptureManifest(bundle, {outputDir:path.join(root, 'videos'), captureRequested:false});
  const requestedSnapshot = buildCaptureManifest(bundle, {outputDir:path.join(root, 'videos'), captureRequested:true});
  assert.equal(manifest.manifestKind, 'vector-run-comparison-capture-inputs');
  assert.equal(manifest.cohort.schema, 'vector-run-decision-bench/v1');
  assert.equal(manifest.recording.status, 'preflight_only');
  assert.equal(manifest.recording.performed, false);
  assert.equal(requestedSnapshot.recording.status,'capture_pending');
  assert.equal(requestedSnapshot.recording.requested,true);
  assert.equal(requestedSnapshot.recording.performed,false);
  assert.equal('qaSha256' in requestedSnapshot.recording,false);
  assert.equal(manifest.staticSolReasoningTile.noReplay, true);
  assert.equal(manifest.staticSolReasoningTile.noScore, true);
  assert.equal(manifest.staticSolReasoningTile.score, null);
  assert.ok(manifest.sources.every(source => !path.isAbsolute(source.relativePath)));
  const manifestPath = path.join(root, 'videos', CAPTURE_MANIFEST_NAME);
  assert.equal(path.basename(manifestPath), CAPTURE_MANIFEST_NAME);
});

test('probe QA requires a decoded 1920x1080 33-second recording and clean realtime timing', () => {
  const fixture = {
    probe:{streams:[{codec_type:'video',codec_name:'h264',width:1920,height:1080,avg_frame_rate:'30/1',r_frame_rate:'30/1',nb_frames:'990'}],format:{duration:'33.000000'}},
    decoded:true,
    timing:{browserElapsedMs:33000,startSpreadMs:65,maxFrameGapMs:92}
  };
  assert.deepEqual(validateCaptureQuality(fixture).errors, []);
  assert.equal(validateCaptureQuality({...fixture, timing:{...fixture.timing,maxFrameGapMs:100.1}}).valid, false);
  assert.equal(validateCaptureQuality({...fixture, timing:{...fixture.timing,startSpreadMs:101}}).valid, false);
  assert.equal(validateCaptureQuality({...fixture, decoded:false}).valid, false);
  assert.equal(validateCaptureQuality({...fixture, probe:{...fixture.probe,format:{duration:'31.5'}}}).valid, false);
  assert.equal(validateCaptureQuality({...fixture, probe:{streams:[{codec_type:'video',width:1280,height:720}],format:{duration:'33'}}}).valid, false);
  assert.equal(validateCaptureQuality({...fixture, probe:{...fixture.probe,streams:[{...fixture.probe.streams[0],avg_frame_rate:'24/1'}]}}).valid, false);
});

test('capture watcher recognizes a terminal clock-gap rejection instead of timing out', () => {
  assert.equal(isTerminalPlaybackState('complete'), true);
  assert.equal(isTerminalPlaybackState('invalid_clock_gap'), true);
  assert.equal(isTerminalPlaybackState('invalid_start_spread'), true);
  assert.equal(isTerminalPlaybackState('failed'), true);
  assert.equal(isTerminalPlaybackState('playing'), false);
});

test('browser clock is gated independently before the encoded file exists', () => {
  const timing={browserElapsedMs:33000,startSpreadMs:55,maxFrameGapMs:88};
  assert.deepEqual(validateBrowserTiming(timing),{valid:true,errors:[]});
  assert.equal(validateBrowserTiming({...timing,maxFrameGapMs:100.1}).valid,false);
  assert.equal(validateBrowserTiming({...timing,browserElapsedMs:32799}).valid,false);
});

test('recording layout gate requires all nine tiles and the static unavailable card in the viewport', () => {
  const expected=['kai','eos','sol','solReasoning','nox','lux','vega','rule','idle'];
  const layout={captureMode:true,gateVisible:false,comparisonVisible:true,tileIds:expected,reasoningHasIframe:false,viewportWidth:1920,viewportHeight:1080,scrollHeight:1080,tilesWithinViewport:true};
  assert.deepEqual(validateCaptureLayout(layout,expected),{valid:true,errors:[]});
  assert.equal(validateCaptureLayout({...layout,gateVisible:true},expected).valid,false);
  assert.equal(validateCaptureLayout({...layout,tileIds:expected.slice(0,8)},expected).valid,false);
  assert.equal(validateCaptureLayout({...layout,tilesWithinViewport:false},expected).valid,false);
  assert.equal(validateCaptureLayout({...layout,reasoningHasIframe:true},expected).valid,false);
});

test('clock duration uses the completion-frame browser timestamp, without polling-delay inflation', () => {
  assert.equal(playbackElapsedMs({elapsedMs:33042},33287),33042);
  assert.equal(playbackElapsedMs({},32998),32998);
});

test('capture QA proof keeps the exact ffprobe, timing, decode, and screenshot evidence', () => {
  const probe = {streams:[{codec_type:'video',codec_name:'h264',width:1920,height:1080,avg_frame_rate:'30/1',nb_frames:'990'}],format:{duration:'33.000000'}};
  const timing = {browserElapsedMs:33000,startSpreadMs:25,maxFrameGapMs:72};
  const artifact = buildCaptureQaArtifact({
    video:{file:'comparison.mp4',sha256:'f'.repeat(64),sizeBytes:100},
    probe,
    timing,
    decoded:true,
    browser:{mode:'playwright-launch',executable:'chrome.exe',headless:false,viewport:{width:1920,height:1080}},
    frames:[{relativePath:'qa/start.png',sha256:'a'.repeat(64)}],
    layout:{captureMode:true,tilesWithinViewport:true},
    sourceManifestSha256:'1'.repeat(64)
  });
  assert.equal(artifact.status, 'automated_checks_passed_visual_review_pending');
  assert.deepEqual(artifact.video.probe, probe);
  assert.deepEqual(artifact.timing, timing);
  assert.equal(artifact.fullDecode.passed, true);
  assert.equal(artifact.sourceManifestFile,'capture-inputs.json');
  assert.equal(artifact.sourceManifestSha256,'1'.repeat(64));
  assert.equal(artifact.visualQA.status,'pending');
  assert.deepEqual(artifact.qaFrames[0], {relativePath:'qa/start.png',sha256:'a'.repeat(64)});
});

test('CLI requires one source and an external output directory', () => {
  assert.deepEqual(parseArgs(['--formal-results','formal.json','--output-dir','C:\\Prj\\decision-lane\\videos']), {
    formalResults:'formal.json', resultsDir:null, evidence:null, output:'C:\\Prj\\decision-lane\\videos', capture:false, browserPath:null, headed:false, help:false
  });
  assert.equal(parseArgs(['--formal-results','formal.json','--output-dir','videos','--capture','--headed']).headed,true);
  assert.throws(() => parseArgs(['--output','videos']), /exactly one/);
  assert.throws(() => parseArgs(['--formal-results','formal.json','--results-dir','results','--output','videos']), /exactly one/);
  assert.throws(() => assertExternalOutput(path.join(GAME_ROOT, 'videos')), /outside/);
  assert.doesNotThrow(() => assertExternalOutput(path.join(os.tmpdir(), 'vector-run-videos')));
});
