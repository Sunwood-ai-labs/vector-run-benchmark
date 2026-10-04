import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {buildQuestions,buildSystemOneRequest,parseArgs,parseSystemOneResponse,runEpisode} from '../scripts/decision-bench.mjs';
import {verifyCensoredTrace} from '../scripts/verify-decision-trace.mjs';

const visibleState={schema:'vector-run-visible-state/v1',tick:16,dead:false,player:{y:0,vy:0,held:false,jumpsUsed:0,maxJumps:2,speed:250},obstacles:[{x:400,width:30,height:40}],probes:[true]};

function makeAnswers(request,choice='wait'){
  return Object.fromEntries(Object.keys(request.questions).map(key=>{
    if(key==='action')return[key,{type:'choice',choice,probabilities:{wait:choice==='wait'?0.8:0.1,jump:choice==='jump'?0.8:0.1,release:choice==='release'?0.8:0.1},providerField:'retained'}];
    if(key==='commit')return[key,{type:'noul',noul:0.8}];
    if(key==='danger')return[key,{type:'score',score:1,probabilities:{safe:0.7,caution:0.2,danger:0.1}}];
    return[key,{type:'noul',noul:request.state.probes[Number(key.slice(1))]?1:0}];
  }));
}

async function withFakeServer(handler,fn){
  const server=createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  try{await fn(`http://127.0.0.1:${address.port}/v1/systemone`);}
  finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

test('q3 drops supplied probes; q64 has only explicit synthetic boolean probes and exact per-request keys',()=>{
  const q3=buildSystemOneRequest({model:'fixture',state:visibleState,questionCount:3});
  assert.deepEqual(Object.keys(q3),['model','state','questions']);
  assert.deepEqual(Object.keys(q3.questions),['action','commit','danger']);
  assert.equal(Object.hasOwn(q3.state,'probes'),false);
  assert.match(q3.questions.action.instructions,/800×縦360.*地面はy=278.*x=116,width=34,height=42/);
  assert.match(q3.questions.action.instructions,/yは地面からの高さで上向きが正/);
  assert.match(q3.questions.action.instructions,/obstacles\[\]\.xは画面左端/);
  assert.match(q3.questions.action.instructions,/releaseしてからjumpを再press/);
  assert.match(q3.questions.action.instructions,/標準設定は2回/);
  const q64=buildSystemOneRequest({model:'fixture',state:visibleState,questionCount:64,callIndex:1});
  assert.equal(Object.keys(q64.questions).length,64);
  assert.deepEqual(Object.keys(q64.questions),['action','commit','danger',...Array.from({length:61},(_,i)=>`p${i}`)]);
  assert.equal(q64.state.probes.length,61);
  assert.ok(q64.state.probes.every(value=>typeof value==='boolean'));
  assert.match(q64.questions.p0.instructions,/の値はtrueですか/);
  assert.deepEqual(Object.keys(buildQuestions(3)),['action','commit','danger']);
});

test('SystemOne accepts envelope and typed-answer metadata but rejects generated text',()=>{
  const request=buildSystemOneRequest({model:'fixture',state:visibleState,questionCount:64});
  const response={model:'fixture-resolved',usage:{input_tokens:10,output_tokens:4},measurements:{forward_performed:true,backend:'cpu-fixture'},answers:makeAnswers(request)};
  const parsed=parseSystemOneResponse(JSON.stringify(response),64);
  assert.equal(parsed.action.type,'choice');
  assert.equal(parsed.action.probabilities.wait,0.8);
  assert.equal(parsed.danger.type,'score');
  assert.equal(parsed.danger.probabilities.safe,0.7);
  assert.equal(parsed.p0.noul,1);
  assert.throws(()=>parseSystemOneResponse(JSON.stringify({...response,rationale:'no'}),64),/not allowed/);
  assert.throws(()=>parseSystemOneResponse(JSON.stringify({...response,answers:{...response.answers,action:{...response.answers.action,text:'no'}}}),64),/not allowed/);
});

test('CPU fake SystemOne server preserves the full response and applies wait as a no-op',async()=>{
  const bodies=[],responses=[];
  await withFakeServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);bodies.push(body);
    const choice=request.state.tick===16?'jump':'wait';
    const response={model:'fixture-model',usage:{input_tokens:11,output_tokens:5},measurements:{forward_performed:true,device:'cpu-fixture'},answers:makeAnswers(request,choice)};
    const raw=JSON.stringify(response);responses.push(raw);res.writeHead(200,{'content-type':'application/json'});res.end(raw);
  },async url=>{
    const run=await runEpisode({seed:101,agent:'remote',questionCount:3,maxSeconds:0.5,model:'fixture-model',url,trace:true,pollIntervalMs:1});
    assert.equal(run.endReason,'time_limit');
    assert.equal(run.finalTick,60);
    assert.equal(run.frameSnapshots.length,60);
    assert.equal(run.decisions.filter(row=>row.rawRequest!==null).length,3);
    assert.deepEqual(run.decisions.filter(row=>row.rawRequest!==null).map(row=>row.dispatchTick),[16,32,48]);
    assert.deepEqual(Object.keys(JSON.parse(bodies[0]).questions),['action','commit','danger']);
    const first=run.decisions.find(row=>row.rawResponse!==null);
    assert.equal(first.rawResponse,responses[0]);
    assert.equal(JSON.parse(first.rawResponse).measurements.forward_performed,true);
    assert.equal(first.rawProbabilities.wait,0.1);
    const wait=run.actions.find(row=>row.action==='wait');
    assert.ok(wait);
    assert.equal(wait.applicationTick,wait.tick+1);
    assert.equal(run.inputLogs.some(row=>row.action==='wait'),false);
    assert.equal(run.inputLogs[0].action,'jump');
    assert.equal(run.inputLogs[0].applicationTick,run.inputLogs[0].tick+1);
    assert.equal(run.finalState.player.held,true);
    assert.match(run.finalSnapshotHash,/^[0-9a-f]{8}$/);
    assert.deepEqual(verifyCensoredTrace(run),{kind:'censored',matched:true,finalTick:60});
  });
});

