import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir,mkdtemp,stat,rm } from 'node:fs/promises';
import { createReadStream,createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve,join } from 'node:path';
import { loadState,skillRoot,within,sha256,verifyApproval,writeState } from './state.mjs';
import { verifySourceReport,sourceIdentity,freshOutput } from './source-state.mjs';
import { openRecorder } from './telemetry.mjs';

/** USTAR with fixed metadata and sorted files; contents streamed, no dependency. */
export async function packageSource(root,files,destination) {
  async function* archive() {
    for(const entry of [...files].sort((a,b)=>a.path.localeCompare(b.path,'en'))) {
      const path=entry.path;if(path.startsWith('/')||path.split('/').some(x=>x==='..'))throw new Error('Invalid archive member');
      const header=Buffer.alloc(512),file=resolve(root,path);if(!within(root,file))throw new Error('Archive path escape');
      let name=path,prefix='';
      if(Buffer.byteLength(name)>100) {
        const split=path.lastIndexOf('/',155);prefix=path.slice(0,split);name=path.slice(split+1);
        if(split<0||Buffer.byteLength(prefix)>155||Buffer.byteLength(name)>100)throw new Error('Archive member exceeds USTAR path limit');
      }
      const info=await stat(file),field=(value,offset,length)=>header.write(value,offset,length,'utf8');
      field(name,0,100);field((info.mode&0o777).toString(8).padStart(7,'0')+'\0',100,8);field('0000000\0',108,8);field('0000000\0',116,8);
      field(info.size.toString(8).padStart(11,'0')+'\0',124,12);field('00000000000\0',136,12);
      header.fill(32,148,156);field('0',156,1);field('ustar\0',257,6);field('00',263,2);field(prefix,345,155);
      field([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
      yield header;for await(const chunk of createReadStream(file))yield chunk;
      if(info.size%512)yield Buffer.alloc(512-info.size%512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(archive()),createGzip({level:6}),createWriteStream(destination));
}

export async function terminateProcess(child) {
  if(!child?.pid)return;
  if(process.platform==='win32') {
    await new Promise(ok=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',shell:false});killer.once('error',ok);killer.once('close',ok);});
  }
  const signal=kind=>{try{if(process.platform!=='win32')process.kill(-child.pid,kind);else child.kill(kind);}catch{}};
  signal('SIGTERM');
  const closed=()=>child.stdout?.closed&&child.stderr?.closed;
  if(!closed())await Promise.race([new Promise(ok=>child.once('close',ok)),new Promise(ok=>setTimeout(ok,500))]);
  signal('SIGKILL');
  if(!closed())await new Promise(ok=>child.once('close',ok));
}

export async function command(executable,args,cwd,logFile,timeoutMs=180000) {
  return new Promise((ok,fail)=>{
    const output=createWriteStream(logFile),child=spawn(executable,args,{cwd,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
    let settled=false;
    const finish=async(error)=>{if(settled)return;settled=true;clearTimeout(timer);await terminateProcess(child);output.end(()=>error?fail(error):ok());};
    const timer=setTimeout(()=>{void finish(new Error(`Command timed out: ${executable}`));},timeoutMs);
    output.once('error',error=>{void finish(error);});
    child.once('error',finish);child.once('close',code=>finish(code===0?null:new Error(`Command failed (${code}): ${executable}`)));
  });
}

function configured(value,label) {
  if(!value||typeof value.executable!=='string'||!Array.isArray(value.args)||value.args.some(x=>typeof x!=='string'))throw new Error(`Invalid ${label} command; use executable and args, without shell`);
  return value;
}

async function freePort() {
  const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  const port=server.address().port;await new Promise(ok=>server.close(ok));return port;
}

export async function verifyDelivery({run,reportFile,configFile,out,independenceFile}) {
  const {state}=await loadState(run),current=await verifySourceReport(state,reportFile);
  if(current.report.status!=='comparison_passed'||!current.report.complete)throw new Error('Delivery requires a complete passing comparison');
  if(!current.report.inventoryCoverage?.complete)throw new Error('Delivery requires reviewed section/behavior coverage');
  const config=JSON.parse(await readFile(configFile,'utf8'));
  for(const name of ['install','build','start'])configured(config[name],name);
  if(!Number.isFinite(config.timeoutMs??180000)||(config.timeoutMs??180000)<=0)throw new Error('Invalid delivery timeout');
  const audit=JSON.parse(await readFile(independenceFile,'utf8'));
  if(audit.status!=='passed'||audit.sourceSha256!==current.source.sourceSha256||!audit.rationale?.trim()||!audit.reviewedFiles?.length)throw new Error('Current source independence review is required');
  if(audit.reviewedFiles.some(file=>!current.source.files.some(x=>x.path===file)))throw new Error('Independence review references missing source files');
  out=resolve(out);
  if(within(state.sourceDir,out)||within(state.captureDir,out))throw new Error('Delivery evidence must be outside source and capture');
  await freshOutput(out,[state.sourceDir,state.captureDir]);
  const telemetry=openRecorder(run,{mode:state.metricsMode??'minimum'}),work=await mkdtemp(join(tmpdir(),'clone-delivery-'));
  const checks={},evidence=[],resultFile=join(out,'delivery-check.json');
  let child,serverOutput;
  try {
    const archive=join(out,'source.tar.gz');
    await telemetry.span('delivery','package source',()=>packageSource(state.sourceDir,current.source.files,archive));
    await command('tar',['-xzpf',archive,'-C',work],out,join(out,'extract.log'));
    const extracted=await sourceIdentity(work);
    if(extracted.sourceSha256!==current.source.sourceSha256)throw new Error('Extracted package differs from source inventory');
    checks.packageIntegrity={status:'passed',archive:'source.tar.gz',sourceSha256:extracted.sourceSha256};
    await writeFile(join(out,'source-inventory.json'),JSON.stringify(current.source.files,null,2)+'\n');
    await writeFile(join(out,'independence-review.json'),JSON.stringify(audit,null,2)+'\n');
    checks.sourceIndependence={status:'passed',kind:'explicit source/module review plus runtime diagnostic; not independent authorship authentication',review:'independence-review.json'};
    for(const name of ['install','build']) {
      await telemetry.span('delivery',`fresh ${name}`,()=>command(config[name].executable,config[name].args,work,join(out,`${name}.log`),config.timeoutMs));
      checks[name==='install'?'freshInstall':'freshBuild']={status:'passed',command:config[name],log:`${name}.log`};
    }
    if(config.buildDir) {
      const buildDir=resolve(work,config.buildDir);if(!within(work,buildDir))throw new Error('Build directory must remain in extracted project');
      const buildIdentity=await sourceIdentity(buildDir);
      await packageSource(buildDir,buildIdentity.files,join(out,'build.tar.gz'));
      await writeFile(join(out,'build-inventory.json'),JSON.stringify(buildIdentity.files,null,2)+'\n');
    }
    const port=await freePort(),start=configured(config.start,'start');
    const args=start.args.map(x=>x.replaceAll('{port}',String(port)));
    const url=new URL(config.path??'/',`http://127.0.0.1:${port}`);
    if(url.origin!==`http://127.0.0.1:${port}`)throw new Error('Delivery path must stay on isolated loopback origin');
    const output=createWriteStream(join(out,'start.log'));serverOutput=output;
    child=spawn(start.executable,args,{cwd:work,stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32'});
    child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
    let startError;child.once('error',error=>{startError=error;});
    const deadline=Date.now()+(config.timeoutMs??180000);let available=false;
    while(Date.now()<deadline) {
      if(startError)throw startError;if(child.exitCode!==null)throw new Error('Fresh server exited before readiness');
      try {const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(1000)});await response.arrayBuffer();if(response.status<400){available=true;break;}}catch{}
      await new Promise(ok=>setTimeout(ok,100));
    }
    if(!available)throw new Error('Fresh server did not become ready');
    checks.freshStart={status:'passed',url:url.href,command:{executable:start.executable,args}};
    const lab=join(skillRoot,'tools/lab'),comparisonOut=join(out,'comparison');
    await mkdir(comparisonOut);
    const policyFile=join(out,'policy.json'),policy=JSON.parse(await readFile(resolve(reportFile,'..','policy.json'),'utf8'));
    await writeFile(policyFile,JSON.stringify(policy,null,2)+'\n');
    await telemetry.span('delivery','fresh offline comparison',()=>command(process.execPath,[join(lab,'node_modules/tsx/dist/cli.mjs'),join(lab,'src/cli.ts'),'source-eval','--run',resolve(run),'--url',url.href,'--out',comparisonOut,'--policy',policyFile],lab,join(out,'compare.log'),config.timeoutMs));
    const comparison=JSON.parse(await readFile(join(comparisonOut,'source-report.json'),'utf8'));
    if(comparison.status!=='comparison_passed'||!comparison.complete)throw new Error('Fresh package comparison failed');
    checks.offlineComparison={status:'passed',report:'comparison/source-report.json'};
    // Source and approved baseline must still be the same after packaging and commands.
    await verifySourceReport(state,reportFile);await verifyApproval(state);
    const {readdir}=await import('node:fs/promises');
    async function collect(dir) {for(const item of await readdir(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())await collect(file);else if(item.isFile()&&file!==resultFile){const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);evidence.push({path:file.slice(out.length+1).replaceAll('\\','/'),sha256:digest.digest('hex')});}}}
    // Terminate server and flush its log before hashing evidence.
    await terminateProcess(child);
    if(!output.writableFinished)await new Promise(ok=>output.end(ok));
    await collect(out);
    const result={schemaVersion:1,status:'passed',createdAt:new Date().toISOString(),sourceSha256:current.source.sourceSha256,sourceReportSha256:current.reportSha256,checks,evidence};
    await writeFile(resultFile,JSON.stringify(result,null,2)+'\n');
    const latest=await loadState(run);latest.state.deliveryChecks={...latest.state.deliveryChecks,[resultFile]:sha256(await readFile(resultFile))};await writeState(latest.path,latest.state);
    await telemetry.summarize();return result;
  }catch(error){await writeFile(resultFile,JSON.stringify({schemaVersion:1,status:'failed',checks,error:String(error.message)},null,2)+'\n');throw error;}
  finally{await terminateProcess(child);if(serverOutput&&!serverOutput.writableFinished)await new Promise(ok=>serverOutput.end(ok));await rm(work,{recursive:true,force:true});await telemetry.flush();}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const {values}=parseArgs({options:{run:{type:'string'},report:{type:'string'},config:{type:'string'},out:{type:'string'},'independence-file':{type:'string'},help:{type:'boolean'}}});
    if(values.help)console.log('node scripts/delivery.mjs --run RUN --report SOURCE_REPORT --config delivery-config.json --out FRESH_DIRECTORY --independence-file review.json\nConfig: install/build/start {executable,args}; start port argument uses {port}; optional path, timeoutMs. Packages source deterministically, extracts fresh, installs/builds/starts and compares offline.');
    else {
      for(const key of ['run','report','config','out','independence-file'])if(!values[key])throw new Error(`--${key} required`);
      const result=await verifyDelivery({run:resolve(values.run),reportFile:resolve(values.report),configFile:resolve(values.config),out:resolve(values.out),independenceFile:resolve(values['independence-file'])});
      console.log(JSON.stringify({status:result.status,deliveryFile:join(resolve(values.out),'delivery-check.json')}));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
