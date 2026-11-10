'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, csvExport } = require('./data');
const { createDashboard, config } = require('./server');

function sample({count, sessionId, player='id-a', time='2026-11-10T17:30:00.000Z', extra={}}) {
  return {
    status:'done', chestCount:count, sessionId, playerEpicId:player,
    recordedAt:time, scannedAt:time, ...extra
  };
}

test('totals, averages, and observed-count validation data are calculated correctly',()=>{
  const state=summarize({matches:{
    a:{...sample({count:20,sessionId:'abcd'}),mtimeMs:Date.parse('2026-11-10T17:30:00.000Z')},
    b:{...sample({count:8,sessionId:'efgh'}),mtimeMs:Date.parse('2026-11-10T18:30:00.000Z')}
  }},{matches:{}},new Date('2026-11-10T20:00:00.000Z'));
  assert.equal(state.summary.total,28);
  assert.equal(state.summary.matches,2);
  assert.equal(state.summary.average,14);
  assert.equal(state.summary.best,20);
  assert.equal(state.days.length,14);
});

test('same player + match is counted once across watched and imported copies',()=>{
  const history={matches:{'original.replay':{
    status:'done',sessionId:'123abc',playerEpicId:'player-1',chestCount:10,
    mtimeMs:Date.parse('2026-11-10T18:00:00Z')
  }}};
  const imports={matches:{newImport:sample({
    count:12,sessionId:'123abc',player:'player-1',
    extra:{expectedCount:12,filename:'manually-imported.replay'}
  })}};
  const result=summarize(history,imports);
  assert.equal(result.summary.total,12);
  assert.equal(result.summary.matches,1);
  assert.equal(result.summary.duplicatesExcluded,1);
  assert.equal(result.matches[0].expectedCount,12);
});

test('unknown chest counts are not interpreted as zero',()=>{
  const result=summarize({matches:{unknown:{
    status:'done',chestCount:null,sessionId:'x',playerEpicId:'a'
  }}},{matches:{}});
  assert.equal(result.summary.total,0);
  assert.equal(result.summary.matches,0);
  assert.equal(result.summary.unknown,1);
});
test('CSV export escapes markup and spreadsheet formulas',()=>{
  const csv=csvExport([{
    recordedAt:'2026-11-10',fileName:'=HYPERLINK("bad")',player:'"hello"',
    sessionId:'id',chestCount:5,expectedCount:5,source:'local',localChestCount:5,serverChestCount:null
  }]);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('""hello""'));
});
test('dashboard defaults to loopback-compatible settings',()=>{
  const opts=config(['--port','0','--no-watch','--no-server']);
  assert.equal(opts.port,0);
  assert.equal(opts.watch,false);
  assert.equal(opts.serverLookup,false);
});
test('dashboard serves HTML, status, empty data, and rejects invalid uploads',async()=>{
  const {server}=createDashboard({port:0,watch:false,serverLookup:false,epicId:null,folder:null});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    const home=await fetch(url+'/');
    assert.equal(home.status,200);
    assert.match(await home.text(),/Chest Tracker Dashboard/);
    const state=await fetch(url+'/api/state');
    assert.equal(state.status,200);
    assert.equal(typeof (await state.json()).summary.total,'number');
    const js=await fetch(url+'/app.js');
    assert.equal(js.status,200);
    const invalid=await fetch(url+'/api/scan?name=test.txt',{
      method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'not a replay'
    });
    assert.equal(invalid.status,400);
  }finally {await new Promise(resolve=>server.close(resolve))}
});
