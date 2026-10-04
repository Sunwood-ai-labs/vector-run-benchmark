import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GAME_ROOT = path.resolve(SCRIPT_DIR, '..');
export const NATIVE_REPORT_SCHEMA = 'vector-run-decision-bench/v1';
export const DEFAULT_OUTPUT_NAME = 'vector-run-comparison.mp4';
export const CAPTURE_MANIFEST_NAME = 'capture-inputs.json';
export const VIDEO_SIZE = Object.freeze({width:1920, height:1080});
export const VIDEO_DURATION_SECONDS = 33;
export const VIDEO_FPS = 30;
const TERMINAL_PLAYBACK_STATES = Object.freeze(['complete','failed','invalid_clock_gap','invalid_start_spread']);

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const posixRelative = (from, to) => path.relative(from, to).split(path.sep).join('/');

export function parseArgs(argv) {
  const options = {formalResults:null, resultsDir:null, evidence:null, output:null, capture:false, browserPath:null, headed:false, help:false};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (token === '--capture') { options.capture = true; continue; }
    if (token === '--headed') { options.headed = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--formal-results') options.formalResults = value;
    else if (token === '--results-dir') options.resultsDir = value;
    else if (token === '--evidence') options.evidence = value;
    else if (token === '--output-dir' || token === '--output') options.output = value;
    else if (token === '--browser-path') options.browserPath = value;
    else throw new Error(`Unknown option: ${token}`);
  }
  if (!options.help) {
    if (Boolean(options.formalResults) === Boolean(options.resultsDir)) throw new Error('Provide exactly one of --formal-results or --results-dir');
    if (!options.output) throw new Error('--output VIDEO_DIRECTORY is required');
  }
  return options;
}

function contractPins(contract) {
  const sourceDigest = contract.SOURCE_DIGEST ?? contract.MEASUREMENT_SOURCE_DIGEST;
  if (!Array.isArray(contract.REQUIRED_RUNS) || contract.REQUIRED_RUNS.length !== 8) throw new Error('player contract must export the eight REQUIRED_RUNS IDs');
  if (!Array.isArray(contract.DISPLAY_ORDER) || !contract.DISPLAY_ORDER.includes('solReasoning')) throw new Error('player contract must export DISPLAY_ORDER including the static Sol-Reasoning tile');
  if (!/^[0-9a-f]{40}$/i.test(contract.MEASUREMENT_COMMIT ?? '')) throw new Error('player contract MEASUREMENT_COMMIT is missing');
  if (!/^[0-9a-f]{64}$/i.test(sourceDigest ?? '')) throw new Error('player contract source digest is missing');
  if (!/^[0-9a-f]{40}$/i.test(contract.BENCHMARK_COMMIT ?? '')) throw new Error('player contract BENCHMARK_COMMIT is missing');
  for (const method of ['comparisonId', 'validateReasoningUnavailableEvidence', 'validateComparisonGate', 'buildComparisonReplayRecord']) {
    if (typeof contract[method] !== 'function') throw new Error(`player contract must export ${method}`);
  }
  return {gameCommit:contract.MEASUREMENT_COMMIT, sourceDigest, benchmarkCommit:contract.BENCHMARK_COMMIT};
}

async function readJson(filePath, label) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (error) { throw new Error(`${label} cannot be read: ${filePath} (${error.message})`); }
  try { return {value:JSON.parse(text), bytes:Buffer.from(text, 'utf8')}; }
  catch (error) { throw new Error(`${label} is not valid JSON: ${filePath} (${error.message})`); }
}

async function hashPath(filePath) {
  return digestBytes(await readFile(filePath));
}

function containsWeakProvenance(value) {
  if (Array.isArray(value)) return value.some(containsWeakProvenance);
  if (!isObject(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'status' && item === 'weak_provenance_quarantined') return true;
    if (key === 'aggregateEligible' && item === false) return true;
    if (containsWeakProvenance(item)) return true;
  }
  return false;
}

