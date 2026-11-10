'use strict';

const $ = id => document.getElementById(id);
let dataset = {summary:{},days:[],matches:[]};
let pickedFile = null;
let scanning = false;
let query = '';
let sourceFilter = 'all';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function formatted(number) { return Number(number || 0).toLocaleString(); }
function readableDate(timestamp) {
  const value=Date.parse(timestamp || '');
  return Number.isFinite(value) ? new Date(value).toLocaleString(undefined,{
    month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'
  }) : 'Unknown date';
}
function timeOfDay(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  const whole=Math.max(0,Math.floor(Number(seconds)));
  return String(Math.floor(whole/60)).padStart(2,'0') + ':' +
    String(whole%60).padStart(2,'0');
}

async function refresh() {
  try {
    const response=await fetch('/api/state',{cache:'no-store'});
    if (!response.ok) throw new Error('HTTP '+response.status);
    dataset=await response.json();
    render();
  } catch(e) {
    $('watcher-status').textContent='Dashboard disconnected';
    $('sidebar-status').textContent='Connection error';
  }
}
function render() {
  const s=dataset.summary || {};
  $('total').textContent=formatted(s.total);
  $('today').textContent=formatted(s.today);
  $('matches').textContent=formatted(s.matches);
  $('best').textContent=formatted(s.best);
  $('average').textContent=String(s.average ?? 0);
  $('unknown-label').textContent=s.unknown
    ? s.unknown+' unresolved match(es)' : 'Verified player counts';

  const watcher=dataset.watcher || {status:'unknown'};
  const connected=watcher.status==='running';
  $('watcher-status').textContent=connected ? 'Replay watcher active' :
    watcher.status==='not-configured' ? 'Manual import mode' : 'Watcher '+watcher.status;
  $('sidebar-status').textContent=connected ? 'Watching replays' : 'Manual mode';
  document.querySelector('.live-dot').style.background=connected?'var(--green)':'var(--gold)';
  document.querySelector('.mini-dot').style.background=connected?'var(--green)':'var(--gold)';
  drawChart();
  drawTable();
}

function drawChart() {
  const target=$('activity-chart');
  const days=dataset.days || [];
  const highest=Math.max(1,...days.map(d=>d.count));
  target.innerHTML=days.map((day,index)=>{
    const height=day.count===0 ? 2 : Math.max(5,day.count/highest*100);
    return '<div class="bar-slot" title="'+esc(day.label+': '+day.count+' chests')+'">'+
      '<div class="bar-graph" style="height:'+height+'%" aria-label="'+esc(day.count+' chests on '+day.label)+'"></div>'+
      '<span class="bar-label">'+esc(day.label)+'</span></div>';
  }).join('');
}

function badge(source) {
  const server=source==='server';
  return '<span class="source-tag '+(server?'server':'local')+'">'+
    (server?'● SERVER':'● LOCAL')+'</span>';
}
function validation(match) {
  if(match.expectedCount===null) return '<span class="validation-tag pending">Not checked</span>';
  if(match.chestCount===null) return '<span class="validation-tag pending">Unknown</span>';
  const difference=match.chestCount-match.expectedCount;
  return '<span class="validation-tag '+(difference===0?'good':'bad')+'">'+
    (difference===0?'✓ Exact match':(difference>0?'+':'')+difference+' vs expected')+'</span>';
}
function drawTable() {
  const target=$('match-rows');
  let matches=dataset.matches || [];
  if(sourceFilter!=='all') matches=matches.filter(m=>m.source===sourceFilter);
  if(query) matches=matches.filter(m=>[
    m.fileName,m.player,m.sessionId,m.source].some(x=>String(x||'').toLowerCase().includes(query)));
  $('history-count').textContent=String((dataset.matches||[]).length);
  $('history-meta').textContent='Showing '+matches.length+' match'+(matches.length===1?'':'es');
  if(!matches.length) {
    target.innerHTML='<tr><td class="muted" colspan="6">'+
      ((dataset.matches||[]).length ? 'No matches match the current filters.' :
      'No replays scanned yet. Import your first replay above or start the automatic watcher.')+
      '</td></tr>';
    return;
  }
  target.innerHTML=matches.map(m=>'<tr class="match-row" tabindex="0" data-id="'+esc(m.id)+'">'+
    '<td><div class="name-primary">'+esc(m.fileName)+'</div><div class="name-secondary">'+esc(readableDate(m.recordedAt))+'</div></td>'+
    '<td>'+esc(m.player)+'</td>'+
    '<td class="count-cell">'+(m.chestCount===null?'—':formatted(m.chestCount))+'</td>'+
    '<td>'+badge(m.source)+'</td><td>'+validation(m)+'</td>'+
    '<td class="chevron">›</td></tr>').join('');
  for(const row of target.querySelectorAll('.match-row')) {
    row.addEventListener('click',()=>openMatch(row.dataset.id));
    row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openMatch(row.dataset.id)}});
  }
}
function openMatch(id) {
  const m=(dataset.matches||[]).find(m=>m.id===id);
  if(!m) return;
  $('detail-title').textContent=m.fileName;
  $('detail-metrics').innerHTML=[
    ['Chest count',m.chestCount===null?'Unknown':formatted(m.chestCount)],
    ['Expected',m.expectedCount===null?'Not set':formatted(m.expectedCount)],
    ['Source',m.source.toUpperCase()]
  ].map(([title,value])=>'<div>'+esc(title)+'<strong>'+esc(value)+'</strong></div>').join('');
  const messages=[];
  if(m.expectedCount!==null&&m.chestCount!==null) {
    const difference=m.chestCount-m.expectedCount;
    messages.push(difference===0 ? '✓ Parser count matches your observed count.' :
      'Parser counted '+m.chestCount+' chests; observed count is '+m.expectedCount+' (difference: '+(difference>0?'+':'')+difference+').');
  }
  if(m.sessionId) messages.push('Match ID: '+m.sessionId);
  if(m.serverAttempt?.status) messages.push('Server replay: '+m.serverAttempt.status+
    (m.serverAttempt.reason?' — '+m.serverAttempt.reason:''));
  messages.push(...(m.warnings||[]));
  $('detail-validation').textContent=messages.length?messages.join(' · '):
    'No validation count entered yet. Import the replay with an observed chest count to compare.';
  const events=m.events||[];
  $('detail-events').innerHTML=events.length ? events.slice(0,200).map((e,i)=>
    '<div class="event"><span>'+esc(timeOfDay(e.time))+'</span>'+
    '<strong>'+esc(e.chestClass || e.className || 'Chest')+'</strong>'+
    '<span>#'+(i+1)+'</span></div>').join(''):
    '<div class="empty-events">No individual chest events were stored for this recording.</div>';
  $('match-dialog').showModal();
}

