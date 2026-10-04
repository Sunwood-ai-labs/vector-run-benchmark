import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engine, VERSION, configHashFor, hash, replayRecord, ruleIdFor, visibleObservation} from '../dist/engine.js';
import {OBSERVATION_PIPELINE, RESULT_SCHEMA, buildSystemOneRequest, parseSystemOneResponse} from './decision-bench.mjs';

const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const questionKeys=count=>['action','commit','danger',...(count===64?Array.from({length:61},(_,i)=>`p${i}`):[])];
const fail=message=>{throw new Error(message);};

function validateInputs(run){
  if(!Array.isArray(run.inputLogs))fail('inputLogs must be an array');
  let lastApplicationTick=0;
  for(const input of run.inputLogs){
    if(!isRecord(input)||!Number.isInteger(input.tick)||!Number.isInteger(input.applicationTick)||input.applicationTick!==input.tick+1||input.applicationTick<1||input.applicationTick>run.finalTick||!['jump','release'].includes(input.action)||typeof input.accepted!=='boolean')fail('invalid input log');
    if(input.applicationTick<lastApplicationTick)fail('input logs are out of order');
    lastApplicationTick=input.applicationTick;
  }
}

function validateActionsAndSkips(run){
  if(!Array.isArray(run.actions)||!Array.isArray(run.decisions)||!Array.isArray(run.skips))fail('actions, decisions, and skips must be arrays');
  const inputByDecision=new Map(run.inputLogs.map(row=>[row.decisionId,row]));
  const actionByDecision=new Map();
  for(const row of run.actions){
    if(!isRecord(row)||!Number.isInteger(row.tick)||!Number.isInteger(row.applicationTick)||row.applicationTick!==row.tick+1||row.applicationTick>run.finalTick||!['wait','jump','release'].includes(row.action)||typeof row.decisionId!=='string')fail('invalid action row');
    if(actionByDecision.has(row.decisionId))fail('duplicate applied action decision');
    actionByDecision.set(row.decisionId,row);
    const input=inputByDecision.get(row.decisionId);
    if(row.action==='wait'){
      if(row.accepted!==null||input)fail('wait must be a no-op and absent from physical inputLogs');
    }else if(!input||input.action!==row.action||input.tick!==row.tick||input.applicationTick!==row.applicationTick||input.accepted!==row.accepted)fail('physical action does not match inputLogs');
  }
  for(const input of run.inputLogs)if(!actionByDecision.has(input.decisionId))fail('physical input has no action row');
  const decisionById=new Map(run.decisions.map(row=>[row.decisionId,row]));
  for(const row of run.decisions){
    if(!isRecord(row)||!Number.isInteger(row.dispatchTick)||row.dispatchTick%16!==0||row.questionCount!==run.questionCount)fail('invalid decision opportunity row');
    if(['skipped_outstanding','idle_no_action'].includes(row.status)&&row.applicationTick!==null)fail('skipped/no-action decision cannot be applied');
    const action=actionByDecision.get(row.decisionId);
    if(action&&(row.applicationTick!==action.applicationTick||row.action!==action.action||row.applied!==true))fail('decision row does not match its applied action');
    if(!action&&row.applied===true)fail('decision is marked applied without an action row');
  }
  for(const skip of run.skips){
    if(!isRecord(skip)||!Number.isInteger(skip.tick)||skip.tick%16!==0||typeof skip.decisionId!=='string'||!['request_outstanding','idle_baseline'].includes(skip.reason))fail('invalid skip row');
    const decision=decisionById.get(skip.decisionId);
    if(!decision||decision.dispatchTick!==skip.tick)fail('skip row has no matching decision opportunity');
    if(skip.reason==='request_outstanding'&&decision.status!=='skipped_outstanding')fail('outstanding skip status mismatch');
    if(skip.reason==='idle_baseline'&&decision.status!=='idle_no_action')fail('idle skip status mismatch');
  }
  for(const decision of run.decisions){
    const shouldSkip=decision.status==='skipped_outstanding'||decision.status==='idle_no_action';
    if(shouldSkip&&!run.skips.some(skip=>skip.decisionId===decision.decisionId))fail('decision skip is missing from skips');
  }
}

