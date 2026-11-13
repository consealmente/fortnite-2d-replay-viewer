const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8');
const a=s.indexOf('function firstZoneAnnouncement()');
const b=s.indexOf('/* ---------------------------------------------------------------------------',a);
const ctx=vm.createContext({model:{meta:{clockOffset:500},storm:[{phase:1,announcedAt:560,startShrink:700,finishShrink:760,center:[0,0],nextCenter:[1,1],radius:100,nextRadius:50}]},lerp:(a,b,t)=>a+(b-a)*t});
vm.runInContext(s.slice(a,b),ctx);
assert.equal(vm.runInContext('stormAt(535)',ctx),null);
assert.equal(vm.runInContext('isPrezone(559.99)',ctx),true);
assert.equal(vm.runInContext('stormAt(560).phaseNo',ctx),1);
assert.equal(vm.runInContext('stormAt(560).timerTo',ctx),140);
assert.equal(vm.runInContext('stormAt(700).shrinking',ctx),true);
assert.equal(vm.runInContext('isPrezone(535)',ctx),true); // backwards seek
ctx.model.storm[0].announcedAt=null;ctx.model.meta.safeZonesStartTime=560;
assert.equal(vm.runInContext('isPrezone(535)',ctx),true);
console.log('Prezone hides circles until recorded announcement; exact transition, clock offset, shrink and backwards seek passed');
