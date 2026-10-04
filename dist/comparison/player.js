import {Engine, VERSION, configHashFor, hash, replayRecord, ruleIdFor, speedAt} from '../engine.js';

export const DECISION_BASE_QUESTION_KEYS = Object.freeze(['action', 'commit', 'danger']);
export const DECISION_PROBE_KEYS = Object.freeze(Array.from({length: 61}, (_, index) => `p${index}`));
export const DECISION_QUESTION_KEYS = Object.freeze({
  3: DECISION_BASE_QUESTION_KEYS,
  64: Object.freeze([...DECISION_BASE_QUESTION_KEYS, ...DECISION_PROBE_KEYS])
});

const ACTIONS = new Set(['wait', 'jump', 'release']);
const REQUIRED_RUNS = Object.freeze(['kai', 'eos', 'sol', 'solReasoning', 'nox', 'lux', 'vega', 'rule', 'idle']);
const MEASUREMENT_COMMIT = '717f02dc9852b88c253ace32f42fcb6d780ed0d3';
const MEASUREMENT_SOURCE_DIGEST = 'd7f9de9c3aaf0e22669dd54e916f9a854ea33b2339f83c183438f4c93be5357a';
const ownKeys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
const exactKeys = (value, keys) => JSON.stringify(ownKeys(value)) === JSON.stringify([...keys].sort());
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const japaneseText = value => typeof value === 'string' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
const sortedJson = value => Array.isArray(value)
  ? `[${value.map(sortedJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function hasGeometryDescription(instructions) {
  return typeof instructions === 'string'
    && /横\s*800\s*[×x]\s*縦\s*360/i.test(instructions)
    && /地面は\s*y\s*=\s*278/.test(instructions)
    && /playerの固定boxは\s*x\s*=\s*116\s*,\s*width\s*=\s*34\s*,\s*height\s*=\s*42/i.test(instructions)
    && /player\.yは地面からの高さで上向きが正/.test(instructions)
    && /vyも上向きが正/.test(instructions)
    && /obstacles\[\]\.xは画面左端/.test(instructions)
    && /heldは維持され/.test(instructions)
    && /jump上限はstate\.player\.maxJumpsです（標準設定は2回）/.test(instructions)
    && /2回目のjumpにはreleaseしてからjumpを再pressします/.test(instructions)
    && /着地すると回数が戻ります/.test(instructions);
}

export function validateVisibleState(state, {allowProbes = false} = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  const keys = ['schema', 'tick', 'dead', 'player', 'obstacles', ...(allowProbes ? ['probes'] : [])];
  if (!exactKeys(state, keys)) fail('visible state keys are not exact');
  if (state?.schema !== 'vector-run-visible-state/v1') fail('visible state schema is invalid');
  if (!integer(state?.tick)) fail('visible state tick must be a non-negative integer');
  if (typeof state?.dead !== 'boolean') fail('visible state dead must be boolean');
  if (!exactKeys(state?.player, ['y', 'vy', 'held', 'jumpsUsed', 'maxJumps', 'speed'])) fail('visible state player keys are not exact');
  if (!finiteNumber(state?.player?.y) || !finiteNumber(state?.player?.vy) || !finiteNumber(state?.player?.speed)) fail('visible player coordinates and speed must be finite numbers');
  if (typeof state?.player?.held !== 'boolean') fail('visible player held must be boolean');
  if (!integer(state?.player?.jumpsUsed) || ![1, 2].includes(state?.player?.maxJumps) || state.player.jumpsUsed > state.player.maxJumps) fail('visible player jump counters are invalid');
  if (!Array.isArray(state?.obstacles)) fail('visible state obstacles must be an array');
  else for (const obstacle of state.obstacles) {
    if (!exactKeys(obstacle, ['x', 'width', 'height']) || !finiteNumber(obstacle.x) || !finiteNumber(obstacle.width) || !finiteNumber(obstacle.height) || obstacle.width <= 0 || obstacle.height <= 0) {
      fail('visible obstacles may contain only finite x/width/height values');
      break;
    }
  }
  if (allowProbes) {
    if (!Array.isArray(state?.probes) || state.probes.length !== 61 || state.probes.some(value => typeof value !== 'boolean')) fail('q64 visible state probes must contain 61 explicit booleans');
  } else if (state && Object.hasOwn(state, 'probes')) fail('q3 visible state must not contain probes');
  return {valid: errors.length === 0, errors};
}

function validateQuestionCount(request) {
  const keys = ownKeys(request?.questions);
  if (exactKeys(request?.questions, DECISION_QUESTION_KEYS[3])) return 3;
  if (exactKeys(request?.questions, DECISION_QUESTION_KEYS[64])) return 64;
  return 0;
}

function parseRawResponse(rawResponse, fail) {
  if (typeof rawResponse !== 'string') {
    if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
      fail('rawResponse must be a JSON string or object');
      return null;
    }
    return rawResponse;
  }
  try { return JSON.parse(rawResponse); }
  catch { fail('rawResponse must be valid JSON'); return null; }
}

function hasForbiddenGeneratedText(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'text') || Object.hasOwn(value, 'rationale')) return true;
  return Object.values(value).some(hasForbiddenGeneratedText);
}

function validateAnswers(answers, questionCount, fail) {
  const requiredKeys = DECISION_QUESTION_KEYS[questionCount] ?? [];
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    fail('response.answers is required');
    return null;
  }
  if (!exactKeys(answers, requiredKeys)) fail(`response.answers keys must exactly match q${questionCount}`);
  for (const key of requiredKeys) {
    const answer = answers[key];
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      fail(`answers.${key} must be an object`);
      continue;
    }
    if (key === 'action') {
      if (!ACTIONS.has(answer.choice) || !answer.probabilities || typeof answer.probabilities !== 'object' || Array.isArray(answer.probabilities) || Object.values(answer.probabilities).some(value => !finiteNumber(value))) fail('answers.action must contain a valid choice and raw numeric probabilities');
      if (answer.type !== undefined && answer.type !== 'choice') fail('answers.action.type must be choice when present');
    } else if (key === 'commit') {
      if (!finiteNumber(answer.noul)) fail('answers.commit.noul must be numeric');
      if (answer.type !== undefined && answer.type !== 'noul') fail('answers.commit.type must be noul when present');
    } else if (key === 'danger') {
      if (!finiteNumber(answer.score)) fail('answers.danger.score must be numeric');
      if (answer.type !== undefined && answer.type !== 'score') fail('answers.danger.type must be score when present');
    } else {
      if (!finiteNumber(answer.noul)) fail(`answers.${key}.noul must be numeric`);
      if (answer.type !== undefined && answer.type !== 'noul') fail(`answers.${key}.type must be noul when present`);
    }
  }
  return answers;
}

/** Validate one raw Decision 2.0 exchange without changing either wire object. */
export function validateDecision20Turn(request, rawResponse) {
  const errors = [];
  const fail = message => errors.push(message);
  const questionCount = validateQuestionCount(request);
  if (!exactKeys(request, ['model', 'state', 'questions'])) fail('request keys must be exactly model, state, questions');
  if (!request || typeof request.model !== 'string' || !request.model.trim()) fail('request.model must be a non-empty string');
  if (!request?.state || typeof request.state !== 'object' || Array.isArray(request.state)) fail('request.state must be a JSON object');
  else for (const error of validateVisibleState(request.state, {allowProbes:questionCount === 64}).errors) fail(`request.state: ${error}`);

  if (!questionCount) fail('questions must contain exactly the q3 or q64 keys');
  const questions = request?.questions;
  const qAction = questions?.action;
  if (!exactKeys(qAction, ['type', 'instructions', 'criteria']) || qAction.type !== 'choice' || !japaneseText(qAction.instructions) || !hasGeometryDescription(qAction.instructions) || !exactKeys(qAction.criteria, ['wait', 'jump', 'release']) || Object.values(qAction.criteria).some(value => !japaneseText(value))) {
    fail('questions.action must disclose the fixed Japanese geometry and wait/jump/release meanings');
  }
  const qCommit = questions?.commit;
  if (!exactKeys(qCommit, ['type', 'instructions']) || qCommit.type !== 'noul' || !japaneseText(qCommit.instructions)) fail('questions.commit must be a Japanese noul question');
  const qDanger = questions?.danger;
  if (!exactKeys(qDanger, ['type', 'instructions', 'criteria']) || qDanger.type !== 'score' || !japaneseText(qDanger.instructions) || !Array.isArray(qDanger.criteria) || qDanger.criteria.length !== 3 || qDanger.criteria.some((value, index) => value !== ['safe', 'caution', 'danger'][index])) {
    fail('questions.danger must be a Japanese three-level safe/caution/danger score');
  }
  if (questionCount === 64) {
    for (let index = 0; index < 61; index++) {
      const question = questions?.[`p${index}`];
      if (!exactKeys(question, ['type', 'instructions']) || question.type !== 'noul' || !japaneseText(question.instructions) || !new RegExp(`state\\.probes\\[${index}\\].*値はtrueですか`).test(question.instructions) || !/trueなら1/.test(question.instructions) || !/falseなら0/.test(question.instructions)) {
        fail(`questions.p${index} must ask whether state.probes[${index}] is true`);
      }
    }
  }

  const response = parseRawResponse(rawResponse, fail);
  if (!response || typeof response !== 'object' || Array.isArray(response) || !Object.hasOwn(response, 'answers')) fail('response.answers is required');
  if (response && hasForbiddenGeneratedText(response)) fail('generated text and rationale are not allowed');
  const answers = validateAnswers(response?.answers, questionCount, fail);
  const action = answers?.action;
  return {valid: errors.length === 0, errors, action: errors.length === 0 ? action.choice : null, questionCount};
}

function comparisonId(report) {
  if (report?.agent?.kind === 'rule') return 'rule';
  if (report?.agent?.kind === 'idle') return 'idle';
  if (report?.agent?.kind !== 'remote') return null;
  const model = String(report.agent.model ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({kai:'kai',eos:'eos',sol:'sol',solreasoning:'solReasoning',nox:'nox',lux:'lux',vega:'vega'})[model] ?? null;
}

function gpuLabel(report) {
  const hardware = report?.hardware ?? report?.metadata?.hardware;
  const value = hardware?.gpuAlias ?? hardware?.gpuName ?? hardware?.gpu ?? hardware?.device ?? hardware?.name ?? null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function reportSeed101Run(report) {
  return Array.isArray(report?.runs) ? report.runs.find(run => run?.seed === 101) : null;
}

function validateInputLogs(run, errors, id) {
  if (!Array.isArray(run?.inputLogs)) {
    errors.push(`${id} inputLogs are missing`);
    return;
  }
  let previousTick = -1;
  const decisionIds = new Set();
  for (const [index, input] of run.inputLogs.entries()) {
    if (!['jump','release'].includes(input?.action) || !integer(input?.tick) || input.tick >= run.finalTick || input.tick <= previousTick || input.applicationTick !== input.tick + 1 || typeof input.accepted !== 'boolean' || typeof input.decisionId !== 'string' || !input.decisionId) {
      errors.push(`${id} inputLogs[${index}] must preserve event.tick=N and applicationTick=N+1`);
      break;
    }
    if (decisionIds.has(input.decisionId)) errors.push(`${id} inputLogs contains duplicate decisionId ${input.decisionId}`);
    decisionIds.add(input.decisionId);
    previousTick = input.tick;
  }
}

function validateActionRows(run, errors, id) {
  if (!Array.isArray(run?.actions)) {
    errors.push(`${id} actions are missing`);
    return;
  }
  const decisionsById = new Map();
  const actionsByDecision = new Map();
  const inputsByDecision = new Map();
  if (!Array.isArray(run?.decisions)) errors.push(`${id} decisions are missing`);
  for (const [index, turn] of (run?.decisions ?? []).entries()) {
    if (typeof turn?.decisionId !== 'string' || !turn.decisionId) {
      errors.push(`${id} decisions[${index}] decisionId is missing`);
      continue;
    }
    if (decisionsById.has(turn.decisionId)) errors.push(`${id} decisions contains duplicate decisionId ${turn.decisionId}`);
    else decisionsById.set(turn.decisionId, turn);
    if (turn.applicationTick !== null && turn.applicationTick !== undefined && !integer(turn.applicationTick)) errors.push(`${id} decision ${turn.decisionId} applicationTick is invalid`);
  }
  for (const [index, action] of run.actions.entries()) {
    if (!['wait','jump','release'].includes(action?.action) || !integer(action?.tick) || action.tick >= run.finalTick || action.applicationTick !== action.tick + 1 || typeof action.decisionId !== 'string' || !action.decisionId) {
      errors.push(`${id} actions[${index}] must preserve the CLI next-tick action row`);
      break;
    }
    const rows = actionsByDecision.get(action.decisionId) ?? [];
    rows.push(action);
    actionsByDecision.set(action.decisionId, rows);
    if (rows.length > 1) errors.push(`${id} actions contains duplicate decisionId ${action.decisionId}`);
  }
  for (const [index, input] of (run.inputLogs ?? []).entries()) {
    if (typeof input?.decisionId !== 'string' || !input.decisionId) continue;
    const rows = inputsByDecision.get(input.decisionId) ?? [];
    rows.push(input);
    inputsByDecision.set(input.decisionId, rows);
    if (rows.length > 1) errors.push(`${id} inputLogs contains duplicate decisionId ${input.decisionId}`);
    if (!['jump','release'].includes(input.action)) errors.push(`${id} inputLogs[${index}] must only contain jump/release inputs`);
  }

  for (const [decisionId, turn] of decisionsById) {
    const actionRows = actionsByDecision.get(decisionId) ?? [];
    const inputRows = inputsByDecision.get(decisionId) ?? [];
    if (integer(turn.applicationTick)) {
      if (actionRows.length !== 1) errors.push(`${id} applied decision ${decisionId} must link to exactly one CLI actions row`);
    } else if (actionRows.length !== 0) errors.push(`${id} unapplied decision ${decisionId} has an action row`);
    if (actionRows.length !== 1) {
      if (inputRows.length) errors.push(`${id} input ${decisionId} has no unique linked actions row`);
      continue;
    }
    const action = actionRows[0];
    if (!integer(turn.applicationTick) || action.applicationTick !== turn.applicationTick || action.tick !== turn.applicationTick - 1 || action.action !== turn.action) errors.push(`${id} applied decision ${decisionId} does not match its CLI actions row`);
    if (action.action === 'wait') {
      if (action.accepted !== null) errors.push(`${id} wait decision must remain a no-op with accepted:null`);
      if (inputRows.length) errors.push(`${id} wait decision ${decisionId} must not have an inputLogs row`);
    } else {
      if (typeof action.accepted !== 'boolean') errors.push(`${id} input action acceptance is missing`);
      if (inputRows.length !== 1) errors.push(`${id} physical action ${decisionId} must link to exactly one inputLogs row`);
      else {
        const input = inputRows[0];
        if (input.tick !== action.tick || input.applicationTick !== action.applicationTick || input.action !== action.action || input.accepted !== action.accepted) errors.push(`${id} physical input ${decisionId} differs from the CLI actions/inputLogs rows`);
      }
    }
  }
  for (const decisionId of actionsByDecision.keys()) {
    if (!decisionsById.has(decisionId)) errors.push(`${id} actions contains orphan decisionId ${decisionId}`);
  }
  for (const decisionId of inputsByDecision.keys()) {
    if (!decisionsById.has(decisionId)) errors.push(`${id} inputLogs contains orphan decisionId ${decisionId}`);
  }
}

function decisionSkipKey(item) {
  return `${item?.decisionId ?? ''}|${item?.tick ?? ''}|${item?.reason ?? ''}`;
}

function validateDecisionRows(report, run, errors, id, horizonTicks) {
  if (!Array.isArray(run?.decisions)) {
    errors.push(`${id} decisions are missing`);
    return;
  }
  if (!Array.isArray(run?.skips)) {
    errors.push(`${id} skips are missing`);
    return;
  }
  const kind = report.agent.kind;
  const questionCount = report.variant.questionCount;
  const expectedSkips = [];
  let previousDispatch = 0;
  let outstandingUntil = -1;
  let requestIndex = 0;
  let localIndex = 0;
  for (const [index, turn] of run.decisions.entries()) {
    const prefix = `${id} decision ${index}`;
    const tick = turn?.dispatchTick;
    if (!integer(tick) || tick <= previousDispatch || tick % 16 !== 0 || tick > run.finalTick || tick > horizonTicks) {
      errors.push(`${prefix} dispatchTick must follow the 16-tick opportunity cadence`);
      continue;
    }
    previousDispatch = tick;
    if (typeof turn?.decisionId !== 'string' || !turn.decisionId) errors.push(`${prefix} decisionId is missing`);
    if (turn.questionCount !== questionCount) errors.push(`${prefix} questionCount differs from the CLI report variant`);
    const rawRequest = turn.rawRequest;
    if (kind === 'idle') {
      if (rawRequest !== null || turn.rawResponse !== null || turn.status !== 'idle_no_action' || turn.action !== null) errors.push(`${prefix} must preserve the CLI idle_no_action row without a raw request`);
      expectedSkips.push({tick,decisionId:turn.decisionId,reason:'idle_baseline'});
      continue;
    }
    if (kind === 'rule') {
      if (rawRequest !== null || !['wait','jump','release'].includes(turn.action) || turn.status !== 'answered' || turn.completionTick !== tick) errors.push(`${prefix} must preserve the CLI local rule decision row`);
      const local = validateAnswers(turn.answers, questionCount, message => errors.push(`${prefix}: ${message}`));
      if (turn.rawResponse !== null) errors.push(`${prefix} local decision must not invent a SystemOne raw response`);
      if (local?.action?.choice !== turn.action) errors.push(`${prefix} local answers and action differ`);
      if (turn.rawProbabilities && sortedJson(turn.rawProbabilities) !== sortedJson(local?.action?.probabilities)) errors.push(`${prefix} local raw probabilities differ from answers`);
      if (questionCount === 64) {
        for (let probe = 0; probe < 61; probe++) {
          const expected = (probe + localIndex) % 2 === 0 ? 1 : 0;
          if (turn.answers?.[`p${probe}`]?.noul !== expected) errors.push(`${prefix} local q64 probe answer does not match its synthetic boolean`);
        }
      }
      localIndex++;
      if (turn.status === 'skipped_outstanding') expectedSkips.push({tick,decisionId:turn.decisionId,reason:'request_outstanding'});
      continue;
    }

    if (rawRequest === null) {
      if (turn.status !== 'skipped_outstanding' || turn.rawResponse !== null || turn.action !== null || turn.completionTick !== null || turn.applicationTick !== null) errors.push(`${prefix} remote rows without rawRequest must be skipped_outstanding`);
      if (tick > outstandingUntil) errors.push(`${prefix} skipped_outstanding row has no active prior request`);
      expectedSkips.push({tick,decisionId:turn.decisionId,reason:'request_outstanding'});
      continue;
    }

    if (tick < outstandingUntil) errors.push(`${prefix} overlaps a prior outstanding SystemOne request`);
    if (!exactKeys(rawRequest, ['model','state','questions']) || rawRequest.model !== report.agent.model) errors.push(`${prefix} rawRequest does not match the CLI model/request envelope`);
    if (turn.rawRequestBody !== null && typeof turn.rawRequestBody === 'string') {
      try {
        if (sortedJson(JSON.parse(turn.rawRequestBody)) !== sortedJson(rawRequest)) errors.push(`${prefix} rawRequestBody differs from the preserved rawRequest`);
      } catch { errors.push(`${prefix} rawRequestBody is not valid JSON`); }
    } else errors.push(`${prefix} rawRequestBody is missing`);
    if (typeof turn.rawResponse !== 'string') errors.push(`${prefix} dispatched remote row must preserve rawResponse as its original JSON string`);
    const responseCheck = validateDecision20Turn(rawRequest, turn.rawResponse);
    if (!responseCheck.valid) errors.push(`${prefix}: ${responseCheck.errors.join('; ')}`);
    if (responseCheck.questionCount !== questionCount) errors.push(`${prefix} request question count differs from the CLI report variant`);
    if (rawRequest?.state?.tick !== tick) errors.push(`${prefix} visible-state tick differs from dispatchTick`);
    if (questionCount === 64 && Array.isArray(rawRequest?.state?.probes)) {
      for (let probe = 0; probe < 61; probe++) {
        if (rawRequest.state.probes[probe] !== ((probe + requestIndex) % 2 === 0)) errors.push(`${prefix} q64 probe state is not the CLI synthetic boolean sequence`);
      }
    }
    if (turn.action !== responseCheck.action) errors.push(`${prefix} action differs from the required raw response`);
    let parsedRawResponse = null;
    try { parsedRawResponse = parseRawResponse(turn.rawResponse, () => {}); } catch {}
    if (!turn.rawProbabilities || sortedJson(turn.rawProbabilities) !== sortedJson(parsedRawResponse?.answers?.action?.probabilities)) errors.push(`${prefix} raw action probabilities were not preserved`);

    if (turn.lateReply === true || turn.status === 'late_answer_not_applied') {
      if (turn.status !== 'late_answer_not_applied' || turn.completionTick !== null || turn.applicationTick !== null || typeof turn.rawResponse !== 'string' || !responseCheck.valid || !finiteNumber(turn.latencyMs) || turn.latencyMs < 0) errors.push(`${prefix} late answer must retain its valid raw reply, latency, and null completion/application ticks`);
      const evidence = lateMeasurementEvidence(report, run, turn);
      if (!evidence.valid) errors.push(`${prefix} cannot be labeled measured no-response: ${evidence.errors.join('; ')}`);
      outstandingUntil = Number.POSITIVE_INFINITY;
    } else {
      if (turn.status !== 'answered' || turn.lateReply !== false) errors.push(`${prefix} remote dispatch is not a valid answered row`);
      if (!integer(turn.completionTick) || turn.completionTick < tick || turn.completionTick > run.finalTick) errors.push(`${prefix} completionTick is invalid`);
      if (!integer(turn.applicationTick) || turn.applicationTick <= turn.completionTick || turn.applicationTick > run.finalTick) errors.push(`${prefix} answered row applicationTick is invalid`);
      if (integer(turn.completionTick)) outstandingUntil = turn.completionTick;
    }
    requestIndex++;
  }

  const lastOpportunity = run?.endReason === 'collision' ? run.finalTick - 1 : run.finalTick;
  const expectedTicks = [];
  for (let tick = 16; tick <= lastOpportunity; tick += 16) expectedTicks.push(tick);
  const actualTicks = run.decisions.map(item => item?.dispatchTick);
  if (JSON.stringify(actualTicks) !== JSON.stringify(expectedTicks)) errors.push(`${id} decisions must retain every CLI opportunity through the terminal/horizon tick`);

  const actualSkips = run.skips.map(item => decisionSkipKey(item)).sort();
  const expectedSkipKeys = expectedSkips.map(item => decisionSkipKey(item)).sort();
  if (JSON.stringify(actualSkips) !== JSON.stringify(expectedSkipKeys)) errors.push(`${id} skips do not match the CLI decision rows`);
  if (kind === 'remote' && requestIndex === 0) errors.push(`${id} has no actual SystemOne dispatch`);
}

function lateMeasurementEvidence(report, run, turn) {
  const errors = [];
  const response = parseRawResponse(turn?.rawResponse, message => errors.push(message));
  if (!run?.traceEnabled || report?.variant?.trace !== true) errors.push('CLI traceEnabled/variant.trace is not true');
  if (!turn?.lateReply || turn?.status !== 'late_answer_not_applied' || typeof turn?.rawResponse !== 'string') errors.push('late raw response is missing');
  if (typeof response?.model !== 'string' || !response.model.trim() || !response?.usage || typeof response.usage !== 'object' || Array.isArray(response.usage) || !response?.measurements || typeof response.measurements !== 'object' || Array.isArray(response.measurements)) errors.push('raw late response model/usage/measurements are missing');
  const measurements = response?.measurements;
  const forwardCalls = measurements?.neural_forward_calls;
  const forwardBatches = measurements?.neural_forward_batches;
  if (!Number.isSafeInteger(forwardCalls) || forwardCalls <= 0) errors.push('production neural_forward_calls evidence is missing');
  if (!Array.isArray(forwardBatches) || forwardBatches.length === 0 || forwardBatches.length !== forwardCalls) errors.push('production neural_forward_batches evidence does not match neural_forward_calls');
  if (Array.isArray(forwardBatches)) {
    for (const [index, batch] of forwardBatches.entries()) {
      const shape = batch?.input_ids_shape;
      if (!Array.isArray(shape) || shape.length !== 2 || !shape.every(value => Number.isSafeInteger(value) && value > 0)
        || batch?.batch_size !== shape[0] || batch?.padded_tokens_per_question !== shape[1]) {
        errors.push(`production neural_forward_batches[${index}] has no valid input_ids shape`);
        break;
      }
    }
  }
  const deviceLabel = gpuLabel(report);
  const gpuPattern = /gpu|cuda|nvidia|tesla|a\d{2,3}|h\d{2,3}|t\d\b|l\d\b|rtx|geforce|quadro/i;
  if (!deviceLabel || !gpuPattern.test(deviceLabel)) errors.push('report hardware metadata has no GPU identity label; hardware metadata labels the tile but does not prove the forward pass');
  return {valid:errors.length === 0, errors};
}

function validateCliRun(report, run, id, errors) {
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const variant = report.variant;
  require(run?.seed === 101, `${id} must use seed 101`);
  require(run?.maxJumps === 2, `${id} must use two jumps`);
  require(run?.questionCount === variant.questionCount, `${id} run questionCount differs from its report`);
  require(run?.traceEnabled === true && variant.trace === true, `${id} trace must be enabled`);
  require(integer(run?.finalTick) && run.finalTick <= 3600, `${id} finalTick must be within the 30-second horizon`);
  require(run?.terminalStatus === run?.endReason && ['collision','time_limit'].includes(run.terminalStatus), `${id} terminalStatus/endReason must be collision or time_limit`);
  require(typeof run?.finalSnapshotHash === 'string' && /^[0-9a-f]{8}$/i.test(run.finalSnapshotHash), `${id} finalSnapshotHash is missing`);
  require(Array.isArray(run?.runtimeGameInvalidErrors) && run.runtimeGameInvalidErrors.length === 0, `${id} runtimeGameInvalidErrors must be empty`);
  require(Array.isArray(run?.responseErrors) && run.responseErrors.length === 0, `${id} responseErrors must be empty`);
  if (run?.terminalStatus === 'time_limit') require(run.finalTick === 3600 && run.censored === true, `${id} time_limit must be right-censored at tick 3600`);
  require(run?.initialState?.tick === 0, `${id} initialState must be tick 0`);
  const initial = validateVisibleState(run?.initialState);
  if (!initial.valid) errors.push(`${id} initialState: ${initial.errors.join('; ')}`);
  require(Array.isArray(run?.frameSnapshots), `${id} frameSnapshots are missing`);
  if (Array.isArray(run?.frameSnapshots)) {
    require(run.frameSnapshots.length === run.finalTick, `${id} frameSnapshots must contain exactly ticks 1..finalTick`);
    for (let index = 0; index < run.frameSnapshots.length; index++) {
      const tick = index + 1;
      const frame = run.frameSnapshots[index];
      const stateCheck = validateVisibleState(frame?.state);
      if (frame?.tick !== tick || frame?.state?.tick !== tick || !stateCheck.valid) {
        errors.push(`${id} frameSnapshots must be the continuous visible-state sequence from tick 1${stateCheck.valid ? '' : ` (${stateCheck.errors.join('; ')})`}`);
        break;
      }
    }
  }
  validateInputLogs(run, errors, id);
  validateActionRows(run, errors, id);
  validateDecisionRows(report, run, errors, id, 3600);
}

/** Validate nine native vector-run-decision-bench/v1 CLI reports; no video result schema is introduced. */
export function validateComparisonGate(reports) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  require(Array.isArray(reports) && reports.length === REQUIRED_RUNS.length, 'exactly nine native CLI reports are required');
  if (!Array.isArray(reports)) return {valid:false, errors, questionCount:null};
  const ids = reports.map(comparisonId);
  require(ids.every(Boolean) && new Set(ids).size === REQUIRED_RUNS.length && REQUIRED_RUNS.every(id => ids.includes(id)), 'reports must contain Kai, Eos, Sol, SolReasoning, Nox, Lux, Vega, rule, and idle');
  const questionCounts = new Set();
  const sourceIds = new Set();
  for (let index = 0; index < reports.length; index++) {
    const report = reports[index];
    const id = ids[index] ?? `report ${index}`;
    require(report?.schema === 'vector-run-decision-bench/v1', `${id} must use the native CLI result schema`);
    require(report?.game?.repo === 'https://github.com/Sunwood-ai-labs/vector-run-benchmark', `${id} game repository is not canonical`);
    require(report?.game?.commit === MEASUREMENT_COMMIT, `${id} game commit does not match frozen measurementCommit`);
    require(report?.game?.sourceDigest === MEASUREMENT_SOURCE_DIGEST, `${id} sourceDigest does not match frozen measurement source`);
    require(report?.game?.engineVersion === VERSION && report?.game?.ruleId === ruleIdFor(2), `${id} game engine/rule provenance differs from this renderer`);
    require(report?.game?.observationPipeline === 'structured-visible-state-v1', `${id} must use structured-visible-state-v1`);
    if (typeof report?.game?.commit === 'string' && typeof report?.game?.sourceDigest === 'string') sourceIds.add(`${report.game.commit}|${report.game.sourceDigest}`);
    const variant = report?.variant;
    require(variant?.questionCount === variant?.systemOneQuestionCount && [3,64].includes(variant?.questionCount), `${id} questionCount must be q3 or q64 per SystemOne request`);
    require(variant?.questionCountMeaning === 'number of questions in one SystemOne request', `${id} questionCount meaning must describe request size`);
    require(variant?.physicsHz === 120 && variant?.playbackRate === '1x realtime' && variant?.maxSeconds === 30 && variant?.maxJumps === 2, `${id} realtime variant provenance differs`);
    require(variant?.dispatchEveryTicks === 16 && variant?.oneOutstanding === true, `${id} must use the 16-tick cadence and one outstanding request`);
    require(typeof variant?.frameGapPolicy === 'string' && /100\s*ms/i.test(variant.frameGapPolicy) && /no catch-up/i.test(variant.frameGapPolicy), `${id} must preserve the 100 ms invalid-gap/no-catch-up policy`);
    require(variant?.trace === true, `${id} CLI trace flag is not enabled`);
    require(Array.isArray(report?.runtimeGameInvalidErrors) && report.runtimeGameInvalidErrors.length === 0, `${id} report runtimeGameInvalidErrors must be empty`);
    if ([3,64].includes(variant?.questionCount)) questionCounts.add(variant.questionCount);
    require(report?.agent?.kind === 'remote' ? typeof report.agent.model === 'string' && report.agent.model.length > 0 : ['rule','idle'].includes(report?.agent?.kind), `${id} CLI agent metadata is invalid`);
    const run = reportSeed101Run(report);
    require(Boolean(run), `${id} report has no seed-101 run`);
    if (run) validateCliRun(report, run, id, errors);
  }
  require(sourceIds.size === 1, 'all nine reports must use the same game commit and source digest');
  require(questionCounts.size === 1, 'q3 and q64 reports cannot be mixed in one nine-tile cohort');
  return {valid:errors.length === 0, errors, questionCount:questionCounts.size === 1 ? [...questionCounts][0] : null};
}

function visibleStateFromEngine(engine) {
  const obstacles = engine.course.items.map(obstacle => ({
    x: obstacle.center - engine.distance - obstacle.width / 2,
    width: obstacle.width,
    height: obstacle.height
  })).filter(obstacle => obstacle.x + obstacle.width > 0 && obstacle.x < engine.config.worldWidth);
  return {
    schema: 'vector-run-visible-state/v1',
    tick: engine.tick,
    dead: engine.dead,
    player: {
      y: engine.y,
      vy: engine.vy,
      held: engine.held,
      jumpsUsed: engine.jumpsUsed,
      maxJumps: engine.maxJumps,
      speed: speedAt(engine.seconds)
    },
    obstacles
  };
}

/** Replay every recorded input through the canonical engine and compare each public snapshot. */
export function buildComparisonReplayRecord(run) {
  const errors = [];
  const fail = message => errors.push(message);
  if (run?.seed !== 101 || run?.maxJumps !== 2) fail('trace provenance does not match seed-101 two-jump cohort');
  if (!integer(run?.finalTick) || !Array.isArray(run?.frameSnapshots) || run.frameSnapshots.length !== run.finalTick) fail('trace must contain initialState tick 0 plus frameSnapshots ticks 1 through finalTick');
  if (run?.initialState?.tick !== 0) fail('trace initialState must be tick 0');
  if (!Array.isArray(run?.inputLogs)) fail('trace inputLogs are missing');
  if (errors.length) return {valid:false, errors, record:null};

  const engine = new Engine(run.seed, run.maxJumps);
  let inputIndex = 0;
  const inputs = [];
  if (sortedJson(run.initialState) !== sortedJson(visibleStateFromEngine(engine))) fail('initialState differs from the canonical tick-0 engine state');
  for (let tick = 1; tick <= run.finalTick; tick++) {
    while (inputIndex < run.inputLogs.length && run.inputLogs[inputIndex].applicationTick === tick) {
      const input = run.inputLogs[inputIndex++];
      const event = engine.input(input.action);
      if (input.applicationTick !== input.tick + 1 || event.tick !== input.tick || event.accepted !== input.accepted) fail(`input ${inputIndex - 1} differs before step ${tick}`);
      inputs.push({tick:input.tick, action:input.action, accepted:event.accepted});
    }
    if (engine.dead) fail(`trace continues past collision before tick ${tick}`);
    engine.step();
    const expected = run.frameSnapshots[tick - 1]?.state;
    if (sortedJson(expected) !== sortedJson(visibleStateFromEngine(engine))) fail(`visible state differs at tick ${tick}`);
  }
  if (inputIndex !== run.inputLogs.length) fail('trace contains inputs after finalTick');
  if (run.terminalStatus === 'collision' && !engine.dead) fail('collision terminal status does not match the engine');
  if (run.terminalStatus === 'time_limit' && (engine.dead || run.finalTick !== 3600 || run.censored !== true)) fail('time_limit trace must be right-censored at physical tick 3600');
  if (!['collision', 'time_limit'].includes(run.terminalStatus)) fail('unsupported terminal status');
  const finalSnapshotHash = hash(JSON.stringify(engine.snapshot()));
  if (run.finalSnapshotHash !== finalSnapshotHash) fail('terminal engine fingerprint differs');

  const record = {
    schema: 'vector-run-result/v1',
    version: VERSION,
    configHash: configHashFor(run.maxJumps),
    ruleId: ruleIdFor(run.maxJumps),
    maxJumps: run.maxJumps,
    seed: run.seed,
    mode: 'benchmark',
    endReason: engine.dead ? 'collision' : 'cancelled',
    finalTick: engine.tick,
    distanceWorld: engine.distance,
    finalStateHash:finalSnapshotHash,
    jumps: engine.jumps,
    inputs
  };
  if (!errors.length) {
    try {
      if (!replayRecord(record).matched) fail('canonical app replayRecord did not match');
    } catch (error) {
      fail(`canonical app replayRecord rejected trace: ${error.message}`);
    }
  }
  return {valid:errors.length === 0, errors, record:errors.length === 0 ? record : null, distanceMetres:engine.distance / 10};
}

const replayRuntime = {status:'waiting', error:null, startedAt:null, startSpreadMs:null, frameJitterMs:[]};

function gameCaptureCss() {
  return `html,body{width:100%;height:100%;margin:0!important;overflow:hidden!important;background:#131f2b!important}.shell{width:100%!important;height:100%!important;max-width:none!important;margin:0!important;padding:0!important}.shell>header,.workspace>aside,.play-heading,.scorebar,.controls,.input-help,.result-banner,.history,.protocol,.shell>footer{display:none!important}.workspace{display:block!important;width:100%!important;height:100%!important;margin:0!important}.play-column{display:block!important;width:100%!important;height:100%!important;padding:0!important}.arena{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;border-radius:0!important;box-shadow:none!important}.arena canvas{display:block!important;width:100%!important;height:100%!important;aspect-ratio:auto!important}.arena .overlay{display:none!important}.arena-caption{left:10px!important;right:10px!important;bottom:8px!important}`;
}