async function validateRunnerProvenance(reportPath, id) {
  if (id === 'rule' || id === 'idle') return [];
  if (!reportPath.toLowerCase().endsWith('.game.json')) throw new Error(`${id}: native report must use the .game.json filename required by the runner provenance sidecar`);
  const runnerPath = reportPath.slice(0, -'.game.json'.length) + '.runner.json';
  const {value:runner} = await readJson(runnerPath, `${id} runner provenance`);
  if (!isObject(runner) || !isObject(runner.gameReport)) throw new Error(`${id}: runner sidecar has no gameReport provenance`);
  if (typeof runner.gameReport.file !== 'string' || !path.basename(runner.gameReport.file).toLowerCase().endsWith('.game.json')) throw new Error(`${id}: runner gameReport.file does not identify a native game report`);
  if (runner.gameReport.validJson !== true) throw new Error(`${id}: runner sidecar does not confirm a valid JSON game report`);
  const recordedSha = runner.gameReport.sha256;
  if (typeof recordedSha !== 'string' || !/^[0-9a-f]{64}$/i.test(recordedSha)) throw new Error(`${id}: runner sidecar has no valid gameReport.sha256`);
  const actualSha = await hashPath(reportPath);
  if (recordedSha.toLowerCase() !== actualSha) throw new Error(`${id}: runner.gameReport.sha256 does not match native report bytes; weak provenance is quarantined`);

  const sources = [{kind:'runner_provenance', id, filePath:runnerPath, sha256:await hashPath(runnerPath)}];
  const parent = path.dirname(reportPath);
  const verificationFiles = (await readdir(parent, {withFileTypes:true}))
    .filter(entry => entry.isFile() && /(?:^|[-.])verification.*\.json$/i.test(entry.name))
    .map(entry => path.join(parent, entry.name));
  for (const verificationPath of verificationFiles) {
    const {value:verification} = await readJson(verificationPath, `${id} runner verification`);
    if (containsWeakProvenance(verification)) throw new Error(`${id}: ${verificationPath} declares weak_provenance_quarantined or aggregateEligible:false`);
    sources.push({kind:'runner_verification', id, filePath:verificationPath, sha256:await hashPath(verificationPath)});
  }
  return sources;
}

function requireFormalPins(formal, contract, formalPath) {
  const pins = contractPins(contract);
  if (!isObject(formal)) throw new Error('formal-results manifest must be a JSON object');
  if (formal.gameCommit !== pins.gameCommit) throw new Error('formal-results gameCommit does not match the player measurement commit');
  if (formal.benchmarkCommit !== pins.benchmarkCommit) throw new Error('formal-results benchmarkCommit does not match the player benchmark pin');
  if (!isObject(formal.targets)) throw new Error('formal-results targets must be an object');
  const expected = [...contract.REQUIRED_RUNS, 'sol-reasoning'].sort();
  if (JSON.stringify(Object.keys(formal.targets).sort()) !== JSON.stringify(expected)) throw new Error('formal-results must declare exactly the eight measured IDs and sol-reasoning');
  const sources = [];
  const reports = [];
  for (const id of contract.REQUIRED_RUNS) {
    const target = formal.targets[id];
    const expectedStatus = id === 'rule' || id === 'idle' ? 'control_trace_available' : 'measured_trace_available';
    if (!isObject(target) || target.status !== expectedStatus) throw new Error(`formal-results target ${id} must have status ${expectedStatus}`);
    if (!Array.isArray(target.q3Paths) || target.q3Paths.length !== 1 || typeof target.q3Paths[0] !== 'string') throw new Error(`formal-results target ${id} must contain exactly one q3Paths entry`);
    if (target.replay === false) throw new Error(`formal-results target ${id} cannot disable replay`);
    const filePath = path.resolve(path.dirname(formalPath), target.q3Paths[0]);
    if (!path.isAbsolute(target.q3Paths[0])) throw new Error(`formal-results target ${id} q3 path must be absolute`);
    reports.push({id, filePath});
  }
  const reasoning = formal.targets['sol-reasoning'];
  if (!isObject(reasoning) || reasoning.status !== 'model_access_blocked' || reasoning.replay !== false || typeof reasoning.evidence !== 'string' || !reasoning.evidence.trim() || reasoning.q3Paths !== undefined) {
    throw new Error('formal-results Sol-Reasoning target must be model_access_blocked with replay:false, evidence, and no game q3Paths');
  }
  if (typeof reasoning.label !== 'string' || !reasoning.label.trim()) throw new Error('formal-results Sol-Reasoning target needs its explicit unavailable label');
  return {pins, reports, reasoning, sources};
}

function validateNativeReport(report, expectedId, contract, pins, expectedQuestionCount = 3) {
  if (!isObject(report) || report.schema !== NATIVE_REPORT_SCHEMA) throw new Error(`${expectedId}: native ${NATIVE_REPORT_SCHEMA} report required`);
  const id = contract.comparisonId(report);
  if (id === 'solReasoning') throw new Error('Sol-Reasoning has unavailable evidence only; a game report is forbidden');
  if (id !== expectedId) throw new Error(`${expectedId}: report agent maps to ${String(id)}`);
  if (report.game?.commit !== pins.gameCommit || report.game?.sourceDigest !== pins.sourceDigest) throw new Error(`${expectedId}: report game commit/sourceDigest do not match the frozen measurement pin`);
  if (report.game?.repo !== 'https://github.com/Sunwood-ai-labs/vector-run-benchmark') throw new Error(`${expectedId}: report game repository is not canonical`);
  if (report.variant?.questionCount !== expectedQuestionCount || report.variant?.systemOneQuestionCount !== expectedQuestionCount) throw new Error(`${expectedId}: report questionCount must be q${expectedQuestionCount}`);
  if (!Array.isArray(report.runs) || !report.runs.some(run => run?.seed === 101)) throw new Error(`${expectedId}: seed 101 native run is missing`);
}

