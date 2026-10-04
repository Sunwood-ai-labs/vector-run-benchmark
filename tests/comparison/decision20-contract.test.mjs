import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_BASE_QUESTION_KEYS,
  DECISION_PROBE_KEYS,
  DECISION_QUESTION_KEYS,
  buildComparisonReplayRecord,
  validateDecision20Turn,
  validateComparisonGate
} from '../../dist/comparison/player.js';
import {Engine, VERSION, configHashFor, hash, ruleIdFor, speedAt} from '../../dist/engine.js';

const MODELS = Object.freeze({kai:'Kai',eos:'Eos',sol:'Sol',solReasoning:'SolReasoning',nox:'Nox',lux:'Lux',vega:'Vega'});
const MEASUREMENT_COMMIT = '717f02dc9852b88c253ace32f42fcb6d780ed0d3';
const MEASUREMENT_SOURCE_DIGEST = 'd7f9de9c3aaf0e22669dd54e916f9a854ea33b2339f83c183438f4c93be5357a';
const ACTION_INSTRUCTIONS = '画面は横800×縦360、地面はy=278。playerの固定boxはx=116,width=34,height=42。player.yは地面からの高さで上向きが正、vyも上向きが正。obstacles[].xは画面左端、width/heightはbox寸法です。この可視状態だけから次の操作を1つ選んでください。heldは維持されます。jump上限はstate.player.maxJumpsです（標準設定は2回）。2回目のjumpにはreleaseしてからjumpを再pressします。着地すると回数が戻ります。';

function visibleAt(engine) {
  const obstacles = engine.course.items.map(obstacle => ({
    x:obstacle.center-engine.distance-obstacle.width/2,
    width:obstacle.width,
    height:obstacle.height
  })).filter(obstacle => obstacle.x+obstacle.width>0&&obstacle.x<engine.config.worldWidth);
  return {
    schema:'vector-run-visible-state/v1',
    tick:engine.tick,
    dead:engine.dead,
    player:{y:engine.y,vy:engine.vy,held:engine.held,jumpsUsed:engine.jumpsUsed,maxJumps:engine.maxJumps,speed:speedAt(engine.seconds)},
    obstacles
  };
}

function makeQuestions(questionCount) {
  const questions = {
    action:{type:'choice',instructions:ACTION_INSTRUCTIONS,criteria:{wait:'ジャンプ入力を新しく押さず、現在のheld状態を維持する。',jump:'ジャンプ入力を押す。held中や上限到達中はゲーム規則により受理されない場合がある。',release:'ジャンプ入力を離す。'}},
    commit:{type:'noul',instructions:'選んだ操作を実行する意思の強さを数値で示してください。説明文は出力しないでください。'},
    danger:{type:'score',instructions:'この可視状態で操作を選ぶ危険度を3段階で評価してください。',criteria:['safe','caution','danger']}
  };
  if (questionCount===64) for (let index=0;index<61;index++) questions[`p${index}`]={type:'noul',instructions:`state.probes[${index}] の値はtrueですか。trueなら1、falseなら0に対応する数値で回答してください。説明文は出力しないでください。`};
  return questions;
}

function makeAnswers(questionCount, callIndex=0, choice='wait') {
  const probabilities={wait:choice==='wait'?0.8:0.1,jump:choice==='jump'?0.8:0.1,release:choice==='release'?0.8:0.1};
  const answers={
    action:{type:'choice',choice,probabilities,source:'fixture-metadata'},
    commit:{type:'noul',noul:0.5},
    danger:{type:'score',score:1}
  };
  if (questionCount===64) for (let index=0;index<61;index++) answers[`p${index}`]={type:'noul',noul:(index+callIndex)%2===0?1:0};
  return answers;
}

function makeRequest(questionCount, tick=16, callIndex=0, model='Kai') {
  const state={schema:'vector-run-visible-state/v1',tick,dead:false,player:{y:10,vy:0,held:false,jumpsUsed:0,maxJumps:2,speed:25},obstacles:[]};
  if (questionCount===64) state.probes=Array.from({length:61},(_,index)=>(index+callIndex)%2===0);
  return {model,state,questions:makeQuestions(questionCount)};
}

