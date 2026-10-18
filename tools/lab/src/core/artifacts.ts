import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname,join,resolve,relative,isAbsolute } from 'node:path';
import { EvidenceSchema,MODULES,type Manifest,type EvidenceRecord } from './schema.js';

export const hash = (bytes:string|Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Optional macOS storage workaround: logical bytes and evidence hashes stay identical. */
export async function compressEvidenceFile(path:string) {
  if(process.env.CLONE_FS_COMPRESSION!=='1')return;
  if(process.platform!=='darwin')throw new Error('CLONE_FS_COMPRESSION requires macOS filesystem compression');
  const temporary=path+`.compressed-${process.pid}`;
  try {
    const before=hash(await readFile(path));
    await promisify(execFile)('/usr/bin/ditto',['--hfsCompression',path,temporary]);
    if(hash(await readFile(temporary))!==before)throw new Error('Lossless evidence compression byte mismatch');
    await rename(temporary,path);
  }finally{await rm(temporary,{force:true});}
}
export async function jsonWrite(path:string,data:unknown) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,JSON.stringify(data,null,2)+'\n','utf8'); }
export async function jsonRead<T>(path:string):Promise<T> { return JSON.parse(await readFile(path,'utf8')) as T; }
export function safePath(root:string,path:string):string {
  const result=resolve(root,path), rel=relative(resolve(root),result);
  if (rel.startsWith('..')||isAbsolute(rel)) throw new Error('Artifact path escapes corpus');
  return result;
}
export class Artifacts {
  constructor(public root:string,public manifest:Manifest) {}
  async evidence(kind:EvidenceRecord['kind'],viewportId:string,stateId:string,data:unknown,method:string,options:Partial<Pick<EvidenceRecord,'status'|'error'|'source'>>={}) {
    const id=`${kind}-${viewportId}-${stateId}-${this.manifest.evidence.length}`;
    const file=`evidence/${kind}/${id}.json`;
    await jsonWrite(join(this.root,file),data);
    await compressEvidenceFile(join(this.root,file));
    const sha256=hash(await readFile(join(this.root,file)));
    const record=EvidenceSchema.parse({schemaVersion:1,id,kind,captureId:this.manifest.captureId,pageId:'home',stateId,viewportId,source:{url:this.manifest.targetUrl,method,...options.source},timestampIso:new Date().toISOString(),status:options.status??'captured',file,sha256,error:options.error});
    this.manifest.evidence.push(record); return file;
  }
  async binary(kind:EvidenceRecord['kind'],viewportId:string,stateId:string,bytes:Buffer,extension:string,method:string) {
    const id=`${kind}-${viewportId}-${stateId}-${this.manifest.evidence.length}`,file=`evidence/${kind}/${id}.${extension}`;
    await mkdir(dirname(join(this.root,file)),{recursive:true}); await writeFile(join(this.root,file),bytes);
    this.manifest.evidence.push(EvidenceSchema.parse({schemaVersion:1,id,kind,captureId:this.manifest.captureId,pageId:'home',stateId,viewportId,source:{url:this.manifest.targetUrl,method},timestampIso:new Date().toISOString(),status:'captured',file,sha256:hash(bytes)}));
    return file;
  }
  async save() {
    this.manifest.corpusSha256=corpusHash(this.manifest);
    await jsonWrite(join(this.root,'manifest.json'),this.manifest);
    await jsonWrite(join(this.root,'evidence-manifest.json'),{schemaVersion:1,captureId:this.manifest.captureId,corpusSha256:this.manifest.corpusSha256,evidence:this.manifest.evidence});
    await jsonWrite(join(this.root,'coverage.json'),Object.fromEntries(MODULES.map(kind=>{
      const records=this.manifest.evidence.filter(r=>r.kind===kind);
      return [kind,{counts:Object.fromEntries(['captured','unavailable','unsupported','failed','inferred'].map(s=>[s,records.filter(r=>r.status===s).length])),evidence:records.map(r=>r.id)}];
    })));
  }
}
export function corpusHash(m:Manifest) { return hash(JSON.stringify({targetUrl:m.targetUrl,config:m.config,environment:m.environment,evidence:m.evidence,resources:m.resources,states:m.states,...(m.scope?{scope:m.scope}:{})})); }
export async function verifyCorpus(root:string):Promise<Manifest> {
  const m=await jsonRead<Manifest>(join(root,'manifest.json'));
  if(m.schemaVersion!==1) throw new Error('Unsupported manifest schema');
  if(m.status==='complete'&&!!m.config.selective!==(m.scope?.kind==='fusion-selective'))throw new Error('Selective capture scope is missing or inconsistent');
  if(m.corpusSha256!==corpusHash(m)) throw new Error('Corpus manifest was modified');
  const verified=new Map<string,string>();
  const verifyFile=async(file:string,expected:string,error:string)=>{
    const actual=verified.get(file)??hash(await readFile(safePath(root,file)));
    if(actual!==expected)throw new Error(error);verified.set(file,actual);
  };
  for(const record of m.evidence) {
    EvidenceSchema.parse(record);
    if(record.file&&record.sha256)await verifyFile(record.file,record.sha256,`Evidence hash mismatch ${record.id}`);
  }
  for(const r of m.resources) if(r.file)await verifyFile(r.file,r.sha256??'',`Resource hash mismatch ${r.url}`);
  return m;
}
