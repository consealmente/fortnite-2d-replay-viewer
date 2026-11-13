const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/wkey.js'), 'utf8');
const functions = source.slice(source.indexOf('function beforeFifthZone'), source.indexOf('function jump('));
const ctx = vm.createContext({model:{storm:[{phase:5,finishShrink:500},{phase:4,finishShrink:400}]},getWkeys:()=>[
 {tc:390,e:{t:399.99},rush:true,fired:false},
 {tc:390,e:{t:400},rush:true,fired:false},
 {tc:401,e:{t:410},rush:true,fired:false},
 {tc:510,e:{t:520},rush:true,fired:false}
]});
vm.runInContext(functions, ctx);
for(const level of ['loose','normal','strict']) assert.equal(vm.runInContext(`candidates('${level}').length`,ctx),1);
assert.equal(vm.runInContext('beforeFifthZone(400)',ctx),false);
ctx.model.storm=[];assert.equal(vm.runInContext("candidates('loose').length",ctx),0);
console.log('All sensitivities exclude exact Zone 5 opening, later events and unknown storm timing; pre-cutoff event retained.');