function makeRawResponse(questionCount, callIndex=0, choice='wait', device='cuda:0') {
  return JSON.stringify({
    model:'fixture-model',
    usage:{input_tokens:14,output_tokens:8},
    measurements:{forward_performed:true,device},
    trace_id:'fixture-response-metadata',
    answers:makeAnswers(questionCount,callIndex,choice)
  });
}

function makeProductionForwardResponse(questionCount, callIndex=0, choice='wait') {
  const response=JSON.parse(makeRawResponse(questionCount,callIndex,choice));
  response.measurements={
    neural_forward_calls:1,
    neural_forward_batches:[{input_ids_shape:[questionCount,128],batch_size:questionCount,padded_tokens_per_question:128}]
  };
  return JSON.stringify(response);
}

function localAnswers(questionCount, localIndex=0, choice='wait') {
  const probabilities={wait:choice==='wait'?1:0,jump:choice==='jump'?1:0,release:choice==='release'?1:0};
  const answers={action:{choice,probabilities},commit:{noul:1},danger:{score:0}};
  if (questionCount===64) for(let index=0;index<61;index++) answers[`p${index}`]={noul:(index+localIndex)%2===0?1:0};
  return answers;
}

function makeRun(kind, questionCount, modelName='Kai', firstAction='wait') {
  const engine=new Engine(101,2);
  const initialState=visibleAt(engine);
  const frameSnapshots=[];
  const actions=[];
  const inputLogs=[];
  const decisions=[];
  const skips=[];
  let remoteIndex=0;
  let localIndex=0;
  function recordOpportunity(tick) {
    const decisionId=`101-${decisions.length+1}`;
    const row={decisionId,questionCount,dispatchTick:tick,completionTick:null,applicationTick:null,latencyMs:null,rawRequest:null,rawRequestBody:null,rawResponse:null,rawProbabilities:null,answers:null,action:null,lateReply:false,applied:false,status:'pending'};
    decisions.push(row);
    if(kind==='idle') {
      row.status='idle_no_action';
      skips.push({tick,decisionId,reason:'idle_baseline'});
      return;
    }
    if(kind==='rule') {
      const answers=localAnswers(questionCount,localIndex++);
      row.answers=answers;
      row.rawProbabilities=answers.action.probabilities;
      row.action=answers.action.choice;
      row.completionTick=tick;
      row.latencyMs=0;
      row.status='answered';
      row.applicationTick=tick+1;
      row.applied=true;
      row.accepted=null;
      actions.push({tick,applicationTick:tick+1,action:'wait',accepted:null,decisionId});
      return;
    }
    const callIndex=remoteIndex++;
    const request=makeRequest(questionCount,tick,callIndex,modelName);
    const choice=callIndex===0?firstAction:'wait';
    const rawResponse=makeRawResponse(questionCount,callIndex,choice);
    const answers=JSON.parse(rawResponse).answers;
    row.rawRequest=request;
    row.rawRequestBody=JSON.stringify(request);
    row.rawResponse=rawResponse;
    row.rawProbabilities=answers.action.probabilities;
    row.answers=answers;
    row.action=choice;
    row.completionTick=tick;
    row.applicationTick=tick+1;
    row.latencyMs=0;
    row.status='answered';
    row.applied=true;
    const event=choice==='wait'?null:engine.input(choice);
    row.accepted=event?.accepted??null;
    if(event) inputLogs.push({...event,applicationTick:event.tick+1,decisionId});
    actions.push({tick:tick,applicationTick:tick+1,action:choice,accepted:row.accepted,decisionId});
  }
  while(!engine.dead) {
    engine.step();
    frameSnapshots.push({tick:engine.tick,state:visibleAt(engine)});
    if(engine.dead) break;
    if(engine.tick%16===0) recordOpportunity(engine.tick);
  }
  return {
    seed:101,maxJumps:2,questionCount,agent:kind,model:kind==='remote'?'Kai':kind==='rule'?'rule-visible-v1':'idle-v1',
    initialState,actions,inputLogs,frameSnapshots,decisions,skips,latencies:[],runtimeGameInvalidErrors:[],responseErrors:[],
    terminalStatus:'collision',endReason:'collision',finalTick:engine.tick,finalSnapshotHash:hash(JSON.stringify(engine.snapshot())),traceEnabled:true,
    censored:false,distanceWorld:engine.distance,distanceMetres:engine.distance/10,survivalSeconds:engine.seconds,wallSeconds:engine.seconds,jumps:engine.jumps,
    collision:engine.collision,finalState:visibleAt(engine),valid:true,eligibleForSummary:true
  };
}