function replayAndCheckVisibleFrames(run){
  validateInputs(run);
  const engine=new Engine(run.seed,run.maxJumps),snapshots=run.frameSnapshots;
  if(!run.traceEnabled||!Array.isArray(snapshots))fail('trace snapshots are required');
  if(JSON.stringify(visibleObservation(engine))!==JSON.stringify(run.initialState))fail('initial visible state mismatch');
  if(snapshots.length!==run.finalTick)fail('trace must contain one visible snapshot per physics tick');
  let inputIndex=0;
  for(let targetTick=1;targetTick<=run.finalTick;targetTick++){
    while(inputIndex<run.inputLogs.length&&run.inputLogs[inputIndex].applicationTick===targetTick){
      const input=run.inputLogs[inputIndex],event=engine.input(input.action);
      if(event.accepted!==input.accepted)fail(`input acceptance mismatch at application tick ${targetTick}`);
      inputIndex++;
    }
    if(engine.dead)fail(`trace continues after collision at tick ${engine.tick}`);
    engine.step();
    const frame=snapshots[targetTick-1];
    if(frame?.tick!==targetTick||JSON.stringify(frame.state)!==JSON.stringify(visibleObservation(engine)))fail(`visible snapshot mismatch at tick ${targetTick}`);
  }
  if(inputIndex!==run.inputLogs.length)fail('unreplayed input log entries remain');
  if(hash(JSON.stringify(engine.snapshot()))!==run.finalSnapshotHash)fail('final engine snapshot fingerprint mismatch');
  return engine;
}

export function verifyCollisionRun(run,game){
  if(run.endReason!=='collision'||run.terminalStatus!=='collision'||!run.finalSnapshotHash)fail('collision run terminal fields are invalid');
  const record={version:game.engineVersion,maxJumps:run.maxJumps,ruleId:ruleIdFor(run.maxJumps),configHash:configHashFor(run.maxJumps),seed:run.seed,finalTick:run.finalTick,inputs:run.inputLogs,endReason:'collision',distanceWorld:run.distanceWorld,jumps:run.jumps,finalStateHash:run.finalSnapshotHash};
  const checked=replayRecord(record);if(!checked.matched)fail('existing collision replayRecord did not match');
  const engine=replayAndCheckVisibleFrames(run);if(!engine.dead||engine.tick!==run.finalTick)fail('collision is not the final physics state');
  return{kind:'collision',matched:true,finalTick:engine.tick};
}

export function verifyCensoredTrace(run){
  if(run.endReason!=='time_limit'||run.terminalStatus!=='time_limit'||run.censored!==true||!run.finalSnapshotHash)fail('censored trace terminal fields are invalid');
  const engine=replayAndCheckVisibleFrames(run);
  if(engine.dead)fail('time_limit trace ended in collision');
  return{kind:'censored',matched:true,finalTick:engine.tick};
}

function verifyRemoteDecisions(report,run){
  if(run.agent!=='remote')return;
  let callIndex=0;
  const states=new Map([[0,run.initialState],...run.frameSnapshots.map(frame=>[frame.tick,frame.state])]);
  for(const decision of run.decisions){
    if(decision.rawRequest===null){if(['pending','awaiting_late_reply'].includes(decision.status))fail('unresolved SystemOne request');continue;}
    const request=decision.rawRequest;
    if(!isRecord(request)||JSON.stringify(Object.keys(request).sort())!==JSON.stringify(['model','questions','state']))fail('rawRequest must contain only model, state, questions');
    if(request.model!==report.agent.model)fail('raw request model does not match report agent');
    if(JSON.stringify(Object.keys(request.questions))!==JSON.stringify(questionKeys(report.variant.questionCount)))fail('raw request question keys do not match q3/q64');
    const sourceState=states.get(decision.dispatchTick);if(!sourceState)fail(`missing visible dispatch state at tick ${decision.dispatchTick}`);
    const baseState=structuredClone(request.state);if(report.variant.questionCount===64)delete baseState.probes;
    const expected=buildSystemOneRequest({model:request.model,state:sourceState,questionCount:report.variant.questionCount,callIndex});
    if(JSON.stringify(expected)!==JSON.stringify(request))fail(`raw request state/questions mismatch at dispatch tick ${decision.dispatchTick}`);
    if(JSON.stringify(JSON.parse(decision.rawRequestBody))!==JSON.stringify(request))fail('raw request body does not match rawRequest object');
    callIndex++;
    if(typeof decision.rawResponse==='string'){
      const answers=parseSystemOneResponse(decision.rawResponse,report.variant.questionCount);
      if(JSON.stringify(answers)!==JSON.stringify(decision.answers))fail('parsed answers do not match raw response');
      if(JSON.stringify(answers.action.probabilities)!==JSON.stringify(decision.rawProbabilities))fail('raw action probabilities were not retained');
    }else if(!decision.error)fail('remote request has no raw response or error');
    if(decision.status==='invalid_response'||decision.status==='late_invalid_response'||decision.status==='transport_error'||decision.status==='late_transport_error'||decision.status==='http_error'||decision.status==='late_http_error')fail(`invalid SystemOne response: ${decision.status}`);
    if(decision.lateReply&&decision.applicationTick!==null)fail('late response must not be applied');
  }
  for(const input of run.inputLogs){
    if(input.source!=='agent')continue;
    const decision=run.decisions.find(item=>item.decisionId===input.decisionId);
    if(!decision||decision.action!==input.action||decision.applicationTick!==input.applicationTick||decision.accepted!==input.accepted)fail('applied input does not match its SystemOne decision');
  }
}

