'use strict';
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const { downloadMetadata } = require('fortnite-replay-downloader');
const buildMeta = require('fortnite-replay-downloader/src/buildMeta');
const getDownloadLink = require('fortnite-replay-downloader/src/getDownloadLink');
const { baseDataUrl } = require('fortnite-replay-downloader/constants');

const REPLAY_DIR = path.join(process.env.VERCEL ? '/tmp' : path.join(__dirname, '..', 'data'), 'replays');
const int32 = n => { const b=Buffer.allocUnsafe(4); b.writeInt32LE(n); return b; };
const str = s => { const b=Buffer.from(String(s || ''), 'utf8'); return Buffer.concat([int32(String(s || '').length + 1),b,Buffer.from([0])]); };
async function write(out, data) { if (!out.write(data)) await once(out,'drain'); }
async function copyUrl(out,url) {
  const response = await fetch(url, {headers:{'User-Agent':'Tournament replay downloader'}});
  if (!response.ok || !response.body) throw new Error('Replay chunk download failed: HTTP '+response.status);
  let bytes=0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    bytes+=chunk.length;
    await write(out,chunk);
  }
  return bytes;
}
async function downloadReplay(code,onProgress=()=>{}) {
  fs.mkdirSync(REPLAY_DIR,{recursive:true});
  const target=path.join(REPLAY_DIR,code+'.replay');
  if (fs.existsSync(target) && fs.statSync(target).size>1024) {onProgress(100);return target;}
  const temp=target+'.partial';
  const metadata=await downloadMetadata({matchId:code,chunkDownloadLinks:false});
  if (!metadata) throw new Error('Replay metadata not found for '+code);
  const parts=[{kind:0,item:metadata},...(metadata.DataChunks||[]).map(item=>({kind:1,item})),...(metadata.Events||[]).map(item=>({kind:3,item})),...(metadata.Checkpoints||[]).map(item=>({kind:2,item}))];
  const links=await getDownloadLink(baseDataUrl+code+'/',parts.map(p=>p.kind===0?'header.bin':p.item.Id+'.bin'));
  const out=fs.createWriteStream(temp);
  try {
    await write(out,buildMeta(metadata));
    for (let i=0;i<parts.length;i++) {
      const {kind,item}=parts[i];
      const name=kind===0?'header.bin':item.Id+'.bin';
      const url=links[name]?.readLink;
      if (!url) throw new Error('Missing replay chunk '+name);
      // The 8-byte chunk header stores type and payload size. Reserve and patch size.
      const chunkStart=out.bytesWritten;
      await write(out,int32(kind));
      await write(out,int32(0));
      if(kind===1) {
        await write(out,int32(item.Time1));
        await write(out,int32(item.Time2));
        await write(out,int32(Number(links[name].size)));
        await write(out,int32(item.SizeInBytes));
      } else if(kind===2 || kind===3) {
        await write(out,str(item.Id));
        await write(out,str(item.Group));
        await write(out,str(item.Metadata||''));
        await write(out,int32(item.Time1));
        await write(out,int32(item.Time2));
        await write(out,int32(Number(links[name].size)));
      }
      await copyUrl(out,url);
      onProgress(Math.round((i+1)/parts.length*100));
      // Flush each chunk before patching its actual payload length.
      if (!out.write(Buffer.alloc(0))) await once(out,'drain');
      const payloadSize=out.bytesWritten-chunkStart-8;
      // Store patch offsets; write after stream closes to avoid concurrent file writes.
      (out.patches ||= []).push([chunkStart+4,payloadSize]);
    }
    out.end();
    await finished(out);
    const fd=fs.openSync(temp,'r+');
    try {for(const [offset,size] of out.patches||[]) fs.writeSync(fd,int32(size),0,4,offset);}
    finally {fs.closeSync(fd);}
    fs.renameSync(temp,target);
    return target;
  } catch(err) {out.destroy();try{fs.rmSync(temp,{force:true});}catch(_){}throw err;}
}
module.exports={downloadReplay,REPLAY_DIR};