function makeReport(id, questionCount=3, firstAction='wait') {
  const kind=id==='rule'||id==='idle'?id:'remote';
  const model=kind==='remote'?MODELS[id]:kind==='rule'?'rule-visible-v1':'idle-v1';
  const hardware=kind==='remote'?{gpu:'NVIDIA fixture GPU',gpuAlias:'fixture-gpu'}:null;
  const run=makeRun(kind,questionCount,model,firstAction);
  return {
    schema:'vector-run-decision-bench/v1',createdAt:'2026-10-05T00:00:00.000Z',
    game:{repo:'https://github.com/Sunwood-ai-labs/vector-run-benchmark',commit:MEASUREMENT_COMMIT,sourceDigest:MEASUREMENT_SOURCE_DIGEST,engineVersion:VERSION,configHash:configHashFor(2),ruleId:ruleIdFor(2),observationPipeline:'structured-visible-state-v1'},
    variant:{id:'decision-realtime-censored-v1',physicsHz:120,playbackRate:'1x realtime',questionCount,questionCountMeaning:'number of questions in one SystemOne request',systemOneQuestionCount:questionCount,dispatchEveryTicks:16,oneOutstanding:true,maxSeconds:30,terminationCap:'time_limit_censored',maxJumps:2,frameGapPolicy:'gap over 100ms invalidates; no catch-up ticks discarded',trace:true},
    agent:{kind,model,url:kind==='remote'?'http://127.0.0.1:8780/v1/systemone':null},
    model:{id:model},hardware,gameCommit:{commit:'c'.repeat(40)},metadata:{model:{id:model},hardware,gameCommit:{commit:'c'.repeat(40)}},
    episodes:[{seed:101,terminalStatus:'collision',endReason:'collision',valid:true,eligibleForSummary:true,finalTick:run.finalTick,finalSnapshotHash:run.finalSnapshotHash}],
    runs:[run],runtimeGameInvalidErrors:[]
  };
}

function makeReports(questionCount=3) {
  return [...Object.keys(MODELS),'rule','idle'].map(id=>makeReport(id,questionCount));
}

test('q3 is exactly three questions per request and omits state.probes',()=>{
  assert.deepEqual(DECISION_BASE_QUESTION_KEYS,['action','commit','danger']);
  assert.deepEqual(DECISION_QUESTION_KEYS[3],['action','commit','danger']);
  const request=makeRequest(3);
  const raw=makeRawResponse(3);
  const result=validateDecision20Turn(request,raw);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.questionCount,3);
  assert.equal(result.action,'wait');
  assert.equal(Object.hasOwn(request.state,'probes'),false);
  assert.deepEqual(Object.keys(request.questions).sort(),['action','commit','danger']);
});

test('q64 adds the 61 explicit synthetic probe questions and asks whether each value is true',()=>{
  assert.equal(DECISION_PROBE_KEYS.length,61);
  assert.equal(DECISION_QUESTION_KEYS[64].length,64);
  assert.equal(DECISION_QUESTION_KEYS[64].at(-1),'p60');
  const request=makeRequest(64,16,1);
  const result=validateDecision20Turn(request,makeRawResponse(64,1));
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(request.state.probes.length,61);
  assert.ok(request.state.probes.every(value=>typeof value==='boolean'));
  assert.match(request.questions.p0.instructions,/値はtrueですか。trueなら1、falseなら0/);
});