test('q3 and q64 both dispatch at ticks 16 and 32; question count never caps opportunities',async()=>{
  await withFakeServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body),response={model:'cadence-fixture',usage:{},measurements:{forward_performed:true},answers:makeAnswers(request)};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));
  },async url=>{
    for(const questionCount of [3,64]){
      const run=await runEpisode({agent:'remote',questionCount,maxSeconds:0.35,model:'cadence-fixture',url,trace:true,pollIntervalMs:1});
      const requests=run.decisions.filter(row=>row.rawRequest!==null);
      assert.deepEqual(requests.map(row=>row.dispatchTick),[16,32]);
      assert.ok(requests.every(row=>Object.keys(row.rawRequest.questions).length===questionCount));
      for(const row of requests)assert.equal(Object.hasOwn(row.rawRequest.state,'probes'),questionCount===64);
    }
  });
});

test('slow inference leaves the clock running, records skipped cadence, and applies on completionTick + 1',async()=>{
  await withFakeServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body),response={model:'slow-fixture',usage:{},measurements:{forward_performed:true},answers:makeAnswers(request,'jump')};
    setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));},190);
  },async url=>{
    const run=await runEpisode({agent:'remote',questionCount:3,maxSeconds:0.75,model:'slow-fixture',url,trace:true,pollIntervalMs:1});
    assert.equal(run.endReason,'time_limit');
    assert.equal(run.finalTick,90);
    assert.equal(run.frameSnapshots.length,90);
    assert.ok(run.skips.some(row=>row.tick===32&&row.reason==='request_outstanding'));
    const applied=run.actions.find(row=>row.action==='jump');
    assert.ok(applied);
    assert.equal(applied.applicationTick,applied.tick+1);
    assert.equal(run.decisions[0].applicationTick,run.decisions[0].completionTick+1);
  });
});

test('malformed answers stay null while physics advances; late valid answers retain raw evidence without application',async()=>{
  await withFakeServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body),late=request.state.tick===16&&request.model==='late-fixture';
    const response=late
      ?{model:'late-fixture',usage:{},measurements:{forward_performed:true,device:'cpu-fixture'},answers:makeAnswers(request,'jump')}
      :{model:'bad-fixture',usage:{},measurements:{},answers:{action:makeAnswers(request).action,danger:makeAnswers(request).danger}};
    const raw=JSON.stringify(response);
    setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end(raw);},late?75:0);
  },async url=>{
    const invalid=await runEpisode({agent:'remote',questionCount:3,maxSeconds:0.35,model:'bad-fixture',url,trace:true,pollIntervalMs:1});
    assert.equal(invalid.finalTick,42);
    assert.equal(invalid.decisions[0].status,'invalid_response');
    assert.equal(invalid.decisions[0].action,null);
    assert.equal(invalid.decisions[0].applicationTick,null);
    assert.equal(invalid.actions.length,0);
    assert.equal(invalid.inputLogs.length,0);
    assert.ok(invalid.responseErrors.length);
    assert.equal(invalid.runtimeGameInvalidErrors.length,0);
    const late=await runEpisode({agent:'remote',questionCount:3,maxSeconds:0.15,model:'late-fixture',url,trace:true,pollIntervalMs:1});
    assert.equal(late.finalTick,18);
    const reply=late.decisions.find(row=>row.rawResponse!==null);
    assert.equal(reply.status,'late_answer_not_applied');
    assert.equal(reply.lateReply,true);
    assert.equal(reply.completionTick,null);
    assert.equal(reply.applicationTick,null);
    assert.equal(reply.action,'jump');
    assert.equal(JSON.parse(reply.rawResponse).measurements.forward_performed,true);
    assert.ok(reply.rawProbabilities);
    assert.equal(late.actions.length,0);
  });
});

test('CLI rejects horizons over 30 seconds',()=>{
  assert.throws(()=>parseArgs(['--agent','idle','--max-seconds','30.01','--output','out.json']),/at most 30/);
  assert.throws(()=>parseArgs(['--agent','idle','--max-seconds','0.001','--output','out.json']),/one physics tick/);
});
