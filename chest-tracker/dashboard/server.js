#!/usr/bin/env node
'use strict';

// A loopback-only dashboard for local replay analysis. No 2D map or hosted API.
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { spawn } = require('node:child_process');
const { summarize, csvExport } = require('./data');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data', 'chest-tracker');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const IMPORTS_FILE = path.join(DATA_DIR, 'imports.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD = 300 * 1024 * 1024;
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

async function readJSON(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (_) { return fallback; }
}
async function atomicJSON(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(value, null, 2));
  await fsp.rename(temp, file);
}
function send(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
  res.end(JSON.stringify(data));
}
function config(argv) {
  const opts = {
    port: 3407, watch: true, serverLookup: true, epicId: null,
    folder: process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'FortniteGame', 'Saved', 'Demos') : null
  };
  for (let i=0; i<argv.length; i++) {
    if (argv[i]==='--port' && argv[i+1]) opts.port = Number(argv[++i]);
    else if (argv[i]==='--folder' && argv[i+1]) opts.folder = path.resolve(argv[++i]);
    else if (argv[i]==='--no-watch') opts.watch = false;
    else if (argv[i]==='--no-server') opts.serverLookup = false;
    else if (argv[i]==='--epic-id' && argv[i+1]) opts.epicId = argv[++i];
    else throw new Error('Unknown argument: '+argv[i]);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)
    throw new Error('Invalid --port number');
  return opts;
}
function execute(file, opts, noServer) {
  return new Promise((resolve,reject)=>{
    const args = [path.resolve(__dirname, '..', 'index.js'), file];
    if (noServer || !opts.serverLookup) args.push('--no-server');
    if (opts.epicId) args.push('--epic-id', opts.epicId);
    const child = spawn(process.execPath,args,{cwd:ROOT,windowsHide:true,env:process.env});
    let output='',errors='';
    const timer = setTimeout(()=>child.kill(),180000);
    child.stdout.on('data',b=>{output+=b; if(output.length>20e6) output=output.slice(-20e6)});
    child.stderr.on('data',b=>{errors+=b; if(errors.length>3000) errors=errors.slice(-3000)});
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('close',(code)=>{
      clearTimeout(timer);
      if (code!==0) return reject(new Error(errors.slice(-900) || 'Replay parser exited: '+code));
      try {resolve(JSON.parse(output))}catch(e){reject(new Error('Invalid parser output: '+e.message))}
    });
  });
}
function createDashboard(opts = config([])) {
  const jobs = new Map();
  let watcher = null;
  let watchStatus = {status:'disabled', message:'Automatic folder tracking is off.'};
  let importWrite = Promise.resolve();

  async function state() {
    const [history, imports] = await Promise.all([
      readJSON(HISTORY_FILE,{matches:{}}), readJSON(IMPORTS_FILE,{matches:{}})
    ]);
    return {...summarize(history,imports), watcher: watchStatus};
  }

  async function runImport(job, file, expected, noServer) {
    job.status='scanning'; job.phase='Decoding chest events';
    try {
      const result = await execute(file,opts,noServer);
      const record = {
        status:'done', fileName:job.filename, scannedAt:new Date().toISOString(),
        playerName:result.playerName, playerEpicId:result.playerEpicId,
        sessionId:result.sessionId, matchCode:result.matchCode,
        chestCount:result.chestCount, expectedCount:expected, source:result.source,
        localChestCount:result.localChestCount, serverChestCount:result.serverChestCount,
        serverAttempt:result.serverAttempt, chestEvents:result.chests,
        warnings:result.warnings,
      };
      importWrite=importWrite.then(async()=>{
        const imports=await readJSON(IMPORTS_FILE,{version:1,matches:{}});
        imports.matches ||= {};
        imports.matches[job.id]=record;
        await atomicJSON(IMPORTS_FILE,imports);
      });
      await importWrite;
      job.status='done'; job.phase='Complete'; job.result=record;
    } catch(e) {
      job.status='error'; job.phase='Failed'; job.error=String(e.message||e).slice(-1000);
    } finally {
      try {await fsp.rm(file,{force:true})}catch(_){}
    }
  }

  const server = http.createServer(async(req,res)=>{
    const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
    try {
      if (req.method==='GET' && url.pathname==='/api/state') return send(res,200,await state());
      if (req.method==='GET' && url.pathname==='/api/health')
        return send(res,200,{status:'ok',watcher:watchStatus.status});
      if (req.method==='GET' && url.pathname==='/api/export.csv') {
        const data=await state();
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8',
          'Content-Disposition':'attachment; filename="fortnite-chests.csv"',
          'Cache-Control':'no-store'});
        return res.end(csvExport(data.matches));
      }
      if (req.method==='GET' && url.pathname.startsWith('/api/jobs/')) {
        const job=jobs.get(url.pathname.slice('/api/jobs/'.length));
        return job ? send(res,200,job) : send(res,404,{error:'Job not found'});
      }
      if (req.method==='POST' && url.pathname==='/api/scan') {
        if (jobs.size && [...jobs.values()].some(j=>['uploading','scanning'].includes(j.status)))
          return send(res,409,{error:'A replay scan is already in progress.'});
        if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream')
          return send(res,415,{error:'Upload a .replay file as application/octet-stream'});
        const filename=path.basename(url.searchParams.get('name') || 'uploaded.replay');
        if (!filename.toLowerCase().endsWith('.replay'))
          return send(res,400,{error:'Only .replay recordings are accepted'});
        const rawExpected=url.searchParams.get('expected');
        const expected=rawExpected!==null && /^\d{1,5}$/.test(rawExpected) ? Number(rawExpected) : null;
        const noServer=url.searchParams.get('noServer')==='1';
        const id=randomUUID();
        const file=path.join(UPLOAD_DIR,id+'.replay');
        const job={id, filename, status:'uploading', phase:'Uploading replay', createdAt:new Date().toISOString(),error:null};
        jobs.set(id,job);
        await fsp.mkdir(UPLOAD_DIR,{recursive:true});
        try {
          let bytes=0;
          const limit=new Transform({transform(chunk,enc,done){
            bytes+=chunk.length;
            done(bytes>MAX_UPLOAD ? new Error('Replay exceeds 300 MB limit') : null,chunk);
          }});
          await pipeline(req,limit,fs.createWriteStream(file,{flags:'wx'}));
          if (bytes<1024) throw new Error('Replay must be at least 1 KB');
        }catch(e){
          jobs.delete(id);
          await fsp.rm(file,{force:true});
          return send(res, e.message.includes('300 MB') ? 413:400,{error:e.message});
        }
        send(res,202,{jobId:id});
        void runImport(job,file,expected,noServer);
        return;
      }
      if (req.method==='GET' && Object.hasOwn(ASSETS,url.pathname)) {
        const [name,type]=ASSETS[url.pathname];
        const contents=await fsp.readFile(path.join(__dirname,name));
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});
        return res.end(contents);
      }
      return send(res,404,{error:'Not found'});
    }catch(e){return send(res,500,{error:String(e.message||e)})}
  });

  function startWatcher() {
    if (!opts.watch) return;
    if (!opts.folder || !fs.existsSync(opts.folder)) {
      watchStatus = {status:'not-configured',
        message:'Fortnite Demos folder not found. Upload a replay manually, or start with --folder.'};
      return;
    }
    const args=[path.resolve(__dirname,'..','watch.js'),'--folder',opts.folder];
    if (!opts.serverLookup) args.push('--no-server');
    if (opts.epicId) args.push('--epic-id',opts.epicId);
    watcher=spawn(process.execPath,args,{cwd:ROOT,windowsHide:true});
    watchStatus={status:'running',message:'Watching '+opts.folder};
    watcher.once('error',e=>{watchStatus={status:'error',message:e.message}});
    watcher.once('exit',code=>{watchStatus={status:'stopped',message:'Watcher stopped (exit '+code+')'}});
  }

  server.on('close',()=>{if(watcher && !watcher.killed) watcher.kill()});
  return {server,startWatcher,state};
}

if (require.main===module) {
  try {
    const opts=config(process.argv.slice(2));
    const app=createDashboard(opts);
    app.server.listen(opts.port,'127.0.0.1',()=>{
      const address=app.server.address();
      console.log('Chest dashboard: http://127.0.0.1:'+address.port);
      app.startWatcher();
    });
    process.on('SIGINT',()=>app.server.close(()=>process.exit(0)));
    process.on('SIGTERM',()=>app.server.close(()=>process.exit(0)));
  }catch(e){console.error(e.message);process.exitCode=1}
}

module.exports={createDashboard,config,execute};