test('visible state is q-series-specific and geometry instructions match the API prompt',()=>{
  const q3=makeRequest(3);
  q3.state.probes=[];
  assert.equal(validateDecision20Turn(q3,makeRawResponse(3)).valid,false);
  const q64=makeRequest(64);
  q64.state.probes[8]='true';
  assert.equal(validateDecision20Turn(q64,makeRawResponse(64)).valid,false);
  const changedGeometry=makeRequest(3);
  changedGeometry.questions.action.instructions=changedGeometry.questions.action.instructions.replace('groundY','groundY');
  changedGeometry.questions.action.instructions=changedGeometry.questions.action.instructions.replace('地面はy=278','地面はy=279');
  assert.equal(validateDecision20Turn(changedGeometry,makeRawResponse(3)).valid,false);
});

test('raw SystemOne response string and metadata are retained while required answer fields are validated',()=>{
  const request=makeRequest(3);
  const raw=makeRawResponse(3);
  const before=raw;
  const result=validateDecision20Turn(request,raw);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(raw,before);
  const missing=JSON.parse(raw);
  delete missing.answers.danger;
  const invalid=validateDecision20Turn(request,JSON.stringify(missing));
  assert.equal(invalid.valid,false);
  assert.equal(invalid.action,null);
  const rationale=JSON.parse(raw);
  rationale.answers.action.rationale='safe';
  assert.equal(validateDecision20Turn(request,JSON.stringify(rationale)).valid,false);
  for(const questionCount of [3,64]) {
    const extraQuestion=JSON.parse(makeRawResponse(questionCount));
    extraQuestion.answers.unrequested={noul:1};
    const extraResult=validateDecision20Turn(makeRequest(questionCount),JSON.stringify(extraQuestion));
    assert.equal(extraResult.valid,false,`q${questionCount} must reject extra response question keys`);
    assert.ok(extraResult.errors.some(error=>error.includes('answers keys must exactly match')));
  }
});

test('native CLI reports with remote, rule, and idle decision rows pass as one homogeneous q3 cohort',()=>{
  const reports=makeReports(3);
  const result=validateComparisonGate(reports);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.questionCount,3);
  assert.equal(validateComparisonGate(makeReports(64)).valid,true);
});

test('each report is pinned to the frozen measurement commit and source digest',()=>{
  const badCommit=makeReports(3);
  badCommit[2].game.commit='edaa900890c4c5aef982389fc4f0b495d4afb818';
  assert.ok(validateComparisonGate(badCommit).errors.some(error=>error.includes('game commit does not match frozen measurementCommit')));
  const badDigest=makeReports(3);
  badDigest[6].game.sourceDigest='f93c24025da7786a54f5db2ada60ca1fb5a055ce4e165d17d82cd5477e362384';
  assert.ok(validateComparisonGate(badDigest).errors.some(error=>error.includes('sourceDigest does not match frozen measurement source')));
});

test('native CLI gate rejects mixed request sizes, missing opportunities, bad cadence, and legacy tick equality',()=>{
  const mixed=makeReports(3);
  mixed[0]=makeReport('kai',64);
  assert.equal(validateComparisonGate(mixed).valid,false);

  const missingOpportunity=makeReports(3);
  missingOpportunity[0].runs[0].decisions.splice(1,1);
  assert.ok(validateComparisonGate(missingOpportunity).errors.some(error=>error.includes('every CLI opportunity')));

  const badCadence=makeReports(3);
  badCadence[0].runs[0].decisions[1].dispatchTick=17;
  assert.equal(validateComparisonGate(badCadence).valid,false);

  const badTick=makeReports(3);
  const input={tick:3,applicationTick:3,action:'jump',accepted:true,decisionId:'101-input'};
  badTick[0].runs[0].inputLogs.push(input);
  assert.ok(validateComparisonGate(badTick).errors.some(error=>error.includes('applicationTick=N+1')));
});

