import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod,access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareSource } from '../../src/evaluate/source.js';
import { selectScenarios } from '../../src/evaluate/selection.js';
import { corpusHash,hash } from '../../src/core/artifacts.js';
import { softwareFingerprint } from '../../src/browser/launch.js';
import { loadConfig } from '../../src/capture.js';
import type { Manifest } from '../../src/core/schema.js';
import { bindReport,sourceIdentity } from '../../../../scripts/source-state.mjs';

async function temporary(run:(root:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'clone-review-v1-'));
  try{await run(root);}finally{await rm(root,{recursive:true,force:true});}
}
async function minimalCorpus(root:string) {
  await mkdir(root);
  const manifest:Manifest={schemaVersion:1,captureId:'review-fixture',status:'complete',targetUrl:'http://127.0.0.1:1/',createdAt:new Date().toISOString(),config:await loadConfig('configs/fixture.json'),environment:{software:await softwareFingerprint()},evidence:[],resources:[],states:[],errors:[]};
  manifest.corpusSha256=corpusHash(manifest);await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
}

test('Comparator rejects protected corpus outputs and physical symlink aliases before launching a browser',async()=>{
  await temporary(async root=>{
    const corpus=join(root,'corpus');await minimalCorpus(corpus);
    await assert.rejects(()=>compareSource(corpus,'http://127.0.0.1:1/',{out:join(corpus,'nested','comparison')}),/outside capture and source/);
    await assert.rejects(()=>access(join(corpus,'nested')),/ENOENT/);
    const alias=join(root,'alias');await symlink(corpus,alias,'dir');
    await assert.rejects(()=>compareSource(corpus,'http://127.0.0.1:1/',{out:join(alias,'comparison')}),/outside capture and source/);
  });
});

test('Comparator refuses reuse of existing comparison evidence before launching a browser',async()=>{
  await temporary(async root=>{
    const corpus=join(root,'corpus'),out=join(root,'comparison');await minimalCorpus(corpus);await mkdir(out);
    await writeFile(join(out,'source-report.json'),'existing evidence');
    await assert.rejects(()=>compareSource(corpus,'http://127.0.0.1:1/',{out}),/must be fresh/);
    assert.equal(await readFile(join(out,'source-report.json'),'utf8'),'existing evidence');
  });
});

test('Comparator rejects permitted metadata filenames when they are symlinks',async()=>{
  await temporary(async root=>{
    const corpus=join(root,'corpus'),out=join(root,'comparison');await minimalCorpus(corpus);await mkdir(out);
    await symlink(join(corpus,'manifest.json'),join(out,'coverage.json'));
    await assert.rejects(()=>compareSource(corpus,'http://127.0.0.1:1/',{out}),/metadata.*regular|symlink/i);
  });
});

test('Source report binds frozen policy, selection and coverage, and rejects artifact traversal',async()=>{
  await temporary(async root=>{
    await writeFile(join(root,'snapshot.json'),'{}');
    for(const file of ['policy.json','selection.json','coverage.json'])await writeFile(join(root,file),JSON.stringify({fixture:file}));
    const path=join(root,'source-report.json');
    await writeFile(path,JSON.stringify({states:[{paths:{snapshot:'snapshot.json'}}]}));
    const report=await bindReport(path,{fixture:'identity'});
    for(const file of ['policy.json','selection.json','coverage.json']) {
      const entry=report.artifacts.find((entry:any)=>entry.path===file);assert.ok(entry);assert.equal(entry.sha256,hash(await readFile(join(root,file))));
    }
    const policyHash=report.artifacts.find((entry:any)=>entry.path==='policy.json').sha256;
    await writeFile(join(root,'policy.json'),'changed');assert.notEqual(hash(await readFile(join(root,'policy.json'))),policyHash);
    await writeFile(path,JSON.stringify({states:[{paths:{snapshot:'../outside.json'}}]}));
    await assert.rejects(()=>bindReport(path,{}),/artifact path escape/);
  });
});

test('Report binding rejects physical artifact and metadata symlinks outside evidence',async()=>{
  await temporary(async root=>{
    const out=join(root,'evidence');await mkdir(out);
    await writeFile(join(root,'outside.json'),'outside evidence');
    await symlink(join(root,'outside.json'),join(out,'snapshot.json'));
    const reportFile=join(out,'source-report.json');
    await writeFile(reportFile,JSON.stringify({states:[{paths:{snapshot:'snapshot.json'}}]}));
    await assert.rejects(()=>bindReport(reportFile,{}),/path escape|symlink/);
    await rm(join(out,'snapshot.json'));await writeFile(join(out,'snapshot.json'),'{}');
    await symlink(join(root,'outside.json'),join(out,'policy.json'));
    await assert.rejects(()=>bindReport(reportFile,{}),/metadata symlink/);
  });
});

test('Source identity excludes only handoff metadata, includes application policy and filesystem mode',async()=>{
  await temporary(async root=>{
    await writeFile(join(root,'app.js'),'export const answer=42');
    await writeFile(join(root,'policy.json'),'application data');
    await writeFile(join(root,'reconstruction-state.json'),'metadata');
    await writeFile(join(root,'RECONSTRUCTION_HANDOFF.md'),'handoff');
    const initial=await sourceIdentity(root);
    assert.deepEqual(initial.files.map((file:any)=>file.path).sort(),['app.js','policy.json']);
    await writeFile(join(root,'RECONSTRUCTION_HANDOFF.md'),'updated handoff');assert.equal((await sourceIdentity(root)).sourceSha256,initial.sourceSha256);
    await writeFile(join(root,'policy.json'),'changed application data');const updated=await sourceIdentity(root);assert.notEqual(updated.sourceSha256,initial.sourceSha256);
    await chmod(join(root,'app.js'),updated.files.find((file:any)=>file.path==='app.js').mode===0o755?0o644:0o755);assert.notEqual((await sourceIdentity(root)).sourceSha256,updated.sourceSha256);
  });
});

test('Smoke retains paired overlay interactions; targeted verification remains explicitly partial',()=>{
  const scenarios=[{id:'load',action:'time' as const},{id:'open',action:'click' as const},{id:'close',action:'click' as const,dependsOn:['open']},{id:'unlocked',action:'wheel' as const,dependsOn:['close']}];
  const smoke=selectScenarios(scenarios,{mode:'smoke'});
  assert.deepEqual(smoke.measuredIds,['load','open','close','unlocked']);
  const targeted=selectScenarios(scenarios,{mode:'targeted',impactKnown:true,scenarioIds:['close']});
  assert.equal(targeted.fullCoverage,false);assert.deepEqual(targeted.measuredIds,['close']);assert.deepEqual(targeted.setupIds,['load','open']);
});
