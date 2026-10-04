import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG, Engine, RealtimeClock, VERSION, configForRule, configHashFor, hash, ruleIdFor, speedAt, visibleObservation} from '../dist/engine.js';

export const GAME_REPO='https://github.com/Sunwood-ai-labs/vector-run-benchmark';
export const OBSERVATION_PIPELINE='structured-visible-state-v1';
export const REQUEST_SCHEMA='vector-run-decision-request/v1';
export const RESULT_SCHEMA='vector-run-decision-bench/v1';
export const DEFAULT_URL='http://127.0.0.1:8780/v1/systemone';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const PROBE_COUNT=61;
const ACTIONS=['wait','jump','release'];
const PLAYER_RIGHT=CONFIG.playerX+CONFIG.playerWidth;
const SOURCE_FILES=['dist/engine.js','dist/app.js','scripts/decision-bench.mjs','scripts/verify-decision-trace.mjs'];

const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameKeys=(value,keys)=>isRecord(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const questionKeys=count=>['action','commit','danger',...(count===64?Array.from({length:PROBE_COUNT},(_,i)=>`p${i}`):[])];

export function buildQuestions(questionCount,callIndex=0){
  if(![3,64].includes(questionCount))throw new Error('--questions must be 3 or 64');
  const questions={
    action:{type:'choice',instructions:'画面は横800×縦360、地面はy=278。playerの固定boxはx=116,width=34,height=42。player.yは地面からの高さで上向きが正、vyも上向きが正。obstacles[].xは画面左端、width/heightはbox寸法です。この可視状態だけから次の操作を1つ選んでください。heldは維持されます。jump上限はstate.player.maxJumpsです（標準設定は2回）。2回目のjumpにはreleaseしてからjumpを再pressします。着地すると回数が戻ります。',criteria:{wait:'ジャンプ入力を新しく押さず、現在のheld状態を維持する。',jump:'ジャンプ入力を押す。held中や上限到達中は受理されない場合があります。',release:'ジャンプ入力を離す。'}},
    commit:{type:'noul',instructions:'選んだ操作を実行する意思の強さを数値で示してください。説明文は出力しないでください。'},
    danger:{type:'score',instructions:'この可視状態で操作を選ぶ危険度を3段階で評価してください。',criteria:['safe','caution','danger']}
  };
  if(questionCount===64){
    for(let i=0;i<PROBE_COUNT;i++)questions[`p${i}`]={type:'noul',instructions:`state.probes[${i}] の値はtrueですか。trueなら1、falseなら0に対応する数値で回答してください。説明文は出力しないでください。`};
  }
  return questions;
}

export function buildSystemOneRequest({model,state,questionCount=64,callIndex=0}){
  if(typeof model!=='string'||!model.trim())throw new Error('--model is required for remote agent');
  if(!Number.isInteger(callIndex)||callIndex<0)throw new Error('callIndex must be a non-negative integer');
  if(!isRecord(state)||state.schema!=='vector-run-visible-state/v1'||!Number.isInteger(state.tick)||typeof state.dead!=='boolean'||!isRecord(state.player)||!Array.isArray(state.obstacles))throw new Error('state is not a visible VECTOR RUN observation');
  const player={};
  for(const key of ['y','vy','speed']){if(typeof state.player[key]!=='number'||!Number.isFinite(state.player[key]))throw new Error(`state.player.${key} must be finite`);player[key]=state.player[key];}
  if(typeof state.player.held!=='boolean')throw new Error('state.player.held must be boolean');player.held=state.player.held;
  for(const key of ['jumpsUsed','maxJumps']){if(!Number.isInteger(state.player[key]))throw new Error(`state.player.${key} must be an integer`);player[key]=state.player[key];}
  const obstacles=state.obstacles.map((obstacle,index)=>{if(!isRecord(obstacle))throw new Error(`state.obstacles[${index}] must be an object`);for(const key of ['x','width','height'])if(typeof obstacle[key]!=='number'||!Number.isFinite(obstacle[key]))throw new Error(`state.obstacles[${index}].${key} must be finite`);return{x:obstacle.x,width:obstacle.width,height:obstacle.height};});
  const visible={schema:'vector-run-visible-state/v1',tick:state.tick,dead:state.dead,player,obstacles};
  if(questionCount===64)visible.probes=Array.from({length:PROBE_COUNT},(_,i)=>(i+callIndex)%2===0);
  return{model,state:visible,questions:buildQuestions(questionCount,callIndex)};
}

export function parseSystemOneResponse(rawBody,questionCount){
  if(![3,64].includes(questionCount))throw new Error('questionCount must be 3 or 64');
  const response=typeof rawBody==='string'?JSON.parse(rawBody):rawBody;
  if(!isRecord(response)||!isRecord(response.answers))throw new Error('response must contain an answers object');
  const rejectGeneratedText=(value,path='response')=>{if(!isRecord(value)&&!Array.isArray(value))return;for(const [key,item]of Object.entries(value)){if(['text','rationale','generated_text'].includes(key.toLowerCase()))throw new Error(`${path}.${key} is not allowed`);rejectGeneratedText(item,`${path}.${key}`);}};
  rejectGeneratedText(response);
  const expected=questionKeys(questionCount),answers=response.answers;
  if(!isRecord(answers)||expected.some(key=>!Object.hasOwn(answers,key))||Object.keys(answers).some(key=>!expected.includes(key)))throw new Error(`answers must contain exactly the ${expected.length} requested question fields`);
  const action=answers.action;
  if(!isRecord(action)||!ACTIONS.includes(action.choice)||!isRecord(action.probabilities)||(action.type!==undefined&&action.type!=='choice'))throw new Error('answers.action is malformed');
  for(const value of Object.values(action.probabilities))if(typeof value!=='number'||!Number.isFinite(value))throw new Error('action probabilities must be finite numbers');
  if(!isRecord(answers.commit)||typeof answers.commit.noul!=='number'||!Number.isFinite(answers.commit.noul)||(answers.commit.type!==undefined&&answers.commit.type!=='noul'))throw new Error('answers.commit is malformed');
  if(!isRecord(answers.danger)||typeof answers.danger.score!=='number'||!Number.isFinite(answers.danger.score)||(answers.danger.type!==undefined&&answers.danger.type!=='score'))throw new Error('answers.danger is malformed');
  for(let i=0;i<PROBE_COUNT&&questionCount===64;i++){const answer=answers[`p${i}`];if(!isRecord(answer)||typeof answer.noul!=='number'||!Number.isFinite(answer.noul)||(answer.type!==undefined&&answer.type!=='noul'))throw new Error(`answers.p${i} is malformed`);}
  return structuredClone(answers);
}

function localAnswers(state,action,questionCount){
  const probabilities=Object.fromEntries(ACTIONS.map(name=>[name,name===action?1:0]));
  const answers={action:{choice:action,probabilities},commit:{noul:1},danger:{score:0}};
  if(questionCount===64)for(let i=0;i<PROBE_COUNT;i++)answers[`p${i}`]={noul:state.probes[i]?1:0};
  return answers;
}

function chooseRuleAction(state){
  if(state.player.held)return'release';
  const obstacle=state.obstacles.find(item=>item.x+item.width>CONFIG.playerX);
  if(!obstacle)return'wait';
  const gap=obstacle.x-PLAYER_RIGHT;
  return gap<=145&&state.player.jumpsUsed<state.player.maxJumps?'jump':'wait';
}

function ruleDanger(state){
  const obstacle=state.obstacles.find(item=>item.x+item.width>CONFIG.playerX);
  if(!obstacle)return 0;
  const gap=obstacle.x-PLAYER_RIGHT;
  return gap<=60?2:gap<=145?1:0;
}

async function postSystemOne(url,body,signal){
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body,signal});
  return{status:response.status,body:await response.text()};
}