test('skipped remote opportunities and local controls preserve actual CLI rows and skips',()=>{
  const reports=makeReports(3);
  const remote=reports[0].runs[0];
  const first=remote.decisions[0];
  first.completionTick=33;
  first.applicationTick=34;
  remote.actions[0].tick=33;
  remote.actions[0].applicationTick=34;
  const skipped=remote.decisions[1];
  Object.assign(skipped,{completionTick:null,applicationTick:null,rawRequest:null,rawRequestBody:null,rawResponse:null,rawProbabilities:null,answers:null,action:null,status:'skipped_outstanding'});
  remote.actions.splice(1,1);
  remote.skips.push({tick:skipped.dispatchTick,decisionId:skipped.decisionId,reason:'request_outstanding'});
  const result=validateComparisonGate(reports);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.ok(reports[7].runs[0].decisions.length>0,'rule local decisions are retained');
  assert.ok(reports[8].runs[0].decisions.every(row=>row.status==='idle_no_action'),'idle decision rows are retained');
  assert.equal(reports[8].runs[0].skips.length,reports[8].runs[0].decisions.length);
});

test('decision, action, and input rows have bijective IDs with wait-only actions and physical input pairs',()=>{
  const physical=makeReports(3);
  physical[0]=makeReport('kai',3,'jump');
  const physicalRun=physical[0].runs[0];
  assert.equal(validateComparisonGate(physical).valid,true,JSON.stringify(validateComparisonGate(physical).errors));
  const replay=buildComparisonReplayRecord(physicalRun);
  assert.equal(replay.valid,true,JSON.stringify(replay.errors));
  assert.equal(physicalRun.actions[0].action,'jump');
  assert.equal(physicalRun.inputLogs.length,1);

  const duplicateAction=structuredClone(physical);
  duplicateAction[0].runs[0].actions.push({...duplicateAction[0].runs[0].actions[0]});
  assert.ok(validateComparisonGate(duplicateAction).errors.some(error=>error.includes('actions contains duplicate decisionId')));

  const orphanAction=structuredClone(physical);
  const orphanActionRun=orphanAction[0].runs[0];
  orphanActionRun.actions.push({tick:orphanActionRun.finalTick-1,applicationTick:orphanActionRun.finalTick,action:'wait',accepted:null,decisionId:'orphan-action'});
  assert.ok(validateComparisonGate(orphanAction).errors.some(error=>error.includes('actions contains orphan decisionId')));

  const missingInput=structuredClone(physical);
  missingInput[0].runs[0].inputLogs=[];
  assert.ok(validateComparisonGate(missingInput).errors.some(error=>error.includes('must link to exactly one inputLogs row')));

  const duplicateInput=structuredClone(physical);
  duplicateInput[0].runs[0].inputLogs.push({...duplicateInput[0].runs[0].inputLogs[0]});
  assert.ok(validateComparisonGate(duplicateInput).errors.some(error=>error.includes('inputLogs contains duplicate decisionId')));

  const orphanInput=structuredClone(physical);
  orphanInput[0].runs[0].inputLogs.push({tick:32,applicationTick:33,action:'release',accepted:false,decisionId:'orphan-input'});
  assert.ok(validateComparisonGate(orphanInput).errors.some(error=>error.includes('inputLogs contains orphan decisionId')));

  const waitWithInput=makeReports(3);
  waitWithInput[0].runs[0].inputLogs.push({tick:16,applicationTick:17,action:'jump',accepted:true,decisionId:'101-1'});
  assert.ok(validateComparisonGate(waitWithInput).errors.some(error=>error.includes('wait decision 101-1 must not have an inputLogs row')));

  const duplicateDecision=structuredClone(physical);
  duplicateDecision[0].runs[0].decisions[1].decisionId=duplicateDecision[0].runs[0].decisions[0].decisionId;
  assert.ok(validateComparisonGate(duplicateDecision).errors.some(error=>error.includes('decisions contains duplicate decisionId')));
});