export function verifyReport(report){
  if(report?.schema!==RESULT_SCHEMA||report.game?.observationPipeline!==OBSERVATION_PIPELINE||report.game?.engineVersion!==VERSION)fail('unsupported decision bench schema or game version');
  if(typeof report.game.commit!=='string'||!report.game.commit||!/^[0-9a-f]{40}$/i.test(report.game.commit))fail('game commit provenance is missing');
  if(typeof report.game.sourceDigest!=='string'||!/^[0-9a-f]{64}$/i.test(report.game.sourceDigest))fail('game source digest is missing');
  if(![3,64].includes(report.variant?.questionCount)||report.variant.systemOneQuestionCount!==report.variant.questionCount)fail('questionCount must identify one homogeneous q3/q64 series');
  if(report.variant.dispatchEveryTicks!==16||report.variant.oneOutstanding!==true||report.variant.physicsHz!==120||report.variant.maxSeconds!==30)fail('realtime dispatch/horizon contract mismatch');
  if(report.variant.trace!==true)fail('trace output is required for deterministic video validation');
  if(!Array.isArray(report.runs)||report.runs.length===0)fail('runs are required');
  if(!Array.isArray(report.runtimeGameInvalidErrors)||report.runtimeGameInvalidErrors.length)fail('runtime game invalid errors are present');
  const results=[];
  for(const run of report.runs){
    if(run.questionCount!==report.variant.questionCount)fail('run questionCount is not homogeneous');
    if(run.runtimeGameInvalidErrors?.length||run.responseErrors?.length)fail(`run ${run.seed} contains errors`);
    validateActionsAndSkips(run);
    verifyRemoteDecisions(report,run);
    if(run.endReason==='collision')results.push(verifyCollisionRun(run,report.game));
    else if(run.endReason==='time_limit')results.push(verifyCensoredTrace(run));
    else fail(`unsupported terminal reason: ${run.endReason}`);
    if(run.endReason==='collision'&&!run.valid)fail(`collision run ${run.seed} is marked invalid`);
  }
  return{questionCount:report.variant.questionCount,runs:results};
}

async function main(){
  const files=process.argv.slice(2);if(!files.length)throw new Error('Usage: node scripts/verify-decision-trace.mjs RESULT.json [RESULT.json ...]');
  const reports=[];
  for(const file of files){const report=JSON.parse(await readFile(file,'utf8'));reports.push({file:path.resolve(file),report,result:verifyReport(report)});}
  const counts=new Set(reports.map(item=>item.result.questionCount));if(counts.size!==1)throw new Error('mixed q3/q64 result series are not accepted');
  process.stdout.write(`${JSON.stringify({valid:true,questionCount:reports[0].result.questionCount,reports:reports.map(({file,result})=>({file,runs:result.runs.length,terminals:result.runs.map(run=>run.kind)}))},null,2)}\n`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
