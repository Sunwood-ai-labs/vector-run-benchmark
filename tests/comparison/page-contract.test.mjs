import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLocalServer} from '../../scripts/serve.mjs';

test('comparison gate is served beside the canonical game renderer',async()=>{
  const server=createLocalServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=server.address().port;
    const get=pathname=>new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${port}${pathname}`,res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],body}));}).on('error',reject));
    const [page,style,player,game]=await Promise.all(['/comparison/index.html','/comparison/style.css','/comparison/player.js','/index.html'].map(get));
    for(const item of [page,style,player,game])assert.equal(item.status,200);
    assert.match(page.body,/8 traceと未測定証拠/);
    assert.match(page.body,/9モデルの同時推論ではありません/);
    assert.match(page.body,/structured-visible-state-v1/);
    assert.match(page.body,/q3\/request/);
    assert.match(page.body,/q64\/request/);
    assert.match(page.body,/質問数はdispatch回数を制限しません/);
    assert.match(page.body,/id="report-files"/);
    assert.match(page.body,/native CLI report JSONを8本/);
    assert.match(page.body,/id="reasoning-evidence-file"/);
    assert.match(page.body,/未測定:配布元401/);
    assert.match(page.body,/8 measured runs and one unavailable status card/);
    assert.match(page.body,/id="start-replay"/);
    assert.match(player.body,/validateDecision20Turn/);
    assert.match(player.body,/file\.text\(\)/);
    assert.match(player.body,/neural_forward_calls/);
    assert.match(player.body,/preflight-errors/);
    assert.match(player.body,/validateReasoningUnavailableEvidence/);
    assert.match(player.body,/exactly eight native CLI reports/);
    assert.match(player.body,/invalid_clock_gap/);
    assert.match(style.body,/body\.capture-mode/);
    assert.match(style.body,/\.unavailable-tile/);
    assert.match(game.body,/<canvas id="game" width="800" height="360"/);
    const missing=await get('/comparison/missing.js');
    assert.equal(missing.status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