async function validateBundle(reports, evidence, contract, pins) {
  if (reports.length !== contract.REQUIRED_RUNS.length) throw new Error(`exactly ${contract.REQUIRED_RUNS.length} native game reports are required`);
  const byId = new Map();
  for (const item of reports) {
    validateNativeReport(item.report, item.id, contract, pins, item.questionCount ?? 3);
    if (byId.has(item.id)) throw new Error(`duplicate native report for ${item.id}`);
    byId.set(item.id, item);
  }
  const missing = contract.REQUIRED_RUNS.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`missing native reports: ${missing.join(', ')}`);
  const ordered = contract.REQUIRED_RUNS.map(id => byId.get(id));
  const reasoningCheck = contract.validateReasoningUnavailableEvidence(evidence);
  if (!reasoningCheck?.valid) throw new Error(`Sol-Reasoning unavailable evidence failed: ${(reasoningCheck?.errors ?? ['validator returned invalid']).join(' | ')}`);
  const gateCheck = contract.validateComparisonGate(ordered.map(item => item.report), evidence);
  if (!gateCheck?.valid) throw new Error(`native comparison gate failed: ${(gateCheck?.errors ?? ['validator returned invalid']).join(' | ')}`);
  for (const item of ordered) {
    const run = item.report.runs.find(candidate => candidate?.seed === 101);
    const replay = contract.buildComparisonReplayRecord(run);
    if (!replay?.valid || !replay.record) throw new Error(`${item.id}: canonical engine replay preflight failed: ${(replay?.errors ?? ['validator returned invalid']).join(' | ')}`);
    item.replayRecord = replay.record;
  }
  return {reports:ordered, questionCount:gateCheck.questionCount ?? 3, gateCheck, reasoningCheck};
}

export async function loadFormalResultsBundle({formalResultsPath, evidenceOverride = null, contract}) {
  const absoluteFormalPath = path.resolve(formalResultsPath);
  const {value:formal} = await readJson(absoluteFormalPath, 'formal-results manifest');
  const {pins, reports:reportPaths, reasoning} = requireFormalPins(formal, contract, absoluteFormalPath);
  const evidencePath = path.resolve(evidenceOverride ?? path.resolve(path.dirname(absoluteFormalPath), reasoning.evidence));
  const loadedReports = [];
  const sources = [];
  for (const source of reportPaths) {
    const {value:report} = await readJson(source.filePath, `${source.id} native report`);
    validateNativeReport(report, source.id, contract, pins, 3);
    sources.push(...await validateRunnerProvenance(source.filePath, source.id));
    loadedReports.push({id:source.id, report, filePath:source.filePath, questionCount:3});
    sources.push({kind:'native_report', id:source.id, filePath:source.filePath, sha256:await hashPath(source.filePath)});
  }
  const {value:evidence} = await readJson(evidencePath, 'Sol-Reasoning verification evidence');
  sources.push({kind:'reasoning_unavailable_evidence', id:'solReasoning', filePath:evidencePath, sha256:await hashPath(evidencePath)});
  sources.push({kind:'formal_results', id:'formal-results', filePath:absoluteFormalPath, sha256:await hashPath(absoluteFormalPath)});
  const validated = await validateBundle(loadedReports, evidence, contract, pins);
  return {...validated, evidence, evidencePath, formalResultsPath:absoluteFormalPath, sources, pins, formal};
}

async function walkJsonFiles(root, directory = root, output = []) {
  const entries = await (await import('node:fs/promises')).readdir(directory, {withFileTypes:true});
  for (const entry of entries) {
    if (entry.name.toLowerCase() === '.private') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonFiles(root, target, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) output.push(target);
  }
  return output;
}

