// Source-contract checks complement (and do not replace) browser UI QA.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const app=fs.readFileSync(new URL('../dist/app.js',import.meta.url),'utf8'),html=fs.readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
test('all fixed ID references exist in HTML',()=>{const refs=[...app.matchAll(/\$\('([A-Za-z][A-Za-z0-9]+)'\)/g)].map(m=>m[1]);for(const id of refs)assert.ok(html.includes(`id="${id}"`),id);});
test('benchmark has no persistent storage, network/model calls, or variable display physics',()=>{assert.doesNotMatch(app,/localStorage|sessionStorage|fetch\(|XMLHttpRequest|Math\.random\(/);assert.match(app,/innerWidth,height:innerHeight/);assert.match(app,/function animation\(\)\{const now=performance\.now\(\)/);});
test('read-only agent observation exposes current pixels, not course state',()=>{const block=app.slice(app.indexOf('function captureFrame'),app.indexOf('// Intentionally'));assert.match(block,/toDataURL/);assert.doesNotMatch(block,/course|obstacles|nextEncounter|snapshot/);});
test('all real-time invalidation routes and downloadable formats are wired',()=>{for(const term of ["'visibilitychange'","'hidden_tab'","'blur'","'focus_lost'","'application/json'","'text/csv'",'replayRecord(record)','finalStateHash:hash'])assert.ok(app.includes(term),term);});
