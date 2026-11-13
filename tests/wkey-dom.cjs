const {JSDOM}=require('jsdom');
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../public');
const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;
w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:()=>()=>{}});
w.requestAnimationFrame=()=>0; w.setInterval=()=>0;
w.fetch=async()=>({ok:true,json:async()=>({})});
const ctx=dom.getInternalVMContext();
for(const f of ['app.js','wkey.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);
if(process.env.REPLAY_FIXTURE){
 w.fixture=JSON.parse(fs.readFileSync(process.env.REPLAY_FIXTURE));
 vm.runInContext("enterViewer(fixture);setPlaying(false);$('btn-wkey').click();",ctx);
 const count=w.document.querySelectorAll('.wk-event').length;assert(count>0);w.document.querySelector('.wk-event').click();
 assert(vm.runInContext('!play.playing && play.follow===selected && !!selected',ctx));
 vm.runInContext("$('wk-level').value='strict';$('wk-level').onchange();",ctx);
 assert.equal(w.document.querySelectorAll('.wk-event').length,0);
 console.log(`Real replay: ${count} candidates; jump/follow and missing-shot exclusion passed`);
}
vm.runInContext(" function fixture({same=false,air=false,rangeKnock=false,solo=false,hp=200,shots=[]}={}) {\n const track=[];for(let t=0;t<=25;t+=.25)track.push([t,t<15?0:Math.min(3500,(t-15)*700),0,0,air?2:0,0]);\n const A={id:1,name:'Attacker',team:1,track,hp:[[0,100,100]],shots};\n const B={id:2,name:'Target',team:same?1:2,track:track.map(p=>[p[0],4000,0,0,0,0]),hp:[[18,hp,0]]};\n return {meta:{playlist:solo?'Solo':'Duos',clockOffset:0},time:{start:0,end:25},players:[A,B],storm:[],events:[...(rangeKnock?[{t:10,killer:1,victim:2,downed:true}]:[]),{t:21,killer:1,victim:2,downed:true}]};\n }\n function count(opts,level='normal'){enterViewer(fixture(opts));setPlaying(false);model.isSolo=!!opts?.solo;$('wk-level').value=level;$('btn-wkey').click();return $('wk-list').children.length;}\n const good=count(); const row=$('wk-list').firstChild;row.click();const jumpOK=play.t<20 && play.follow.id===1&&!play.playing;\n globalThis.cases = {good,jumpOK,same:count({same:true}),air:count({air:true}),range:count({rangeKnock:true}),lowHP:count({solo:true,hp:35}),strict:count({},'strict'),fired:count({shots:[18]},'strict')};\n",ctx);
assert.deepEqual(JSON.parse(JSON.stringify(w.cases)),{good:1,jumpOK:true,same:0,air:0,range:0,lowHP:0,strict:1,fired:0});
console.log('DOM integration: straight push, same-team, airborne, prior knock, low health, firing and replay reset passed');
dom.window.close();