export async function discoverResultsDirBundle({resultsDir, evidencePath = null, contract}) {
  const root = await realpath(path.resolve(resultsDir));
  const pins = contractPins(contract);
  const resolvedEvidence = path.resolve(evidencePath ?? path.join(root, 'sol-reasoning', 'verification.json'));
  const candidates = await walkJsonFiles(root);
  const reports = [];
  for (const filePath of candidates) {
    if (path.resolve(filePath).toLowerCase() === resolvedEvidence.toLowerCase()) continue;
    const {value} = await readJson(filePath, 'results-dir JSON');
    if (value?.schema !== NATIVE_REPORT_SCHEMA) continue;
    const id = contract.comparisonId(value);
    if (id === 'solReasoning') throw new Error(`Sol-Reasoning game report is forbidden: ${filePath}`);
    if (!contract.REQUIRED_RUNS.includes(id)) throw new Error(`unrecognized native game report ${String(id)}: ${filePath}`);
    const questionCount = value.variant?.questionCount;
    if (![3, 64].includes(questionCount)) throw new Error(`${id}: native report questionCount must be 3 or 64`);
    validateNativeReport(value, id, contract, pins, questionCount);
    reports.push({id, report:value, filePath, questionCount, provenanceSources:await validateRunnerProvenance(filePath, id)});
  }
  if (!reports.length) throw new Error(`no native ${NATIVE_REPORT_SCHEMA} reports found under ${root}`);
  const questionCounts = new Set(reports.map(item => item.questionCount));
  if (questionCounts.size !== 1) throw new Error('results-dir reports mix q3 and q64 cohorts');
  if (reports.length !== contract.REQUIRED_RUNS.length) throw new Error(`expected exactly ${contract.REQUIRED_RUNS.length} native reports, found ${reports.length}`);
  const {value:evidence} = await readJson(resolvedEvidence, 'Sol-Reasoning verification evidence');
  const validated = await validateBundle(reports, evidence, contract, pins);
  const sources = [];
  for (const item of validated.reports) {
    sources.push({kind:'native_report', id:item.id, filePath:item.filePath, sha256:await hashPath(item.filePath)});
    sources.push(...(item.provenanceSources ?? []));
  }
  sources.push({kind:'reasoning_unavailable_evidence', id:'solReasoning', filePath:resolvedEvidence, sha256:await hashPath(resolvedEvidence)});
  return {...validated, evidence, evidencePath:resolvedEvidence, resultsDir:root, sources, pins, formal:null};
}

function relativeSourcePath(bundle, filePath) {
  const base = bundle.formalResultsPath ? path.dirname(bundle.formalResultsPath) : bundle.resultsDir;
  return posixRelative(base, filePath);
}

export function buildCaptureManifest(bundle, {outputDir, captureRequested}) {
  return {
    manifestKind:'vector-run-comparison-capture-inputs',
    manifestVersion:1,
    createdAt:new Date().toISOString(),
    pins:{gameCommit:bundle.pins.gameCommit, sourceDigest:bundle.pins.sourceDigest, benchmarkCommit:bundle.pins.benchmarkCommit},
    cohort:{schema:NATIVE_REPORT_SCHEMA, questionCount:bundle.questionCount, runIds:bundle.reports.map(item => item.id)},
    sources:bundle.sources.map(source => ({kind:source.kind, id:source.id, relativePath:relativeSourcePath(bundle, source.filePath), sha256:source.sha256})),
    staticSolReasoningTile:{id:'solReasoning', label:bundle.formal?.targets?.['sol-reasoning']?.label ?? '未測定: unavailable evidence', status:'not_measured', noReplay:true, noScore:true, score:null},
    recording:{requested:Boolean(captureRequested), status:captureRequested?'capture_pending':'preflight_only', performed:false, mode:'native trace replay at 1x browser time', durationSeconds:VIDEO_DURATION_SECONDS, terminalHoldSeconds:3, outputFile:null},
    outputDirectory:path.resolve(outputDir)
  };
}

export function validateCaptureQuality({probe, decoded, timing, layout = null, expectedTileIds = null}) {
  const errors = [];
  const stream = probe?.streams?.find(item => item?.codec_type === 'video') ?? probe?.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const duration = Number(probe?.format?.duration ?? stream?.duration);
  const frameRate = parseFrameRate(stream?.avg_frame_rate ?? stream?.r_frame_rate);
  const frameCount = Number(stream?.nb_frames);
  if (width !== VIDEO_SIZE.width || height !== VIDEO_SIZE.height) errors.push(`video resolution must be ${VIDEO_SIZE.width}x${VIDEO_SIZE.height}`);
  if (!Number.isFinite(duration) || Math.abs(duration - VIDEO_DURATION_SECONDS) > 0.05) errors.push(`video duration must be ${VIDEO_DURATION_SECONDS} seconds`);
  if (!Number.isFinite(frameRate) || Math.abs(frameRate - VIDEO_FPS) > 0.01) errors.push(`video frame rate must be ${VIDEO_FPS} fps`);
  if (!Number.isFinite(frameCount) || frameCount !== VIDEO_DURATION_SECONDS * VIDEO_FPS) errors.push(`video must contain ${VIDEO_DURATION_SECONDS * VIDEO_FPS} frames`);
  if (stream?.codec_name !== 'h264') errors.push('video codec must be H.264');
  if (decoded !== true) errors.push('full ffmpeg decode did not pass');
  errors.push(...validateBrowserTiming(timing).errors);
  if (layout) errors.push(...validateCaptureLayout(layout, expectedTileIds).errors);
  return {valid:errors.length===0, errors, width, height, duration, frameRate, frameCount, codec:stream?.codec_name ?? null};
}