function makeTile(run, index, questionCount, root) {
  const tile = document.createElement('article');
  tile.className = 'tile';
  tile.dataset.runId = run.id;
  tile.dataset.status = 'loading';
  const head = document.createElement('div');
  head.className = 'tile-head';
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = run.displayName || run.id;
  const meta = document.createElement('span');
  meta.className = 'tile-meta';
  meta.textContent = run.gpuAlias ? `${run.gpuAlias} · q${questionCount}/request` : `q${questionCount}/request · dispatch/16 ticks`;
  const status = document.createElement('span');
  status.className = 'tile-status';
  status.textContent = 'READY';
  head.append(name, meta, status);
  const frame = document.createElement('iframe');
  frame.title = `${run.displayName || run.id} game replay`;
  frame.src = '../index.html';
  const result = document.createElement('div');
  result.className = 'tile-result';
  const score = document.createElement('span');
  score.textContent = `Seed 101 · ${run.distanceMetres.toFixed(1)} m`;
  const outcome = document.createElement('strong');
  outcome.textContent = run.terminalStatus === 'time_limit' ? 'RIGHT-CENSORED' : 'COLLISION';
  const lateReply = document.createElement('span');
  lateReply.className = 'late-reply-state';
  lateReply.textContent = run.decisions?.some(turn => turn?.lateReply === true && turn?.status === 'late_answer_not_applied') ? 'NO IN-TIME REPLY · MEASURED' : '';
  result.append(score, lateReply, outcome);
  tile.append(head, frame, result);
  root.append(tile);
  return {run, tile, frame, status};
}