function assignFile(file) {
  if(!file) return;
  if(!file.name.toLowerCase().endsWith('.replay')) {
    status('Please choose a Fortnite .replay file.',true);
    return;
  }
  if(file.size>300*1024*1024) {
    status('Replay exceeds the 300 MB upload limit.',true);
    return;
  }
  pickedFile=file;
  $('file-label').textContent=file.name;
  $('scan-btn').disabled=scanning;
  $('scan-status').textContent='';
}
function status(message,error=false,success=false) {
  const target=$('scan-status');
  target.textContent=message;
  target.className='scan-status'+(error?' error':success?' success':'');
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function analyze() {
  if(!pickedFile || scanning) return;
  scanning=true;$('scan-btn').disabled=true;
  const params=new URLSearchParams({name:pickedFile.name,
    noServer:$('server-lookup').checked?'0':'1'});
  const expected=$('expected').value.trim();
  if(expected!=='') {
    const number=Number(expected);
    if(!Number.isInteger(number)||number<0||number>99999) {
      status('Observed chest count must be between 0 and 99,999.',true);
      scanning=false;$('scan-btn').disabled=false;return;
    }
    params.set('expected',expected);
  }
  try{
    status('Uploading local replay…');
    const response=await fetch('/api/scan?'+params,{method:'POST',
      headers:{'Content-Type':'application/octet-stream'},body:pickedFile});
    const submitted=await response.json();
    if(!response.ok) throw new Error(submitted.error || 'Replay upload failed');
    status('Replay uploaded. Reading chest events…');
    let finished=false;
    for(let attempt=0;attempt<110;attempt++){
      await delay(2000);
      const polled=await fetch('/api/jobs/'+encodeURIComponent(submitted.jobId),{cache:'no-store'});
      const job=await polled.json();
      if(job.status==='error') throw new Error(job.error || 'Chest scan failed');
      if(job.status==='done') {
        finished=true;
        status('Replay analyzed! Results added to match history.',false,true);
        await refresh();
        openMatch('import:'+submitted.jobId);
        break;
      }
      status(job.phase==='Decoding chest events'?
        'Parsing replay and checking server availability…':(job.phase||'Processing replay…'));
    }
    if(!finished) throw new Error('Scan is taking longer than expected; check the match history shortly.');
  }catch(e){status(e.message||String(e),true)}
  finally{scanning=false;$('scan-btn').disabled=!pickedFile}
}

document.addEventListener('DOMContentLoaded',()=>{
  $('today-label').textContent=new Date().toLocaleDateString(undefined,{
    weekday:'short',month:'short',day:'numeric',year:'numeric'});
  const zone=$('drop-zone'),input=$('file-input');
  zone.addEventListener('click',()=>input.click());
  zone.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click()}
  });
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover')});
  zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
  zone.addEventListener('drop',e=>{
    e.preventDefault();zone.classList.remove('dragover');
    assignFile(e.dataTransfer?.files?.[0]);
  });
  input.addEventListener('change',()=>assignFile(input.files[0]));
  $('scan-btn').addEventListener('click',analyze);
  $('search').addEventListener('input',e=>{query=e.target.value.trim().toLowerCase();drawTable()});
  $('source-filter').addEventListener('change',e=>{sourceFilter=e.target.value;drawTable()});
  $('close-dialog').addEventListener('click',()=>$('match-dialog').close());
  $('match-dialog').addEventListener('click',e=>{
    if(e.target===$('match-dialog')) $('match-dialog').close();
  });
  refresh();
  setInterval(()=>{if(!document.hidden)refresh()},6000);
});