export function validateCaptureLayout(layout, expectedTileIds) {
  const errors = [];
  if (layout?.captureMode !== true) errors.push('capture-mode CSS was not enabled');
  if (layout?.gateVisible !== false) errors.push('preflight gate is visible in the recording');
  if (layout?.comparisonVisible !== true) errors.push('comparison grid is not visible');
  if (!Array.isArray(layout?.tileIds) || JSON.stringify(layout.tileIds) !== JSON.stringify(expectedTileIds)) errors.push('recording must contain all nine tiles in display order');
  if (layout?.reasoningHasIframe !== false) errors.push('Sol-Reasoning tile must remain static with no game iframe');
  if (layout?.scrollHeight > layout?.viewportHeight || layout?.tilesWithinViewport !== true) errors.push('all nine tiles must fit inside the 1920x1080 recording viewport without scrolling');
  if (layout?.viewportWidth !== VIDEO_SIZE.width || layout?.viewportHeight !== VIDEO_SIZE.height) errors.push('recording layout viewport must be 1920x1080');
  return {valid:errors.length===0, errors};
}

export function validateBrowserTiming(timing) {
  const errors = [];
  if (!Number.isFinite(timing?.startSpreadMs) || timing.startSpreadMs > 100) errors.push('tile start spread must be at most 100 ms');
  if (!Number.isFinite(timing?.maxFrameGapMs) || timing.maxFrameGapMs > 100) errors.push('browser frame gaps must be at most 100 ms');
  if (!Number.isFinite(timing?.browserElapsedMs) || timing.browserElapsedMs < 32800 || timing.browserElapsedMs > 33200) errors.push('browser replay clock must run for 30 seconds plus a 3 second terminal hold at 1x');
  return {valid:errors.length===0, errors};
}

export function isTerminalPlaybackState(status) {
  return TERMINAL_PLAYBACK_STATES.includes(status);
}

export function playbackElapsedMs(result, pageObservedElapsedMs) {
  return Number.isFinite(result?.elapsedMs) ? result.elapsedMs : pageObservedElapsedMs;
}

function parseFrameRate(value) {
  if (typeof value !== 'string') return Number(value);
  const [numerator, denominator] = value.split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) return numerator / denominator;
  return Number(value);
}

export function buildCaptureQaArtifact({video, probe, timing, decoded, browser, frames, layout = null, sourceManifestSha256 = null}) {
  return {
    artifactKind:'vector-run-video-capture-qa',
    artifactVersion:1,
    status:'automated_checks_passed_visual_review_pending',
    video:{...video, probe},
    browser,
    timing,
    captureLayout:layout,
    sourceManifestSha256,
    fullDecode:{passed:decoded, tool:'ffmpeg', mode:'full video decode to null output'},
    qaFrames:frames,
    visualQA:{status:'pending',requiredFrames:frames.map(frame=>frame.relativePath)}
  };
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function assertExternalOutput(outputDir, gameRoot = GAME_ROOT) {
  const absolute = path.resolve(outputDir);
  if (inside(path.resolve(gameRoot), absolute)) throw new Error('video output must be outside the VECTOR RUN game repository');
  return absolute;
}

export function browserCandidates(environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
  const paths = [];
  const roots = [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    paths.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    paths.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return [...new Set(paths)];
}

async function findBrowser(explicitPath = null) {
  if (explicitPath) {
    const absolute = path.resolve(explicitPath);
    if (!(await stat(absolute).catch(() => null))?.isFile()) throw new Error(`browser executable does not exist: ${absolute}`);
    return absolute;
  }
  for (const candidate of browserCandidates()) if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  throw new Error('installed Chrome or Edge was not found; use --browser-path');
}

async function loadPlaywright() {
  try { return await import('playwright-core'); }
  catch (error) { throw new Error(`Playwright-core is required for --capture: ${error.message}`); }
}

async function launchBrowser(chromium, executablePath, tempRoot, {headless = true} = {}) {
  const commonArgs = ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  try {
    const browser = await chromium.launch({headless, executablePath, args:commonArgs});
    return {browser, mode:'playwright-launch', cleanup:async()=>browser.close()};
  } catch (launchError) {
    const profile = path.join(tempRoot, 'cdp-profile');
    await mkdir(profile, {recursive:true});
    const child = spawn(executablePath, [...commonArgs, ...(headless?['--headless=new']:[]), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {stdio:'ignore', windowsHide:true});
    const activePort = path.join(profile, 'DevToolsActivePort');
    let endpoint = null;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) break;
      const contents = await readFile(activePort, 'utf8').catch(() => '');
      const port = Number(contents.split(/\r?\n/)[0]);
      if (port > 0 && port < 65536) { endpoint = `http://127.0.0.1:${port}`; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!endpoint) {
      child.kill();
      throw new Error(`Chrome/Edge launch and CDP fallback failed: ${launchError.message}`);
    }
    try {
      const browser = await chromium.connectOverCDP(endpoint, {timeout:10000});
      return {browser, mode:'playwright-cdp-fallback', cleanup:async()=>{try{await browser.close();}finally{child.kill();}}};
    } catch (cdpError) {
      child.kill();
      throw new Error(`Chrome/Edge CDP fallback failed: ${cdpError.message}`);
    }
  }
}

async function createCaptureServer(root, inputs) {
  const allowlist = new Map(inputs.map(input => [input.route, input.filePath]));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/__inputs/')) {
        const filePath = allowlist.get(url.pathname);
        if (!filePath) { response.writeHead(404).end(); return; }
        response.writeHead(200, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'access-control-allow-origin':'*'});
        response.end(await readFile(filePath));
        return;
      }
      const relative = decodeURIComponent(url.pathname === '/' ? '/dist/comparison/index.html' : url.pathname).replace(/^[/\\]+/, '');
      const absolute = path.resolve(root, relative);
      if (!inside(root, absolute)) { response.writeHead(403).end(); return; }
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, {'content-type':MIME.get(path.extname(absolute).toLowerCase()) ?? 'application/octet-stream', 'cache-control':'no-store'});
      if (request.method === 'HEAD') response.end(); else response.end(await readFile(absolute));
    } catch (error) {
      response.writeHead(500, {'content-type':'text/plain; charset=utf-8'}).end(error.message);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return {server, url:`http://127.0.0.1:${address.port}`};
}