export async function runEpisode({seed=101,agent='idle',questionCount=3,maxSeconds=30,maxJumps=2,model=null,url=DEFAULT_URL,trace=false,metadata={},transport=postSystemOne,pollIntervalMs=1,responseTimeoutMs=60000}={}){
  if(!['remote','rule','idle'].includes(agent))throw new Error('--agent must be remote, rule, or idle');
  if(![3,64].includes(questionCount))throw new Error('--questions must be 3 or 64');
  if(!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>30||Math.floor(maxSeconds*CONFIG.hz)<1)throw new Error('--max-seconds must be positive, at most 30, and include one physics tick');
  if(agent==='remote'&&(typeof model!=='string'||!model.trim()))throw new Error('--model is required for remote agent');
  if(agent==='remote'&&typeof url!=='string')throw new Error('--url must be a string');
  const engine=new Engine(seed,maxJumps),started=performance.now(),clock=new RealtimeClock(started),maxTicks=Math.floor(maxSeconds*CONFIG.hz+1e-9);
  const run={seed,maxJumps,questionCount,agent,model:agent==='remote'?model:agent==='rule'?'rule-visible-v1':'idle-v1',initialState:visibleObservation(engine),actions:[],inputLogs:[],frameSnapshots:[],decisions:[],skips:[],latencies:[],runtimeGameInvalidErrors:[],responseErrors:[],terminalStatus:null,endReason:null,finalTick:null,finalSnapshotHash:null,traceEnabled:Boolean(trace)};
  let ended=false,pendingAction=null,outstanding=null,callIndex=0,postTerminalWaitStarted=null;
  const tasks=[];
  const elapsedMs=()=>performance.now()-started;

  function finish(reason){
    if(ended)return;
    ended=true;run.endReason=reason;run.terminalStatus=reason==='collision'?'collision':reason==='time_limit'?'time_limit':reason;
    run.censored=reason==='time_limit';run.finalTick=engine.tick;run.finalSnapshotHash=hash(JSON.stringify(engine.snapshot()));
    run.distanceWorld=engine.distance;run.distanceMetres=engine.distance/CONFIG.distanceUnitsPerMetre;run.survivalSeconds=engine.seconds;run.wallSeconds=elapsedMs()/1000;run.jumps=engine.jumps;run.collision=engine.collision;run.finalState=visibleObservation(engine);
    if(outstanding){outstanding.lateReply=true;outstanding.status='awaiting_late_reply';outstanding.applicationTick=null;postTerminalWaitStarted=performance.now();}
  }

  function applyPending(applicationTick){
    if(!pendingAction)return;
    const item=pendingAction;pendingAction=null;
    if(item.action==='wait'){
      item.decision.applicationTick=applicationTick;item.decision.applied=true;item.decision.accepted=null;
      run.actions.push({tick:engine.tick,applicationTick,action:'wait',accepted:null,decisionId:item.decision.decisionId});return;
    }
    const event=engine.input(item.action,{source:agent==='rule'?'rule':'agent',decisionId:item.decision.decisionId,applicationTick});
    const input={...event,applicationTick,decisionId:item.decision.decisionId};
    run.inputLogs.push(input);run.actions.push({tick:event.tick,applicationTick,action:item.action,accepted:event.accepted,decisionId:item.decision.decisionId});item.decision.applicationTick=applicationTick;item.decision.applied=true;item.decision.accepted=event.accepted;
  }

  function maybeCapture(tick){if(trace)run.frameSnapshots.push({tick,state:visibleObservation(engine)});}

  function recordOpportunity(tick){
    const decision={decisionId:`${seed}-${run.decisions.length+1}`,questionCount,dispatchTick:tick,completionTick:null,applicationTick:null,latencyMs:null,rawRequest:null,rawRequestBody:null,rawResponse:null,rawProbabilities:null,answers:null,action:null,lateReply:false,applied:false,status:'pending'};
    run.decisions.push(decision);
    if(agent==='idle'){
      decision.status='idle_no_action';run.skips.push({tick,decisionId:decision.decisionId,reason:'idle_baseline'});return;
    }
    const state=visibleObservation(engine);
    if(agent==='rule'){
      if(outstanding){decision.status='skipped_outstanding';run.skips.push({tick,decisionId:decision.decisionId,reason:'request_outstanding'});return;}
      if(questionCount===64)state.probes=Array.from({length:PROBE_COUNT},(_,i)=>(i+callIndex)%2===0);
      const action=chooseRuleAction(state),answers=localAnswers(state,action,questionCount);answers.danger.score=ruleDanger(state);
      decision.answers=answers;decision.rawProbabilities=answers.action.probabilities;decision.action=action;decision.completionTick=tick;decision.latencyMs=0;decision.status='answered';
      run.latencies.push({decisionId:decision.decisionId,dispatchTick:tick,completionTick:tick,latencyMs:0});
      pendingAction={decision,action};callIndex++;return;
    }
    if(outstanding){decision.status='skipped_outstanding';run.skips.push({tick,decisionId:decision.decisionId,reason:'request_outstanding'});return;}
    const request=buildSystemOneRequest({model,state,questionCount,callIndex:callIndex++});
    const body=JSON.stringify(request);decision.rawRequest=request;decision.rawRequestBody=body;decision.requestStartedWallMs=elapsedMs();outstanding=decision;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(new Error('request_timeout')),responseTimeoutMs);
    const task=Promise.resolve().then(()=>transport(url,body,controller.signal)).then(result=>settleResponse(decision,result,null)).catch(error=>settleResponse(decision,null,error)).finally(()=>clearTimeout(timeout));
    tasks.push(task);
  }

  function settleResponse(decision,result,error){
    const receivedAt=performance.now();
    if(!ended)pump(receivedAt);
    const late=ended;decision.lateReply=late;decision.responseObservedTick=engine.tick;decision.completionTick=late?null:engine.tick;decision.completedWallMs=receivedAt-started;decision.latencyMs=receivedAt-(started+decision.requestStartedWallMs);
    if(Number.isFinite(decision.latencyMs))run.latencies.push({decisionId:decision.decisionId,dispatchTick:decision.dispatchTick,completionTick:decision.completionTick,latencyMs:decision.latencyMs,late});
    if(error){decision.status=late?'late_transport_error':'transport_error';decision.error=String(error?.message??error);run.responseErrors.push({decisionId:decision.decisionId,kind:'transport_error',message:decision.error,late});}
    else{
      decision.httpStatus=result?.status??null;decision.rawResponse=typeof result?.body==='string'?result.body:JSON.stringify(result?.body??null);
      let parsed=null;try{parsed=JSON.parse(decision.rawResponse);}catch{}
      decision.rawProbabilities=parsed?.answers?.action?.probabilities??null;
      if(result?.status<200||result?.status>=300){decision.status=late?'late_http_error':'http_error';decision.error=`HTTP ${result.status}`;run.responseErrors.push({decisionId:decision.decisionId,kind:'http_error',status:result.status,late});}
      else try{decision.answers=parseSystemOneResponse(decision.rawResponse,questionCount);decision.action=decision.answers.action.choice;decision.status=late?'late_answer_not_applied':'answered';}
      catch(validationError){decision.status=late?'late_invalid_response':'invalid_response';decision.action=null;decision.answers=null;decision.error=String(validationError.message);run.responseErrors.push({decisionId:decision.decisionId,kind:'invalid_response',message:decision.error,late});}
    }
    if(outstanding===decision)outstanding=null;
    if(!late&&decision.status==='answered'&&decision.action)pendingAction={decision,action:decision.action};
  }

  function pump(now){
    if(ended)return;
    try{
      const invalid=clock.advance(now,engine,{
        beforeStep(nextTick){if(ended||nextTick>maxTicks)return false;applyPending(nextTick);return true;},
        afterStep(tick){maybeCapture(tick);if(engine.dead)return;if(tick%16===0)recordOpportunity(tick);if(tick>=maxTicks)finish('time_limit');}
      });
      if(invalid){run.runtimeGameInvalidErrors.push({reason:invalid,tick:engine.tick,wallMs:elapsedMs()});finish(invalid);}
      else if(engine.dead)finish('collision');
      else if(engine.tick>=maxTicks)finish('time_limit');
    }catch(error){run.runtimeGameInvalidErrors.push({reason:'runtime_error',tick:engine.tick,message:String(error?.message??error),wallMs:elapsedMs()});finish('runtime_error');}
  }

  while(!ended){pump(performance.now());if(!ended)await new Promise(resolve=>setTimeout(resolve,pollIntervalMs));}
  if(tasks.length)await Promise.allSettled(tasks);
  run.postTerminalWaitMs=postTerminalWaitStarted===null?0:performance.now()-postTerminalWaitStarted;
  run.traceValidation='unchecked';
  run.valid=run.terminalStatus==='collision'&&run.runtimeGameInvalidErrors.length===0&&run.responseErrors.length===0;
  run.eligibleForSummary=run.valid&&run.endReason==='collision';
  return run;
}

