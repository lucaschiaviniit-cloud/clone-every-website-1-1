import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture,loadConfig } from '../../src/capture.js';
import { localServer } from '../../src/replay/local-server.js';
import { verifyCorpus } from '../../src/core/artifacts.js';
import { buildVariants } from '../../src/reconstruction/builders.js';
import { evaluate } from '../../src/evaluate/evaluate.js';

test('One non-root page retains relative assets, query, worker bytes and offline interactions',{timeout:60000},async()=>{
  await mkdir(join(process.cwd(),'.tmp'),{recursive:true});
  const root=await mkdtemp(join(process.cwd(),'.tmp','portable-'));
  const config=await loadConfig('configs/fixture.json');
  config.viewports=[config.viewports[0]];
  config.readySelector='html[data-worker-bytes="4"]';
  config.scenarios=[{id:'load-0',action:'time',atMs:0},{id:'menu-open',action:'click',selector:'#toggle',expect:{selector:'#toggle',attribute:'aria-expanded',value:'true'}}];
  const payload=Buffer.from([20,40,80,160]);
  const server=await localServer(async(req,res)=>{
    if(req.url==='/portfolio/page/?mode=public'){
      res.setHeader('content-type','text/html');
      res.end('<html><head><link rel="stylesheet" href="./style.css"></head><body><button id="toggle" aria-expanded="false">Menu</button><script src="./app.js"></script></body></html>');
    }else if(req.url==='/portfolio/page/style.css'){res.setHeader('content-type','text/css');res.end('body { background: #123; color: white; }');}
    else if(req.url==='/portfolio/page/app.js'){res.setHeader('content-type','text/javascript');res.end('document.querySelector("#toggle").onclick=e=>e.target.setAttribute("aria-expanded","true"); new Worker("./worker.js").onmessage=e=>document.documentElement.dataset.workerBytes=e.data;');}
    else if(req.url==='/portfolio/page/worker.js'){res.setHeader('content-type','text/javascript');res.end('fetch("./frames/frame.bin").then(r=>r.arrayBuffer()).then(b=>postMessage(b.byteLength))');}
    else if(req.url==='/portfolio/page/frames/frame.bin'){res.setHeader('content-type','application/octet-stream');res.end(payload);}
    else{res.statusCode=404;res.end();}
  });
  try{await capture(server.origin+'/portfolio/page/?mode=public',root,config);}finally{await server.close();}
  const manifest=await verifyCorpus(root);
  assert.equal(manifest.status,'complete');
  const frame=manifest.resources.find(r=>r.url.endsWith('/frames/frame.bin'));
  assert.ok(frame?.file);
  assert.deepEqual(await readFile(join(root,frame.file)),payload);
  await buildVariants(root);
  const score=await evaluate(root,'v2');
  assert.equal(score.summary.remoteRequestsTransmitted,0);
  assert.equal(score.summary.interactionPassRate,1);
  assert.equal(score.summary.consoleErrors,0);
  assert.ok(score.viewports[0].network.requests.some((r:any)=>r.url==='/portfolio/page/?mode=public'));
});