function runProcess(command, args, {cwd} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, windowsHide:true, stdio:['ignore', 'pipe', 'pipe']});
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const result = {code, stdout:Buffer.concat(stdout).toString('utf8'), stderr:Buffer.concat(stderr).toString('utf8')};
      if (code !== 0) reject(new Error(`${path.basename(command)} exited ${code}: ${result.stderr.slice(-2000)}`));
      else resolve(result);
    });
  });
}

function maxOf(values) {
  return Array.isArray(values) && values.length ? Math.max(...values.filter(Number.isFinite)) : NaN;
}

async function extractQaFrames(ffmpeg, videoPath, outputDir) {
  const qaDir = path.join(outputDir, 'qa');
  await mkdir(qaDir, {recursive:true});
  const frames = [
    {label:'start', at:0.5},
    {label:'mid', at:16.5},
    {label:'end', at:32.5}
  ];
  for (const frame of frames) {
    await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(frame.at), '-i', videoPath, '-frames:v', '1', '-update', '1', path.join(qaDir, `${frame.label}.png`)]);
  }
  return frames.map(frame => path.join('qa', `${frame.label}.png`));
}

export async function captureComparison(bundle, {outputDir, contract, browserPath = null, headed = false, sourceManifestSha256 = null, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'} = {}) {
  const absoluteOutput = assertExternalOutput(outputDir);
  const playwright = await loadPlaywright();
  const executable = await findBrowser(browserPath);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vector-run-capture-'));
  const webmDir = path.join(tempRoot, 'webm');
  await mkdir(webmDir, {recursive:true});
  const inputs = bundle.reports.map(item => ({route:`/__inputs/report-${item.id}.json`, filePath:item.filePath}));
  inputs.push({route:'/__inputs/reasoning-evidence.json', filePath:bundle.evidencePath});
  const serverHandle = await createCaptureServer(GAME_ROOT, inputs);
  let launched = null;
  let context = null;
  let video = null;
  try {
    launched = await launchBrowser(playwright.chromium, executable, tempRoot, {headless:!headed});
    context = await launched.browser.newContext({viewport:VIDEO_SIZE, deviceScaleFactor:1, recordVideo:{dir:webmDir, size:VIDEO_SIZE}});
    const page = await context.newPage();
    await page.setViewportSize(VIDEO_SIZE);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));
    await page.goto(`${serverHandle.url}/dist/comparison/index.html?capture=1`, {waitUntil:'domcontentloaded', timeout:20000});
    await page.waitForFunction(() => Boolean(window.vectorComparison?.playComparison && window.vectorComparison?.validateComparisonGate), null, {timeout:15000});
    video = page.video();
    if (!video) throw new Error('Playwright video recording did not attach to the capture page');
    const reportRoutes = bundle.reports.map(item => `/__inputs/report-${item.id}.json`);
    await page.evaluate(async ({reportRoutes, evidenceRoute}) => {
      const api = window.vectorComparison;
      const load = async route => {
        const response = await fetch(route, {cache:'no-store'});
        if (!response.ok) throw new Error(`capture input fetch failed (${response.status}): ${route}`);
        return response.json();
      };
      const [reports, evidence] = await Promise.all([Promise.all(reportRoutes.map(load)), load(evidenceRoute)]);
      const preflight = api.validateComparisonGate(reports, evidence);
      if (!preflight.valid) throw new Error(`browser native gate failed: ${preflight.errors.join(' | ')}`);
      window.__vectorCaptureResult = null;
      window.__vectorCaptureError = null;
      Promise.resolve(api.playComparison(reports, evidence)).then(result => {
        window.__vectorCaptureResult = result;
      }).catch(error => {
        window.__vectorCaptureError = String(error?.message ?? error);
        api.runtime.status = 'failed';
        api.runtime.error = window.__vectorCaptureError;
      });
    }, {reportRoutes, evidenceRoute:'/__inputs/reasoning-evidence.json'});
    const playerStartedAt = performance.now();
    await page.waitForFunction(() => window.vectorComparison.runtime.status === 'playing' || window.vectorComparison.runtime.status === 'failed', null, {timeout:10000});
    const runtimeState = await page.evaluate(() => ({status:window.vectorComparison.runtime.status, startedAt:window.vectorComparison.runtime.startedAt}));
    if (runtimeState.status !== 'playing' || !Number.isFinite(runtimeState.startedAt)) throw new Error(`comparison player did not start: ${runtimeState.status}`);
    const layout = await page.evaluate(() => {
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const tiles = [...document.querySelectorAll('#grid .tile')];
      const rects = tiles.map(tile => tile.getBoundingClientRect());
      const reasoning = document.querySelector('[data-run-id="solReasoning"]');
      return {
        captureMode:document.body.classList.contains('capture-mode'),
        gateVisible:visible(document.querySelector('#gate')),
        comparisonVisible:visible(document.querySelector('#comparison')),
        tileIds:tiles.map(tile => tile.dataset.runId),
        reasoningHasIframe:Boolean(reasoning?.querySelector('iframe')),
        viewportWidth:innerWidth,
        viewportHeight:innerHeight,
        scrollHeight:document.documentElement.scrollHeight,
        tilesWithinViewport:rects.length === 9 && rects.every(rect => rect.top >= 0 && rect.bottom <= innerHeight)
      };
    });
    const layoutCheck = validateCaptureLayout(layout, contract.DISPLAY_ORDER);
    if (!layoutCheck.valid) throw new Error(`capture layout QA failed: ${layoutCheck.errors.join(' | ')}`);
    await page.waitForFunction(states => states.includes(window.vectorComparison.runtime.status), [...TERMINAL_PLAYBACK_STATES], {timeout:50000});
    const hostElapsedMs = performance.now() - playerStartedAt;
    const finished = await page.evaluate(() => ({
      status:window.vectorComparison.runtime.status,
      error:window.__vectorCaptureError ?? window.vectorComparison.runtime.error,
      result:window.__vectorCaptureResult,
      startedAt:window.vectorComparison.runtime.startedAt,
      frameGaps:window.vectorComparison.runtime.frameJitterMs,
      pageElapsedMs:performance.now() - window.vectorComparison.runtime.startedAt
    }));
    if (finished.status !== 'complete' || finished.result?.status !== 'complete') throw new Error(`comparison playback failed: ${finished.error ?? finished.status}`);
    if (pageErrors.length) throw new Error(`browser page error: ${pageErrors.join(' | ')}`);
    const timing = {
      browserElapsedMs:playbackElapsedMs(finished.result, finished.pageElapsedMs),
      pageObservedElapsedMs:finished.pageElapsedMs,
      hostElapsedMs,
      startSpreadMs:finished.result.startSpreadMs,
      maxFrameGapMs:maxOf(finished.frameGaps),
      frameCount:Array.isArray(finished.frameGaps) ? finished.frameGaps.length : 0,
      recordingStartOffsetSeconds:finished.startedAt / 1000
    };
    const timingCheck = validateBrowserTiming(timing);
    if (!timingCheck.valid) throw new Error(`browser timing QA failed: ${timingCheck.errors.join(' | ')}`);

    await context.close();
    context = null;
    const webmPath = await video.path();
    await mkdir(absoluteOutput, {recursive:true});
    const mp4Path = path.join(absoluteOutput, DEFAULT_OUTPUT_NAME);
    const offset = Math.max(0, timing.recordingStartOffsetSeconds);
    await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', webmPath, '-ss', offset.toFixed(3), '-t', String(VIDEO_DURATION_SECONDS),
      '-vf', `fps=${VIDEO_FPS}`, '-frames:v', String(VIDEO_DURATION_SECONDS * VIDEO_FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path
    ]);
    const probeProcess = await runProcess(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,codec_name,width,height,duration,avg_frame_rate,r_frame_rate,nb_frames:format=duration', '-of', 'json', mp4Path]);
    const probe = JSON.parse(probeProcess.stdout);
    const decode = await runProcess(ffmpeg, ['-v', 'error', '-i', mp4Path, '-f', 'null', '-']);
    const qa = validateCaptureQuality({probe, decoded:decode.code === 0, timing, layout, expectedTileIds:contract.DISPLAY_ORDER});
    if (!qa.valid) throw new Error(`encoded video QA failed: ${qa.errors.join(' | ')}`);
    const frames = await extractQaFrames(ffmpeg, mp4Path, absoluteOutput);
    const frameProofs = await Promise.all(frames.map(async relativePath => ({relativePath, sha256:await hashPath(path.join(absoluteOutput, relativePath))})));
    const videoInfo = await stat(mp4Path);
    const qaArtifact = buildCaptureQaArtifact({
      video:{file:path.basename(mp4Path), sha256:await hashPath(mp4Path), sizeBytes:videoInfo.size},
      probe,
      timing,
      decoded:decode.code === 0,
      browser:{mode:launched.mode, executable:path.basename(executable), headless:!headed, viewport:VIDEO_SIZE},
      frames:frameProofs,
      layout,
      sourceManifestSha256
    });
    return {
      status:'complete',
      browser:{mode:launched.mode, executable:path.basename(executable), headless:!headed, viewport:VIDEO_SIZE},
      file:path.basename(mp4Path),
      durationSeconds:qa.duration,
      resolution:{width:qa.width,height:qa.height},
      decoded:true,
      timing,
      layout,
      qaFrames:frameProofs,
      qaArtifact
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (launched) await launched.cleanup().catch(() => {});
    serverHandle.server.close();
    await rm(tempRoot, {recursive:true, force:true});
  }
}