test('late reply is measured only with production forward-hook evidence; CPU flags and hardware labels are insufficient',()=>{
  const reports=makeReports(3);
  const report=reports[0];
  const run=report.runs[0];
  const [late,...rest]=run.decisions;
  Object.assign(late,{lateReply:true,status:'late_answer_not_applied',completionTick:null,applicationTick:null,applied:false});
  run.decisions=[late,...rest.map(row=>({...row,completionTick:null,applicationTick:null,rawRequest:null,rawRequestBody:null,rawResponse:null,rawProbabilities:null,answers:null,action:null,status:'skipped_outstanding'}))];
  run.actions=[];
  run.skips=run.decisions.slice(1).map(row=>({tick:row.dispatchTick,decisionId:row.decisionId,reason:'request_outstanding'}));
  const cpuOnly=validateComparisonGate(reports);
  assert.equal(cpuOnly.valid,false,'forward_performed/device plus report hardware labels do not prove production backend execution');
  assert.ok(cpuOnly.errors.some(error=>error.includes('neural_forward_calls evidence is missing')));

  const productionHook=structuredClone(reports);
  productionHook[0].runs[0].decisions[0].rawResponse=makeProductionForwardResponse(3,0,'wait');
  assert.equal(validateComparisonGate(productionHook).valid,true,JSON.stringify(validateComparisonGate(productionHook).errors));

  const malformedHook=structuredClone(productionHook);
  const malformed=JSON.parse(malformedHook[0].runs[0].decisions[0].rawResponse);
  malformed.measurements.neural_forward_batches[0].input_ids_shape=[0,128];
  malformedHook[0].runs[0].decisions[0].rawResponse=JSON.stringify(malformed);
  assert.ok(validateComparisonGate(malformedHook).errors.some(error=>error.includes('valid input_ids shape')));

  const hookWithoutGpuIdentity=structuredClone(productionHook);
  hookWithoutGpuIdentity[0].hardware={cpu:'CPU-only label'};
  assert.ok(validateComparisonGate(hookWithoutGpuIdentity).errors.some(error=>error.includes('no GPU identity label')));

  const unmeasured=structuredClone(reports);
  unmeasured[0].hardware={gpu:'CPU fixture'};
  unmeasured[0].runs[0].decisions[0].rawResponse=makeRawResponse(3,0,'wait','cpu-fixture');
  assert.ok(validateComparisonGate(unmeasured).errors.some(error=>error.includes('cannot be labeled measured no-response')));
  const missingLate=structuredClone(reports);
  missingLate[0].runs[0].decisions[0].rawResponse=null;
  assert.equal(validateComparisonGate(missingLate).valid,false);
});

test('time_limit requires 30 seconds at tick 3600 and stays censored',()=>{
  const reports=makeReports(3);
  const run=reports[0].runs[0];
  run.terminalStatus='time_limit';
  run.endReason='time_limit';
  run.censored=true;
  run.finalTick=3599;
  const result=validateComparisonGate(reports);
  assert.ok(result.errors.some(error=>error.includes('right-censored at tick 3600')));
});

test('canonical replay combines tick-0 initialState and tick-1 frames, applying input tick N before step N to N+1',()=>{
  const engine=new Engine(101,2);
  const initialState=visibleAt(engine);
  const inputLogs=[];
  const frameSnapshots=[];
  const firstEvent=engine.input('jump');
  inputLogs.push({...firstEvent,applicationTick:firstEvent.tick+1,source:'agent',decisionId:'101-1'});
  while(!engine.dead) {
    engine.step();
    frameSnapshots.push({tick:engine.tick,state:visibleAt(engine)});
  }
  const run={seed:101,maxJumps:2,initialState,inputLogs,frameSnapshots,finalTick:engine.tick,finalSnapshotHash:hash(JSON.stringify(engine.snapshot())),terminalStatus:'collision',endReason:'collision',censored:false};
  const valid=buildComparisonReplayRecord(run);
  assert.equal(valid.valid,true,JSON.stringify(valid.errors));
  assert.equal(valid.record.inputs[0].tick,0,'replay keeps the legacy event tick');
  assert.equal(valid.record.endReason,'collision');
  const corrupted=structuredClone(run);
  corrupted.frameSnapshots[12].state.player.y+=1;
  assert.equal(buildComparisonReplayRecord(corrupted).valid,false);
  const badApplication=structuredClone(run);
  badApplication.inputLogs[0].applicationTick=badApplication.inputLogs[0].tick;
  assert.equal(buildComparisonReplayRecord(badApplication).valid,false);
});