function parseList(value,label){const values=value.split(',').map(v=>Number(v.trim()));if(!values.length||values.some(v=>!Number.isInteger(v)||v<0||v>0xffffffff))throw new Error(`${label} must be comma-separated unsigned 32-bit integers`);return values;}

export function parseArgs(argv){
  const out={agent:null,seeds:[101,202,303,404,505],questions:3,maxSeconds:30,maxJumps:2,model:null,url:DEFAULT_URL,metadataFile:null,output:null,trace:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(arg==='--trace'){out.trace=true;continue;}if(arg==='--help'||arg==='-h'){out.help=true;continue;}
    const key=arg.slice(2),value=argv[++i];if(!arg.startsWith('--')||value===undefined)throw new Error(`Unexpected argument: ${arg}`);
    if(key==='agent')out.agent=value;
    else if(key==='seeds')out.seeds=parseList(value,'--seeds');
    else if(key==='questions')out.questions=Number(value);
    else if(key==='max-seconds')out.maxSeconds=Number(value);
    else if(key==='max-jumps')out.maxJumps=Number(value);
    else if(key==='model')out.model=value;
    else if(key==='url')out.url=value;
    else if(key==='metadata')out.metadataFile=value;
    else if(key==='output')out.output=value;
    else throw new Error(`Unknown option: --${key}`);
  }
  if(out.help)return out;
  if(!['remote','rule','idle'].includes(out.agent))throw new Error('--agent remote|rule|idle is required');
  if(![3,64].includes(out.questions))throw new Error('--questions must be 3 or 64');
  if(!Number.isFinite(out.maxSeconds)||out.maxSeconds<=0||out.maxSeconds>30||Math.floor(out.maxSeconds*CONFIG.hz)<1)throw new Error('--max-seconds must be positive, at most 30, and include one physics tick');
  if(![1,2].includes(out.maxJumps))throw new Error('--max-jumps must be 1 or 2');
  if(out.agent==='remote'&&(!out.model||!out.model.trim()))throw new Error('--model is required for remote agent');
  if(!out.output)throw new Error('--output FILE is required');
  return out;
}

