const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('node:assert/strict');
(async () => {
 const root = path.resolve(__dirname, '../public');
 const server = http.createServer((req,res)=>{const file=path.join(root,req.url==='/'?'index.html':req.url.split('?')[0]);try{res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try {
 const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const fixture=process.env.REPLAY_FIXTURE;
 if(fixture){
 await page.evaluate(m=>{enterViewer(m);setPlaying(false);},JSON.parse(fs.readFileSync(fixture)));
 await page.click('#btn-wkey');
 const count=await page.locator('.wk-event').count(); assert(count>0,'real replay has candidates');
 await page.locator('.wk-event').first().click();
 assert(await page.evaluate(()=>!play.playing && !!play.follow && selected===play.follow));
 console.log(`Real replay: ${count} normal candidates; jump and follow passed`);
 await page.selectOption('#wk-level','strict'); assert.equal(await page.locator('.wk-event').count(),0,'missing shots must not qualify as no firing');
 }
 // Known straight approach: 40m to 5m, then knock. Target remains stationary.
 const cases=await page.evaluate(()=>{
 function fixture({same=false,air=false,rangeKnock=false,solo=false,hp=200,shots=[]}={}) {
 const track=[];for(let t=0;t<=25;t+=.25)track.push([t,t<15?0:Math.min(3500,(t-15)*700),0,0,air?2:0,0]);
 const A={id:1,name:'Attacker',team:1,track,hp:[[0,100,100]],shots};
 const B={id:2,name:'Target',team:same?1:2,track:track.map(p=>[p[0],4000,0,0,0,0]),hp:[[18,hp,0]]};
 return {meta:{playlist:solo?'Solo':'Duos',clockOffset:0},time:{start:0,end:25},players:[A,B],storm:[],events:[...(rangeKnock?[{t:10,killer:1,victim:2,downed:true}]:[]),{t:21,killer:1,victim:2,downed:true}]};
 }
 function count(opts,level='normal'){enterViewer(fixture(opts));setPlaying(false);model.isSolo=!!opts?.solo;$('wk-level').value=level;$('btn-wkey').click();return $('wk-list').children.length;}
 const good=count(); const row=$('wk-list').firstChild;row.click();const jumpOK=play.t<20 && play.follow.id===1&&!play.playing;
 return {good,jumpOK,same:count({same:true}),air:count({air:true}),range:count({rangeKnock:true}),lowHP:count({solo:true,hp:35}),strict:count({},'strict'),fired:count({shots:[18]},'strict')};
 });
 assert.deepEqual(cases,{good:1,jumpOK:true,same:0,air:0,range:0,lowHP:0,strict:1,fired:0});
 assert.deepEqual(errors,[]); console.log('Synthetic exclusions, strict shot handling, replay reset and browser integration passed');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