function helpText() {
  return [
    'VECTOR RUN comparison recorder',
    'node scripts/record-comparison.mjs --formal-results FILE --output-dir EXTERNAL_VIDEO_DIR [--evidence FILE] [--capture] [--headed] [--browser-path FILE]',
    'or: node scripts/record-comparison.mjs --results-dir DIR --output-dir EXTERNAL_VIDEO_DIR [--evidence FILE] [--capture] [--headed]',
    'Default mode validates the eight native reports plus Sol-Reasoning unavailable evidence and writes capture-inputs.json only.',
    '--capture runs the 1920x1080 1x browser trace replay, encodes a 33-second MP4, probes and fully decodes it, and extracts start/mid/end PNGs.',
    '--headed runs Chrome/Edge with a visible window when headless rendering misses the real-time frame-gap gate.'
  ].join('\n');
}

async function importPlayerContract() {
  return import(pathToFileURL(path.join(GAME_ROOT, 'dist', 'comparison', 'player.js')).href);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${helpText()}\n`); return; }
  const outputDir = assertExternalOutput(options.output);
  const contract = await importPlayerContract();
  const bundle = options.formalResults
    ? await loadFormalResultsBundle({formalResultsPath:options.formalResults, evidenceOverride:options.evidence, contract})
    : await discoverResultsDirBundle({resultsDir:options.resultsDir, evidencePath:options.evidence, contract});
  const manifest = buildCaptureManifest(bundle, {outputDir, captureRequested:options.capture});
  await mkdir(outputDir, {recursive:true});
  const manifestPath = path.join(outputDir, CAPTURE_MANIFEST_NAME);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`Native preflight passed (${bundle.reports.length} reports, q${bundle.questionCount}); manifest: ${manifestPath}\n`);
  if (!options.capture) return;
  try {
    manifest.recording = {...manifest.recording, status:'capturing'};
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const capture = await captureComparison(bundle, {outputDir, contract, browserPath:options.browserPath, headed:options.headed, sourceManifestSha256:await hashPath(manifestPath)});
    const qaPath = path.join(outputDir, 'capture-qa.json');
    await writeFile(qaPath, `${JSON.stringify(capture.qaArtifact, null, 2)}\n`, 'utf8');
    manifest.recording = {...manifest.recording, status:'visual_review_pending', performed:true, automatedChecks:'passed', outputFile:capture.file, durationSeconds:capture.durationSeconds, resolution:capture.resolution, decoded:capture.decoded, browser:capture.browser, timing:capture.timing, captureLayout:capture.layout, qaFrames:capture.qaFrames, qaFile:path.basename(qaPath), qaSha256:await hashPath(qaPath)};
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`Automated capture QA passed; PNG visual review pending: ${path.join(outputDir, capture.file)}\n`);
  } catch (error) {
    manifest.recording = {...manifest.recording, status:'failed', performed:false, error:String(error?.message ?? error)};
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