async function readMetadata(file){if(!file)return{};const value=JSON.parse(await readFile(file,'utf8'));if(!isRecord(value))throw new Error('--metadata must contain a JSON object');return value;}

export async function sourceDigest(root=ROOT){
  const digest=createHash('sha256');
  for(const relative of SOURCE_FILES){digest.update(relative);digest.update('\0');digest.update((await readFile(path.join(root,relative),'utf8')).replace(/\r\n/g,'\n'));digest.update('\0');}
  return digest.digest('hex');
}

function currentCommit(root=ROOT){return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}

export async function buildReport(options){
  const metadata=await readMetadata(options.metadataFile),commit=currentCommit(),digest=await sourceDigest();
  const runs=[];
  for(const seed of options.seeds)runs.push(await runEpisode({seed,agent:options.agent,questionCount:options.questions,maxSeconds:options.maxSeconds,maxJumps:options.maxJumps,model:options.model,url:options.url,trace:options.trace,metadata}));
  const hardware=metadata.hardware??null,modelMetadata=metadata.model??null,gameCommitMetadata=metadata.gameCommit??null;
  return{
    schema:RESULT_SCHEMA,createdAt:new Date().toISOString(),
    game:{repo:GAME_REPO,commit,sourceDigest:digest,engineVersion:VERSION,config:configForRule(options.maxJumps),configHash:configHashFor(options.maxJumps),ruleId:ruleIdFor(options.maxJumps),observationPipeline:OBSERVATION_PIPELINE},
    variant:{id:'decision-realtime-censored-v1',physicsHz:CONFIG.hz,playbackRate:'1x realtime',questionCount:options.questions,questionCountMeaning:'number of questions in one SystemOne request',systemOneQuestionCount:options.questions,dispatchEveryTicks:16,dispatchCadenceMs:1000*16/CONFIG.hz,oneOutstanding:true,maxSeconds:options.maxSeconds,terminationCap:'time_limit_censored',maxJumps:options.maxJumps,frameGapPolicy:'gap over 100ms invalidates; no catch-up ticks discarded',trace:options.trace},
    agent:{kind:options.agent,model:options.model??(options.agent==='rule'?'rule-visible-v1':'idle-v1'),url:options.agent==='remote'?options.url:null},
    model:modelMetadata,hardware,gameCommit:gameCommitMetadata,metadata,
    episodes:runs.map(({seed,terminalStatus,endReason,valid,eligibleForSummary,finalTick,distanceMetres,survivalSeconds,wallSeconds,jumps,finalSnapshotHash,censored})=>({seed,terminalStatus,endReason,valid,eligibleForSummary,finalTick,distanceMetres,survivalSeconds,wallSeconds,jumps,finalSnapshotHash,censored})),
    runs,runtimeGameInvalidErrors:runs.flatMap(run=>run.runtimeGameInvalidErrors.map(error=>({seed:run.seed,...error})))
  };
}

const HELP=`VECTOR RUN Decision 2.0 bench\nnode scripts/decision-bench.mjs --agent remote|rule|idle --seeds 101,202 --questions 3|64 --max-seconds 30 --max-jumps 2 --model MODEL --url http://127.0.0.1:8780/v1/systemone --metadata FILE --output FILE [--trace]\n--questions is the question count in each SystemOne request (q3 or q64); requests are dispatched every 16 physics ticks until terminal/horizon.`;

async function main(){
  const options=parseArgs(process.argv.slice(2));if(options.help){process.stdout.write(`${HELP}\n`);return;}
  const report=await buildReport(options),output=path.resolve(options.output);await mkdir(path.dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(report,null,2)}\n`,'utf8');process.stdout.write(`${output}\n`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