async function beginTileReplay(entry) {
  const frame = entry.frame;
  const doc = frame.contentDocument;
  if (!doc || !doc.querySelector('#importReplay')) throw new Error(`${entry.run.id}: canonical replay file input is unavailable`);
  const css = doc.createElement('style');
  css.dataset.comparisonCapture = 'true';
  css.textContent = gameCaptureCss();
  doc.head.append(css);
  const file = new frame.contentWindow.File([JSON.stringify(entry.run.replayRecord)], `vector-run-${entry.run.id}.json`, {type:'application/json'});
  const transfer = new frame.contentWindow.DataTransfer();
  transfer.items.add(file);
  const input = doc.querySelector('#importReplay');
  input.files = transfer.files;
  input.dispatchEvent(new frame.contentWindow.Event('change', {bubbles:true}));
  const startedAt = performance.now();
  const deadline = startedAt + 3000;
  while (performance.now() < deadline) {
    if (doc.querySelector('#stateBadge')?.textContent === 'REPLAY') return startedAt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`${entry.run.id}: canonical app did not enter offline replay`);
}

export async function playComparison(reports) {
  const gateCheck = validateComparisonGate(reports);
  if (!gateCheck.valid) throw new Error(`native CLI reports failed: ${gateCheck.errors.join(' | ')}`);
  const questionCount = gateCheck.questionCount;
  const replays = reports.map(report => {
    const run = reportSeed101Run(report);
    const id = comparisonId(report);
    const displayName = id === 'solReasoning' ? 'Sol Reasoning' : id === 'rule' || id === 'idle' ? id : id[0].toUpperCase() + id.slice(1);
    const gpuAlias = gpuLabel(report);
    const replay = buildComparisonReplayRecord(run);
    return {...run, id, displayName, gpuAlias, ...replay, replayRecord:replay.record};
  });
  const rejected = replays.filter(run => !run.valid);
  if (rejected.length) throw new Error(`exact replay preflight failed: ${rejected.map(run => `${run.displayName}: ${run.errors.join(', ')}`).join(' | ')}`);
  const gate = document.querySelector('#gate');
  const comparison = document.querySelector('#comparison');
  const grid = document.querySelector('#grid');
  grid.replaceChildren();
  const entries = replays.map((run, index) => makeTile(run, index, questionCount, grid));
  gate.hidden = true;
  comparison.hidden = false;
  replayRuntime.status = 'loading';
  replayRuntime.error = null;
  replayRuntime.frameJitterMs.length = 0;
  const loadTimes = await Promise.all(entries.map(entry => new Promise((resolve, reject) => {
    entry.frame.addEventListener('load', () => resolve(entry), {once:true});
    entry.frame.addEventListener('error', () => reject(new Error(`${entry.run.id}: game renderer failed to load`)), {once:true});
  })));
  void loadTimes;
  const dispatchStart = performance.now();
  const starts = await Promise.all(entries.map(beginTileReplay));
  replayRuntime.startedAt = performance.now();
  replayRuntime.startSpreadMs = Math.max(...starts) - Math.min(...starts);
  replayRuntime.status = 'playing';
  const elapsed = document.querySelector('#elapsed');
  const runState = document.querySelector('#run-state');
  const integrity = document.querySelector('#integrity');
  runState.textContent = 'REPLAY 1×';
  integrity.textContent = `q${questionCount}/request · 16-tick dispatch`;
  let lastFrame = performance.now();
  let terminalUiUpdated = false;
  return new Promise(resolve => {
    const update = now => {
      replayRuntime.frameJitterMs.push(now - lastFrame);
      lastFrame = now;
      const seconds = Math.max(0, (now - dispatchStart) / 1000);
      elapsed.textContent = `${seconds.toFixed(1)} s`;
      if (!terminalUiUpdated && seconds >= 30) {
        terminalUiUpdated = true;
        for (const entry of entries) {
          entry.status.textContent = entry.run.terminalStatus === 'time_limit' ? 'CENSORED' : 'FINISHED';
          entry.tile.dataset.status = entry.run.terminalStatus === 'time_limit' ? 'censored' : 'complete';
        }
      }
      if (seconds >= 33) {
        replayRuntime.status = 'complete';
        runState.textContent = 'COMPLETE';
        for (const entry of entries) entry.status.textContent = entry.run.terminalStatus === 'time_limit' ? 'CENSORED' : 'FINISHED';
        resolve({status:'complete',questionCount,startSpreadMs:replayRuntime.startSpreadMs,frameJitterMs:[...replayRuntime.frameJitterMs]});
        return;
      }
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  });
}

const gate = typeof document === 'undefined' ? null : document.querySelector('#gate');
if (gate) {
  window.vectorComparison = Object.freeze({validateDecision20Turn, validateVisibleState, validateComparisonGate, buildComparisonReplayRecord, playComparison, runtime:replayRuntime});
  const reportFiles = document.querySelector('#report-files');
  const startReplay = document.querySelector('#start-replay');
  const loadStatus = document.querySelector('#load-status');
  const errorList = document.querySelector('#preflight-errors');
  if (reportFiles && startReplay && loadStatus) {
    reportFiles.addEventListener('change', () => {
      const count = reportFiles.files?.length ?? 0;
      startReplay.disabled = count !== REQUIRED_RUNS.length;
      loadStatus.textContent = count === REQUIRED_RUNS.length
        ? '9本を選択しました。q cohort・trace・fingerprint・入力対応を検証できます。'
        : `${count} / 9本。seed 101のnative CLI reportを9本選択してください。`;
      if (errorList) errorList.replaceChildren();
    });
    startReplay.addEventListener('click', async () => {
      const files = Array.from(reportFiles.files ?? []);
      if (files.length !== REQUIRED_RUNS.length) return;
      startReplay.disabled = true;
      loadStatus.textContent = '9本のnative CLI reportを検証しています…';
      if (errorList) errorList.replaceChildren();
      try {
        const reports = await Promise.all(files.map(async file => JSON.parse(await file.text())));
        const orderedReports = [...reports].sort((left, right) => REQUIRED_RUNS.indexOf(comparisonId(left)) - REQUIRED_RUNS.indexOf(comparisonId(right)));
        const check = validateComparisonGate(orderedReports);
        if (!check.valid) {
          replayRuntime.status = 'failed';
          replayRuntime.error = check.errors.join(' | ');
          if (errorList) {
            for (const message of check.errors) {
              const item = document.createElement('li');
              item.textContent = message;
              errorList.append(item);
            }
          }
          loadStatus.textContent = `事前gate不通過。修正したnative reportを選び直してください（${check.errors.length}件）。`;
          startReplay.disabled = files.length !== REQUIRED_RUNS.length;
          return;
        }
        await playComparison(orderedReports);
        loadStatus.textContent = `q${check.questionCount}/request の9本を1×で再生しました。測定推論を同時実行した映像ではありません。`;
      } catch (error) {
        replayRuntime.status = 'failed';
        replayRuntime.error = String(error?.message ?? error);
        loadStatus.textContent = `再生gateで停止: ${replayRuntime.error}`;
        startReplay.disabled = files.length !== REQUIRED_RUNS.length;
      }
    });
  }
}
