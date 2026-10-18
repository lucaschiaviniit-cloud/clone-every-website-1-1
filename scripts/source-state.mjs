import { readdir,readFile,writeFile,stat,realpath,lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve,relative,join } from 'node:path';
import { sha256,within,verifyApproval } from './state.mjs';

const metadata=new Set(['reconstruction-state.json','RECONSTRUCTION_HANDOFF.md']);
export async function freshOutput(directory,protectedDirs) {
  const output=resolve(directory);let ancestor=resolve(output,'..');
  for(;;){try{await lstat(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;const next=resolve(ancestor,'..');if(next===ancestor)throw error;ancestor=next;}}
  const actual=resolve(await realpath(ancestor),relative(ancestor,output));
  for(const dir of protectedDirs)if(within(await realpath(dir),actual))throw new Error('Output must be outside immutable capture and source');
  const {mkdir}=await import('node:fs/promises');await mkdir(resolve(output,'..'),{recursive:true});await mkdir(output);return output;
}
export async function sourceIdentity(directory) {
  const root=resolve(directory),files=[];
  async function walk(folder) {
    for(const entry of await readdir(folder,{withFileTypes:true})) {
      const file=join(folder,entry.name),path=relative(root,file).replaceAll('\\','/');
      if(['node_modules','.git'].includes(entry.name)||(folder===root&&metadata.has(entry.name))||path==='.next/cache'||path.startsWith('.next/cache/'))continue;
      if(entry.isSymbolicLink())throw new Error(`Source symlink unsupported: ${path}`);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile()) {const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);files.push({path,sha256:digest.digest('hex'),mode:(await stat(file)).mode&0o777});}
    }
  }
  await walk(root);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(!files.length)throw new Error('Source project is empty');
  return {sourceSha256:sha256(JSON.stringify(files)),files,root};
}

export async function verifySourceReport(state,reportFile) {
  const approved=await verifyApproval(state),report=JSON.parse(await readFile(reportFile,'utf8'));
  if(state.sourceComparisons?.[resolve(reportFile)]!==sha256(await readFile(reportFile)))throw new Error('Source report changed or was not recorded by the verifier');
  if(!state.sourceDir)throw new Error('Source workspace not recorded');
  const source=await sourceIdentity(state.sourceDir);
  for(const key of ['corpusSha256','baselineSha256','engineSha256'])if(report.identity?.approved?.[key]!==approved[key])throw new Error(`Source report approval drift: ${key}`);
  if(report.identity?.source?.sourceSha256!==source.sourceSha256)throw new Error('Source/build changed since comparison');
  const base=resolve(reportFile,'..');
  for(const entry of report.artifacts??[]) {
    const path=resolve(base,entry.path);if(!within(base,path)||!(await lstat(path)).isFile()||!within(await realpath(base),await realpath(path)))throw new Error('Report artifact path escape or symlink');
    if(sha256(await readFile(path))!==entry.sha256)throw new Error(`Source evidence changed: ${entry.path}`);
  }
  if(!report.artifacts?.length)throw new Error('Source evidence inventory missing');
  return {report,source,approved,reportSha256:sha256(await readFile(reportFile))};
}

export async function bindReport(reportFile,identity) {
  const report=JSON.parse(await readFile(reportFile,'utf8')),base=resolve(reportFile,'..'),artifacts=[];
  for(const state of report.states)for(const path of Object.values(state.paths)) {
    const file=resolve(base,path);if(!within(base,file)||!(await lstat(file)).isFile()||!within(await realpath(base),await realpath(file)))throw new Error('Report artifact path escape or symlink');
    artifacts.push({path,sha256:sha256(await readFile(file))});
  }
  for(const path of ['policy.json','selection.json','coverage.json']) {
    try {const file=join(base,path);if(!(await lstat(file)).isFile()||!within(await realpath(base),await realpath(file)))throw new Error('Report metadata symlink refused');artifacts.push({path,sha256:sha256(await readFile(file))});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  report.identity=identity;report.artifacts=artifacts.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');return report;
}
