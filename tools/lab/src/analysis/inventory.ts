import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse, serializeOuter } from 'parse5';
import { corpusHash, hash, safePath } from '../core/artifacts.js';
import type { ElementSnapshot, Manifest, Resource, Snapshot, StateRef } from '../core/schema.js';

const VERSION = 'inventory-v1.4.0';
const OUTPUTS = ['page-inventory.json', 'reconstruction-index.json', 'assets-map.json'] as const;
export type CoverageStatus = 'passed'|'failed'|'skipped'|'not-verified'|'not-applicable';
export interface InventoryOptions { reviewFile?: string; cache?: boolean }
export interface InventoryReview {
  sections?: { selector: string; label?: string; kind?: string }[];
  coverage?: { sectionId: string; viewportId: string; stateId: string; status: CoverageStatus; reason: string; evidence: string[] }[];
  impacts?: { component: string; sectionIds: string[]; scenarioIds: string[]; shared?: boolean }[];
}
interface EvidenceLink { file: string; sha256: string; nature: 'observed'|'derived'|'hypothesized' }
interface Observation {
  viewportId: string; stateId: string; elementId: string; visible: boolean;
  box: ElementSnapshot['box']; snapshot: EvidenceLink; screenshot: EvidenceLink;
  assertion: EvidenceLink; scenarioIds: string[];
}
export interface InventorySection {
  id: string; selector: string; kind: string; label: string; nature: 'observed'|'hypothesized';
  grouping: 'candidate'|'reviewed'; confidence: number; observations: Observation[];
  mechanismCandidates: string[];
}
export interface PageInventory {
  schemaVersion: 1; toolVersion: string; captureId: string; sourceIdentity: string;
  viewportIds: string[]; corpusSha256?: string;
  sections: InventorySection[];
  coverage: { sectionId: string; viewportId: string; stateId: string; observed: boolean; status: CoverageStatus; reason: string; evidence: string[]; origin: 'default'|'review' }[];
  scenarios: { id: string; action: string; selector?: string; prerequisiteIds: string[]; precondition?: unknown; expected?: unknown }[];
  impacts: NonNullable<InventoryReview['impacts']>;
  gaps: { viewportId?: string; stateId?: string; reason: string; requiredAction: string }[];
  limitations: string[];
  scope?: Manifest['scope'];
}
interface AssetUse { viewportId: string; stateId: string; selector: string; property: string; nature: 'observed' }
export interface AssetEntry {
  substitution?:Resource['substitution'];
  url: string; viewportId: string; file?: string; sha256?: string; mime: string; status: number;
  replayable: boolean; byteIdentity?: string; partial: boolean; uses: AssetUse[];
  dependencies: { url: string; observed: boolean; completeBytes: boolean; resourceIndices: number[] }[];
  recursiveDependencyStatus: 'complete-observed-graph'|'incomplete'|'not-a-playlist';
}
export interface AssetsMap { schemaVersion: 1; captureId: string; sourceIdentity: string; corpusSha256?: string; assets: AssetEntry[]; unresolvedUses: { url:string; viewportId:string; uses:AssetUse[] }[]; limitations: string[] }
export interface ReconstructionIndex {
  schemaVersion: 1; toolVersion: string; captureId: string; sourceIdentity: string; corpusSha256?: string;
  sections: { id: string; selector: string; observations: number; dossier: string; assetIndices: number[]; evidence: EvidenceLink[] }[];
  sourceMaps: { url: string; file: string; sha256?: string; nature: 'observed' }[];
  scriptResources: { url: string; file: string; sha256?: string; nature: 'observed' }[];
  cssResources: { url: string; file: string; sha256?: string; nature: 'observed' }[];
  limitations: string[];
}
interface LoadedState { ref: StateRef; snapshot: Snapshot; assertion: any }
interface Source { root: string; output: string; manifest: Manifest; states: LoadedState[]; hashes: Map<string,string>; identity: string; review: InventoryReview }

function contained(root: string, path: string) { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)); }
async function sourcePath(root: string, file: string) {
  const path = await realpath(safePath(root, file));
  if (!contained(root, path)) throw new Error('Artifact symlink escapes corpus');
  return path;
}
async function fileHash(file: string) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function atomicJson(path: string, data: unknown) {
  const temporary = path + `.tmp-${process.pid}`;
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
  await rename(temporary, path);
}
function reviewConfig(value: any): InventoryReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid inventory review');
  for (const key of Object.keys(value)) if (!['sections','coverage','impacts'].includes(key)) throw new Error(`Unknown inventory review field ${key}`);
  for (const key of ['sections','coverage','impacts']) if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error(`Invalid review ${key}`);
  for (const s of value.sections ?? []) if (typeof s.selector !== 'string' || !s.selector.trim() || (s.label !== undefined && typeof s.label !== 'string') || (s.kind !== undefined && typeof s.kind !== 'string')) throw new Error('Invalid reviewed section');
  for (const c of value.coverage ?? []) if (!['passed','failed','skipped','not-verified','not-applicable'].includes(c.status) || !['sectionId','viewportId','stateId','reason'].every(k=>typeof c[k] === 'string' && c[k].trim()) || !Array.isArray(c.evidence) || !c.evidence.length || !c.evidence.every((e:unknown)=>typeof e === 'string')) throw new Error('Coverage review requires explicit status, reason and evidence');
  const coverageKeys=(value.coverage??[]).map((c:any)=>JSON.stringify([c.sectionId,c.viewportId,c.stateId]));
  if(new Set(coverageKeys).size!==coverageKeys.length)throw new Error('Duplicate coverage review row');
  for (const i of value.impacts ?? []) if (typeof i.component !== 'string' || !i.component.trim() || !Array.isArray(i.sectionIds) || !i.sectionIds.every((s:unknown)=>typeof s === 'string') || !Array.isArray(i.scenarioIds) || !i.scenarioIds.every((s:unknown)=>typeof s === 'string') || (i.shared !== undefined && typeof i.shared !== 'boolean')) throw new Error('Invalid impact review');
  return value;
}
async function loadSource(captureRoot: string, outputDir: string, options: InventoryOptions): Promise<Source> {
  const root = await realpath(resolve(captureRoot));
  // Resolve the closest existing ancestor before creating output directories.
  let ancestor = resolve(outputDir);
  const suffix: string[] = [];
  for (;;) { try { ancestor = await realpath(ancestor); break; } catch (error:any) { if(error.code !== 'ENOENT') throw error; const parent = resolve(ancestor,'..'); if(parent===ancestor)throw error; suffix.unshift(relative(parent,ancestor)); ancestor=parent; } }
  const output = resolve(ancestor,...suffix);
  if (contained(root, output)) throw new Error('Derived inventory must be outside the immutable corpus');
  await mkdir(output, { recursive: true });
  const manifestBytes = await readFile(await sourcePath(root,'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.states) || !Array.isArray(manifest.resources) || !Array.isArray(manifest.evidence)) throw new Error('Unsupported capture manifest');
  if (manifest.corpusSha256 && manifest.corpusSha256 !== corpusHash(manifest)) throw new Error('Corpus manifest was modified');
  const review = options.reviewFile ? reviewConfig(JSON.parse(await readFile(resolve(options.reviewFile),'utf8'))) : {};
  const hashes = new Map<string,string>();
  const expected = new Map<string,string>();
  for (const r of [...manifest.evidence,...manifest.resources]) if(r.file && r.sha256) {
    if(expected.has(r.file) && expected.get(r.file)!==r.sha256)throw new Error(`Conflicting captured hash ${r.file}`);
    expected.set(r.file,r.sha256);
  }
  const files = new Set<string>();
  for(const r of [...manifest.evidence,...manifest.resources])if(r.file)files.add(r.file);
  for(const s of manifest.states)for(const key of ['snapshotFile','screenshotFile','domFile','assertionFile'] as const)if(s[key])files.add(s[key]);
  // Stream hashing bounds memory and detects changes even when a cached manifest is unchanged.
  for(const file of [...files].sort()) {
    const actual = await fileHash(await sourcePath(root,file));
    if(expected.has(file) && expected.get(file)!==actual)throw new Error(`Captured artifact hash mismatch ${file}`);
    hashes.set(file,actual);
  }
  const identity=hash(JSON.stringify({version:VERSION,manifest:hash(manifestBytes),files:[...hashes],review}));
  return {root,output,manifest,states:[],hashes,identity,review};
}
async function loadStates(source:Source) {
  for(const ref of source.manifest.states)source.states.push({ref,snapshot:JSON.parse(await readFile(await sourcePath(source.root,ref.snapshotFile),'utf8')),assertion:JSON.parse(await readFile(await sourcePath(source.root,ref.assertionFile),'utf8'))});
}
const sectionId = (selector:string) => `section-${hash(selector).slice(0,16)}`;
const isMember = (root:string,selector:string) => root===selector || selector.startsWith(root+' > ') || selector.startsWith(root+' >>> ');
function evidence(source:Source,file:string,nature:EvidenceLink['nature']='observed'):EvidenceLink { return {file,sha256:source.hashes.get(file)!,nature}; }
function candidateKind(e:ElementSnapshot):string|undefined {
  if(['header','main','section','footer','nav','aside','article'].includes(e.tag))return e.tag;
  const role=e.attributes.role;
  if(['banner','main','region','contentinfo','navigation','dialog','tablist','tabpanel','slider'].includes(role))return role;
  if(['dialog','details','video','audio','canvas','button','select','input','textarea'].includes(e.tag))return e.tag;
  if(e.tag==='a' && e.attributes.href)return 'link';
  if(['img','iframe'].includes(e.tag)&&(e.attributes.loading==='lazy'||e.attributes['data-src']))return 'lazy-media';
  if(/carousel/i.test(e.attributes['aria-roledescription']??''))return 'carousel-candidate';
  if(e.attributes['aria-expanded']!==undefined || e.attributes['aria-controls'])return 'control';
  return undefined;
}
function mechanisms(e:ElementSnapshot) {
  const m:string[]=[];
  if(['button','input','select','textarea'].includes(e.tag)||e.attributes['aria-expanded']!==undefined)m.push('interaction');
  if(e.attributes['aria-controls']||e.attributes['aria-expanded']!==undefined)m.push('expand-collapse');
  if(['video','audio','canvas'].includes(e.tag))m.push(e.tag);
  if(e.tag==='dialog'||e.attributes.role==='dialog')m.push('overlay');
  if(e.tag==='details')m.push('disclosure');
  if(e.attributes.role==='slider'||/carousel/i.test(e.attributes['aria-roledescription']??''))m.push('slider');
  if(e.tag==='a' && e.attributes.href)m.push('navigation');
  if(e.attributes.loading==='lazy'||e.attributes['data-src']||e.attributes['data-srcset'])m.push('lazy-resource');
  if(e.styles?.['animation-name'] && e.styles['animation-name']!=='none')m.push('animation');
  if(e.styles?.position==='sticky'||e.styles?.position==='fixed')m.push('scroll-position');
  return m;
}
function resolvedUrl(value:string,base:string):string|undefined { try {const u=new URL(value,base);if(!['http:','https:'].includes(u.protocol))return undefined;u.hash='';return u.href;}catch{return undefined;} }
function urlsInElement(e:ElementSnapshot,base:string) {
  const refs:{url:string;property:string}[]=[];
  const add=(value:string,property:string)=>{const url=resolvedUrl(value,base);if(url)refs.push({url,property});};
  for(const [key,value] of Object.entries(e.attributes??{})) {
    if(['src','href','poster','data-src'].includes(key))add(value,key);
    if(['srcset','data-srcset'].includes(key) && !value.includes('data:'))for(const part of value.split(','))add(part.trim().split(/\s+/)[0],key);
  }
  for(const [key,value] of Object.entries(e.styles??{}))for(const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))add(match[1],`computed:${key}`);
  return refs;
}
function playlist(r:Resource) { return /mpegurl/i.test(r.mime)||/\.m3u8(?:\?|$)/i.test(r.url); }
function partial(r:Resource) { return r.status===206 || Object.keys(r.headers??{}).some(k=>k.toLowerCase()==='content-range'); }
async function makeAssets(source:Source):Promise<AssetsMap> {
  const uses=new Map<string,AssetUse[]>();
  for(const {ref,snapshot} of source.states)for(const e of snapshot.elements)for(const item of urlsInElement(e,snapshot.url||source.manifest.targetUrl)) {
    const key=ref.viewportId+'\n'+item.url,list=uses.get(key)??[];
    list.push({viewportId:ref.viewportId,stateId:ref.stateId,selector:e.selector,property:item.property,nature:'observed'});uses.set(key,list);
  }
  const assets:AssetEntry[]=source.manifest.resources.map(r=>({url:r.url,viewportId:r.viewportId,file:r.file,sha256:r.file?source.hashes.get(r.file):r.sha256,mime:r.mime,status:r.status,replayable:r.replayable,...(r.substitution?{substitution:r.substitution}:{}),byteIdentity:r.file?source.hashes.get(r.file):undefined,partial:partial(r),uses:uses.get(r.viewportId+'\n'+r.url)??[],dependencies:[],recursiveDependencyStatus:playlist(r)?'incomplete':'not-a-playlist'}));
  const parsedByBytes=new Map<string,string[]>();
  for(let i=0;i<assets.length;i++) {
    const r=source.manifest.resources[i];if(!playlist(r)||!r.file)continue;
    const digest=assets[i].sha256!;
    let refs=parsedByBytes.get(digest);
    if(!refs) {
      // Do not parse unbounded media bodies; playlist omission is explicit in status.
      if((r.bytes??0)>2_000_000||(await stat(await sourcePath(source.root,r.file))).size>2_000_000)continue;
      const bytes=await readFile(await sourcePath(source.root,r.file));if(bytes.length>2_000_000)continue;
      const body=bytes.toString();if(!body.trimStart().startsWith('#EXTM3U'))continue;refs=[];
      for(const line of body.split(/\r?\n/)) {
        const text=line.trim();if(!text)continue;
        if(!text.startsWith('#'))refs.push(text);
        else for(const match of text.matchAll(/(?:^|[:,])URI=(?:"([^"]+)"|([^,\s]+))/g))refs.push(match[1]??match[2]);
      }
      parsedByBytes.set(digest,refs);
    }
    // Byte deduplication must never replace URL-relative resolution.
    assets[i].dependencies=[...new Set(refs.map(ref=>resolvedUrl(ref,r.url)??ref))].sort().map(url=>{
      const indices=assets.flatMap((a,j)=>a.url===url && a.viewportId===r.viewportId?[j]:[]);
      return {url,observed:indices.length>0,completeBytes:indices.some(j=>!!assets[j].file&&!assets[j].partial&&assets[j].replayable&&assets[j].status>=200&&assets[j].status<300),resourceIndices:indices};
    });
    assets[i].recursiveDependencyStatus='complete-observed-graph';
  }
  const complete=(i:number,visiting:Set<number>):boolean=>{
    const a=assets[i];if(!a.file||a.partial||!a.replayable||a.status<200||a.status>=300)return false;
    if(!playlist(source.manifest.resources[i]))return true;
    if(a.recursiveDependencyStatus==='incomplete')return false;
    if(visiting.has(i))return true;
    const next=new Set(visiting).add(i);
    return a.dependencies.every(d=>d.completeBytes&&d.resourceIndices.some(j=>complete(j,next)));
  };
  const statuses=assets.map((a,i)=>playlist(source.manifest.resources[i])?(complete(i,new Set())?'complete-observed-graph':'incomplete'):a.recursiveDependencyStatus);
  statuses.forEach((status,i)=>assets[i].recursiveDependencyStatus=status as AssetEntry['recursiveDependencyStatus']);
  const unresolvedUses=[...uses].flatMap(([key,list])=>{const split=key.indexOf('\n'),viewportId=key.slice(0,split),url=key.slice(split+1);return assets.some(a=>a.viewportId===viewportId&&a.url===url)?[]:[{url,viewportId,uses:list}];});
  return {schemaVersion:1,captureId:source.manifest.captureId,sourceIdentity:source.identity,corpusSha256:source.manifest.corpusSha256,assets,unresolvedUses,limitations:['Asset presence and dependency closure do not prove decoding, visibility or playback.','Partial responses remain partial; this index does not reconstruct byte ranges.','Usage comes from observed attributes and computed style URLs; dynamic JS, pseudo-elements and unobserved lazy states may add dependencies.','HLS graph includes only observed HTTP(S) dependencies, not complete playback of live streams; unsupported URI schemes, unobserved segments and playlists larger than 2 MB remain incomplete.','Unresolved observed URLs may include normal navigation links; they require classification before treating them as missing assets.']};
}
function makeInventory(source:Source):PageInventory {
  const map=new Map<string,InventorySection>();
  const reviewed=new Map((source.review.sections??[]).map(s=>[s.selector,s]));
  const scope=source.manifest.scope;
  const scenarios=source.manifest.config.scenarios.filter(s=>!scope||scope.measuredIds.includes(s.id));
  const viewports=source.manifest.config.viewports.filter(v=>!scope||scope.viewportIds.includes(v.id));
  for(const {ref,snapshot} of source.states)for(const e of snapshot.elements) {
    const review=reviewed.get(e.selector),kind=review?.kind??candidateKind(e);
    if(!kind&&!review)continue;
    let item=map.get(e.selector);
    if(!item) { item={id:sectionId(e.selector),selector:e.selector,kind:kind??'reviewed-section',label:review?.label??e.attributes['aria-label']??e.id??e.tag,nature:review?'observed':'hypothesized',grouping:review?'reviewed':'candidate',confidence:review?1:0.5,observations:[],mechanismCandidates:[]};map.set(e.selector,item); }
    item.mechanismCandidates=[...new Set([...item.mechanismCandidates,...mechanisms(e)])].sort();
    item.observations.push({viewportId:ref.viewportId,stateId:ref.stateId,elementId:e.elementId,visible:e.visible,box:e.box,snapshot:evidence(source,ref.snapshotFile),screenshot:evidence(source,ref.screenshotFile),assertion:evidence(source,ref.assertionFile),scenarioIds:scenarios.filter(s=>s.selector && isMember(e.selector,s.selector)).map(s=>s.id)});
  }
  // Pages without semantic sections still expose an explicit candidate.
  if(!map.size)for(const {ref,snapshot} of source.states) {
    const e=snapshot.elements.find(e=>e.tag==='body')??snapshot.elements[0];if(!e)continue;
    let item=map.get(e.selector);if(!item){item={id:sectionId(e.selector),selector:e.selector,kind:'page-candidate',label:'Page (requires grouping review)',nature:'hypothesized',grouping:'candidate',confidence:0.2,observations:[],mechanismCandidates:[]};map.set(e.selector,item);}
    item.observations.push({viewportId:ref.viewportId,stateId:ref.stateId,elementId:e.elementId,visible:e.visible,box:e.box,snapshot:evidence(source,ref.snapshotFile),screenshot:evidence(source,ref.screenshotFile),assertion:evidence(source,ref.assertionFile),scenarioIds:[]});
  }
  const sections=[...map.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const gaps:PageInventory['gaps']=[];
  if(scope)gaps.push({reason:'Selective Fusion evidence: complete page coverage is outside the acquisition scope',requiredAction:'Use Fusion contracts for selected patterns; acquire a complete baseline for Clone reconstruction.'});
  for(const {ref,snapshot} of source.states)if(snapshot.truncated)gaps.push({viewportId:ref.viewportId,stateId:ref.stateId,reason:`Snapshot truncated: ${snapshot.elements.length}/${snapshot.totalElements} elements`,requiredAction:'Capture or inspect omitted elements in a new coherent revision before claiming complete coverage.'});
  for(const r of reviewed.values())if(!map.has(r.selector))gaps.push({reason:`Reviewed selector not observed: ${r.selector}`,requiredAction:'Inspect the requested state or correct the selector.'});
  for(const vp of viewports) {
    const viewportStates=source.states.filter(s=>s.ref.viewportId===vp.id);
    for(const scenario of scenarios)if(!viewportStates.some(s=>s.ref.stateId===scenario.id))gaps.push({viewportId:vp.id,stateId:scenario.id,reason:'Configured capture state missing',requiredAction:'Capture the configured scenario in a coherent baseline revision.'});
    if(scope||!viewportStates.some(s=>s.snapshot.scroll.height>s.snapshot.viewport.height+1))continue;
    if(!viewportStates.some(s=>scenarios.find(c=>c.id===s.ref.stateId&&c.action==='scroll'&&c.progress===1)&&s.snapshot.scroll.y>=s.snapshot.scroll.height-s.snapshot.viewport.height-1))gaps.push({viewportId:vp.id,reason:'Bottom-page state not captured',requiredAction:'Observe bottom and lazy content; add a return-to-start scenario.'});
    const returns=scenarios.filter((s,i)=>s.action==='scroll'&&s.progress===0&&scenarios.slice(0,i).some(p=>p.action==='scroll'&&(p.progress??0)>0));
    if(!returns.length)gaps.push({viewportId:vp.id,reason:'Return-to-start after scroll not configured',requiredAction:'Observe restoration after reaching lower sections.'});
    else if(!viewportStates.some(s=>returns.some(r=>r.id===s.ref.stateId)&&s.snapshot.scroll.y<=1))gaps.push({viewportId:vp.id,reason:'Return-to-start state not captured',requiredAction:'Capture the configured return state and confirm scroll restoration.'});
  }
  const coverage:PageInventory['coverage']=[];
  for(const section of sections)for(const vp of viewports)for(const scenario of scenarios) {
    const observation=section.observations.find(o=>o.viewportId===vp.id&&o.stateId===scenario.id);
    const review=source.review.coverage?.find(c=>c.sectionId===section.id&&c.viewportId===vp.id&&c.stateId===scenario.id);
    if(review)for(const file of review.evidence)if(!source.hashes.has(file))throw new Error(`Coverage evidence is not part of this corpus: ${file}`);
    if(review?.status==='passed'&&!observation)throw new Error(`Cannot mark absent observation passed: ${section.id}/${vp.id}/${scenario.id}`);
    coverage.push({sectionId:section.id,viewportId:vp.id,stateId:scenario.id,observed:!!observation,status:review?.status??'not-verified',reason:review?.reason??(observation?'Observed snapshot; no explicit verification of section behavior.':'No section observation in this state; absence is not an automatic pass.'),evidence:review?.evidence??(observation?[observation.snapshot.file]:[]),origin:review?'review':'default'});
  }
  for(const c of source.review.coverage??[])if(!coverage.some(x=>x.sectionId===c.sectionId&&x.viewportId===c.viewportId&&x.stateId===c.stateId))throw new Error('Review references unknown section, viewport or scenario');
  for(const i of source.review.impacts??[])if(i.sectionIds.some(id=>!sections.some(s=>s.id===id))||i.scenarioIds.some(id=>!scenarios.some(s=>s.id===id)))throw new Error('Impact review references unknown section or scenario');
  return {schemaVersion:1,toolVersion:VERSION,captureId:source.manifest.captureId,sourceIdentity:source.identity,corpusSha256:source.manifest.corpusSha256,...(scope?{scope}:{}),viewportIds:viewports.map(v=>v.id),sections,coverage,scenarios:scenarios.map(s=>({id:s.id,action:s.action,selector:s.selector,prerequisiteIds:source.manifest.config.scenarios.slice(0,source.manifest.config.scenarios.findIndex(p=>p.id===s.id)).map(p=>p.id),precondition:s.precondition,expected:s.expect})),impacts:source.review.impacts??[],gaps,limitations:['Section grouping and mechanism recognition are candidates until reviewed.','Snapshot element IDs are local to each state; exact selectors do not prove cross-state identity after DOM reordering.','Visibility semantics depend on capture version: older corpora may omit opacity or ancestor checks. A visible flag never proves absence of occlusion or successful media rendering.','Candidate ancestry uses captured selector paths and can miss descendants whose own IDs reset that path. Dossiers additionally consult serialized DOM.','Coverage means explicit review of captured evidence; no generated row passes automatically.','Sequential scenario prefixes are conservative prerequisites until a reviewed independent scenario model exists.']};
}
function makeIndex(source:Source,inventory:PageInventory,assets:AssetsMap):ReconstructionIndex {
  const refs=(filter:(r:Resource)=>boolean)=>source.manifest.resources.filter(r=>r.file&&filter(r)).map(r=>({url:r.url,file:r.file!,sha256:source.hashes.get(r.file!),nature:'observed' as const}));
  return {schemaVersion:1,toolVersion:VERSION,captureId:source.manifest.captureId,sourceIdentity:source.identity,corpusSha256:source.manifest.corpusSha256,sections:inventory.sections.map(s=>({id:s.id,selector:s.selector,observations:s.observations.length,dossier:`dossiers/${s.id}.json`,assetIndices:assets.assets.flatMap((a,i)=>a.uses.some(u=>isMember(s.selector,u.selector))?[i]:[]),evidence:[...new Map(s.observations.flatMap(o=>[o.snapshot,o.screenshot,o.assertion]).map(e=>[e.file,e])).values()]})),sourceMaps:refs(r=>/\.map(?:\?|$)/.test(r.url)),scriptResources:refs(r=>r.type==='script'||/javascript/.test(r.mime)),cssResources:refs(r=>r.type==='stylesheet'||/text\/css/.test(r.mime)),limitations:['Dossiers are generated on demand, not eagerly.','Asset association by selector ancestry is a candidate relation; elements with independent IDs and runtime dependencies may be absent.','CSS and JS resources are references to original captured bytes, not a proven extractable subset.','No source maps are fetched speculatively; only observed resources are indexed.']};
}
async function cached(source:Source) {
  try {
    const record=JSON.parse(await readFile(join(source.output,'inventory-cache.json'),'utf8'));
    if(record.version!==VERSION||record.key!==source.identity||!record.artifacts||typeof record.artifacts!=='object')return undefined;
    const values:any[]=[];
    for(const file of OUTPUTS) {
      const path=await realpath(join(source.output,file));if(!contained(source.output,path))return undefined;
      const bytes=await readFile(path);if(hash(bytes)!==record.artifacts[file])return undefined;
      const value=JSON.parse(bytes.toString());if(value.schemaVersion!==1||value.sourceIdentity!==source.identity)return undefined;values.push(value);
    }
    if(!Array.isArray(values[0].sections)||!Array.isArray(values[0].coverage)||!Array.isArray(values[0].viewportIds)||!Array.isArray(values[1].sections)||!Array.isArray(values[2].assets))return undefined;
    return {inventory:values[0] as PageInventory,index:values[1] as ReconstructionIndex,assets:values[2] as AssetsMap};
  }catch{return undefined;}
}
export async function buildIndex(captureRoot:string,outputDir:string,options:InventoryOptions={}) {
  const source=await loadSource(captureRoot,outputDir,options);
  const hit=options.cache!==false?await cached(source):undefined;
  const files=OUTPUTS.map(file=>join(source.output,file));
  if(hit)return {...hit,cacheHit:true,files};
  await loadStates(source);
  const inventory=makeInventory(source),assets=await makeAssets(source),index=makeIndex(source,inventory,assets);
  for(const [i,value] of [inventory,index,assets].entries())await atomicJson(files[i],value);
  const artifacts:Record<string,string>={};for(const file of OUTPUTS)artifacts[file]=await fileHash(join(source.output,file));
  await atomicJson(join(source.output,'inventory-cache.json'),{version:VERSION,key:source.identity,artifacts});
  return {inventory,index,assets,cacheHit:false,files};
}

/** Coverage alone never attests a reconstructed build; this is one finalization gate. */
export function validateCoverage(inventory:PageInventory):{complete:boolean;failures:string[]} {
  const failures:string[]=[];
  if(inventory?.scope?.kind==='fusion-selective')failures.push('Selective Fusion inventory cannot attest complete Clone coverage.');
  if(!inventory||inventory.schemaVersion!==1||!Array.isArray(inventory.sections)||!Array.isArray(inventory.coverage)||!Array.isArray(inventory.scenarios)||!Array.isArray(inventory.viewportIds)||!Array.isArray(inventory.gaps))return {complete:false,failures:['Invalid or incomplete inventory schema.']};
  if(!inventory.captureId||!/^[a-f0-9]{64}$/.test(inventory.sourceIdentity??'')||!/^[a-f0-9]{64}$/.test(inventory.corpusSha256??''))failures.push('Inventory has no valid captured source identity.');
  if(!inventory.sections.length)failures.push('No reviewed sections.');
  if(!inventory.viewportIds.length)failures.push('No configured viewports.');
  if(!inventory.scenarios.length)failures.push('No configured scenarios.');
  const sections=new Map(inventory.sections.map(s=>[s.id,s])),viewports=new Set(inventory.viewportIds),scenarios=new Set(inventory.scenarios.map(s=>s.id));
  if(sections.size!==inventory.sections.length)failures.push('Duplicate section identity.');
  if(viewports.size!==inventory.viewportIds.length)failures.push('Duplicate viewport identity.');
  if(scenarios.size!==inventory.scenarios.length)failures.push('Duplicate scenario identity.');
  for(const gap of inventory.gaps)failures.push(`Unresolved inventory gap: ${gap.reason}`);
  const cells=new Map<string,PageInventory['coverage'][number]>();
  const key=(sectionId:string,viewportId:string,stateId:string)=>JSON.stringify([sectionId,viewportId,stateId]);
  for(const cell of inventory.coverage) {
    const identity=key(cell.sectionId,cell.viewportId,cell.stateId),label=`${cell.sectionId}/${cell.viewportId}/${cell.stateId}`;
    if(cells.has(identity))failures.push(`Duplicate coverage row: ${label}`);
    cells.set(identity,cell);
    if(!sections.has(cell.sectionId)||!viewports.has(cell.viewportId)||!scenarios.has(cell.stateId))failures.push(`Unknown coverage reference: ${label}`);
    if(!['passed','not-applicable'].includes(cell.status))failures.push(`Coverage ${cell.status}: ${label}`);
    if(cell.origin!=='review'||typeof cell.reason!=='string'||!cell.reason.trim()||!Array.isArray(cell.evidence)||!cell.evidence.length||cell.evidence.some(e=>typeof e!=='string'||!e.trim()))failures.push(`Missing explicit review reason or evidence: ${label}`);
    if(cell.status==='passed') {
      const observation=sections.get(cell.sectionId)?.observations?.find(o=>o.viewportId===cell.viewportId&&o.stateId===cell.stateId);
      if(!cell.observed||!observation)failures.push(`Passed coverage has no observed state: ${label}`);
      else {
        const links=[observation.snapshot,observation.screenshot,observation.assertion].filter(e=>e&&typeof e.file==='string'&&/^[a-f0-9]{64}$/.test(e.sha256??''));
        if(!Array.isArray(cell.evidence)||!cell.evidence.some(file=>links.some(link=>link.file===file)))failures.push(`Passed coverage lacks evidence from its own observed state: ${label}`);
      }
    }
  }
  for(const section of inventory.sections) {
    if(section.grouping!=='reviewed')failures.push(`Section grouping requires review: ${section.id}`);
    if(!inventory.coverage.some(c=>c.sectionId===section.id&&c.status==='passed'))failures.push(`Section has no passed verification: ${section.id}`);
    for(const viewportId of inventory.viewportIds)for(const scenario of inventory.scenarios)if(!cells.has(key(section.id,viewportId,scenario.id)))failures.push(`Missing coverage row: ${section.id}/${viewportId}/${scenario.id}`);
  }
  return {complete:failures.length===0,failures};
}

/** Plan a local verification only from an explicit reviewed component mapping. */
export function planImpact(inventory:PageInventory,components:string[]) {
  const mappings=components.map(c=>inventory.impacts.find(i=>i.component===c));
  const full=!components.length||mappings.some(m=>!m||m.shared)||components.some(c=>/font|global|layout|scroll|runtime/i.test(c));
  if(full)return {mode:'full' as const,scenarioIds:inventory.scenarios.map(s=>s.id),reason:'Unknown or shared impact requires the complete configured scenario sequence.'};
  const requested=new Set(mappings.flatMap(m=>m!.scenarioIds));
  for(const mapping of mappings)for(const id of mapping!.sectionIds) {
    const section=inventory.sections.find(s=>s.id===id)!;
    for(const o of section.observations)for(const id of o.scenarioIds)requested.add(id);
  }
  if(!requested.size)return {mode:'full' as const,scenarioIds:inventory.scenarios.map(s=>s.id),reason:'No reviewed scenario association; full coverage is required.'};
  const last=Math.max(...inventory.scenarios.flatMap((s,i)=>requested.has(s.id)?[i]:[]));
  return {mode:'targeted' as const,scenarioIds:inventory.scenarios.slice(0,last+1).map(s=>s.id),reason:'Reviewed component mapping, including every preceding action needed by the sequential capture protocol.'};
}

// CSS.escape equivalent for IDs used by the snapshot selector generator.
function escapeId(value:string) {
  let out='';for(let i=0;i<value.length;i++){const c=value.charCodeAt(i),ch=value[i];if(c===0){out+='\uFFFD';continue;}if((c>=1&&c<=31)||c===127||(i===0&&c>=48&&c<=57)||(i===1&&c>=48&&c<=57&&value[0]==='-')){out+='\\'+c.toString(16)+' ';continue;}if(i===0&&ch==='-'&&value.length===1){out+='\\-';continue;}out+=c>=128||ch==='-'||ch==='_'||/[a-zA-Z0-9]/.test(ch)?ch:'\\'+ch;}return out;
}
function domSections(html:string,selector:string) {
  const root:any=parse(html),matches:any[]=[];
  const walk=(node:any,parentSelector:string,ancestors:string[])=>{
    const children=(node.childNodes??[]).filter((n:any)=>n.tagName);
    children.forEach((child:any,i:number)=>{
      const id=child.attrs?.find((a:any)=>a.name==='id')?.value;
      const path=id?'#'+escapeId(id):parentSelector?`${parentSelector} > ${child.tagName}:nth-child(${i+1})`:child.tagName;
      if(path===selector)matches.push({node:child,path});
      walk(child,path,[...ancestors,path]);
      if(child.tagName==='template'&&child.content)walk(child.content,path,ancestors);
    });
  };walk(root,'',[]);
  return matches.map(({node}:any)=>{
    const ids=new Set<string>();const tags=new Set<string>();const classes=new Set<string>();
    const collect=(n:any)=>{if(n.tagName)tags.add(n.tagName);for(const a of n.attrs??[]){if(a.name==='id')ids.add(a.value);if(a.name==='class')for(const c of a.value.split(/\s+/))if(c)classes.add(c);}for(const c of n.childNodes??[])collect(c);if(n.content)collect(n.content);};collect(node);
    return {html:serializeOuter(node),ids,tags,classes};
  });
}
export async function sectionDossier(captureRoot:string,outputDir:string,id:string,options:InventoryOptions={}) {
  const built=await buildIndex(captureRoot,outputDir,options),section=built.inventory.sections.find(s=>s.id===id);
  if(!section)throw new Error(`Unknown section ${id}`);
  const root=await realpath(resolve(captureRoot)),output=await realpath(resolve(outputDir));
  const dossierDir=join(output,'dossiers');await mkdir(dossierDir,{recursive:true});
  if(!contained(output,await realpath(dossierDir)))throw new Error('Dossier directory escapes derived output');
  const file=join(dossierDir,`${id}.json`),cacheFile=join(dossierDir,`${id}.cache.json`);
  if(options.cache!==false)try {
    const meta=JSON.parse(await readFile(cacheFile,'utf8')),path=await realpath(file);
    if(contained(output,path)&&meta.version===VERSION&&meta.key===built.inventory.sourceIdentity) {
      const bytes=await readFile(path);
      if(meta.sha256===hash(bytes)) {const dossier=JSON.parse(bytes.toString());if(dossier.sourceIdentity===built.inventory.sourceIdentity&&dossier.section?.id===id)return {dossier,file,cacheHit:true};}
    }
  }catch{/* Missing or corrupt deterministic derivations are regenerated. */}
  const states:any[]=[];const tokens=new Set<string>();let cssOmitted=0;
  const assetIndices=new Set(built.index.sections.find(s=>s.id===id)!.assetIndices);
  for(const observation of section.observations) {
    const snapshot=JSON.parse(await readFile(await sourcePath(root,observation.snapshot.file),'utf8')) as Snapshot;
    const matches=domSections(snapshot.html,section.selector);
    const member=(e:ElementSnapshot)=>isMember(section.selector,e.selector)||matches.some(m=>[...m.ids].some(id=>isMember('#'+escapeId(id),e.selector)));
    const elements=snapshot.elements.filter(member),limited=elements.slice(0,250);
    for(const m of matches){for(const c of m.classes)tokens.add('.'+escapeId(c));for(const i of m.ids)tokens.add('#'+escapeId(i));}
    for(const e of elements){if(e.id)tokens.add('#'+escapeId(e.id));for(const c of (e.attributes.class??'').split(/\s+/))if(c)tokens.add('.'+escapeId(c));}
    for(const [i,a] of built.assets.assets.entries())if(a.uses.some(u=>u.viewportId===observation.viewportId&&u.stateId===observation.stateId&&elements.some(e=>e.selector===u.selector)))assetIndices.add(i);
    const ruleCandidates:any[]=[];
    for(const sheet of snapshot.css as any[])for(const [ruleIndex,r] of (sheet.rules??[]).entries()) {
      const text=String(r.text??'');const selectorText=text.slice(0,text.indexOf('{')<0?text.length:text.indexOf('{'));
      const candidate=[...tokens].some(t=>selectorText.includes(t))||elements.some(e=>new RegExp(`(^|[\\s,>+~])${e.tag}(?=[\\s,.#:{>+~]|$)`).test(selectorText))||/@(?:font-face|keyframes|property)|:root/.test(selectorText);
      if(!candidate)continue;
      if(ruleCandidates.length>=80){cssOmitted++;continue;}
      ruleCandidates.push({sheetUrl:sheet.href??null,ruleIndex,text:text.slice(0,12_000),truncated:text.length>12_000,media:r.media,nature:'hypothesized',reason:'Textual selector/shared-rule candidate, not proof of matching or extraction safety.'});
    }
    states.push({viewportId:observation.viewportId,stateId:observation.stateId,snapshot:observation.snapshot,screenshot:observation.screenshot,assertion:observation.assertion,dom:matches.slice(0,3).map(m=>({html:m.html.slice(0,32_000),truncated:m.html.length>32_000})),domAmbiguous:matches.length!==1,elements:limited.map(e=>({selector:e.selector,tag:e.tag,text:e.text.slice(0,500),attributes:e.attributes,box:e.box,visibleFlag:e.visible,styles:e.styles,before:e.before,after:e.after,fonts:Object.fromEntries(Object.entries(e.styles).filter(([k])=>/font|line-height|letter-spacing/.test(k)))})),elementsOmitted:Math.max(0,elements.length-limited.length),snapshotTruncated:snapshot.truncated,fontFaceSet:snapshot.fonts,animations:snapshot.animations.filter(a=>a.target&&elements.some(e=>e.selector===a.target)),cssCandidates:ruleCandidates});
  }
  const js:any[]=[];const sourceMaps:any[]=[];let scanBudget=4_000_000;let resourceOmitted=0;
  const needles=[...tokens].map(t=>t.slice(1)).filter(t=>t.length>=3).slice(0,80);
  // Maps first; indexing uses only captured bytes and never fetches new files.
  for(const resource of [...built.index.sourceMaps,...built.index.scriptResources]) {
    const path=await sourcePath(root,resource.file);
    const size=(await stat(path)).size;if(size>scanBudget||size>2_000_000){resourceOmitted++;continue;}
    const bytes=await readFile(path);scanBudget-=bytes.length;
    if(built.index.sourceMaps.includes(resource)) {
      try{const map=JSON.parse(bytes.toString());sourceMaps.push({...resource,sourceRoot:map.sourceRoot,sources:Array.isArray(map.sources)?map.sources.slice(0,200):[],names:Array.isArray(map.names)?map.names.slice(0,200):[],sourcesOmitted:Math.max(0,(map.sources?.length??0)-200),sourcesContentPresent:Array.isArray(map.sourcesContent),nature:'observed',association:'Unassigned captured source map; section association requires review.'});}catch{sourceMaps.push({...resource,error:'Captured map is not readable JSON'});}
    }else {
      const body=bytes.toString(),hits:any[]=[];
      for(const needle of needles){const offset=body.indexOf(needle);if(offset>=0)hits.push({needle,offset,excerpt:body.slice(Math.max(0,offset-160),offset+Math.min(needle.length,100)+240),nature:'hypothesized'});if(hits.length>=12)break;}
      js.push({...resource,candidateReferences:hits,symbolCandidates:[...body.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)].slice(0,80).map(m=>m[1]),association:hits.length?'Textual identifier match; behavior association requires analysis.':'No bounded textual identifier match; resource may still be required.'});
    }
  }
  const dossier={schemaVersion:1,toolVersion:VERSION,captureId:built.inventory.captureId,sourceIdentity:built.inventory.sourceIdentity,corpusSha256:built.inventory.corpusSha256,section,states,assets:[...assetIndices].sort((a,b)=>a-b).map(i=>built.assets.assets[i]),unresolvedAssetUses:built.assets.unresolvedUses.filter(a=>a.uses.some(u=>isMember(section.selector,u.selector))),sourceMaps,jsResources:js,limits:{maxElementsPerState:250,maxDomCharactersPerMatch:32_000,maxCssCandidatesPerState:80,cssCandidatesOmitted:cssOmitted,maxScriptBytes:4_000_000,scriptResourcesOmitted:resourceOmitted},limitations:['CSS candidates are not a safe stylesheet subset: cascade, variables, pseudo-elements, nested rules, media queries and shared sheets require review.','JS symbol and identifier matches are candidates, not executed call-graph evidence.','Source-map contents are summarized; originals remain available through hashed references.','DOM snippets and elements are bounded; omitted content and truncated captures must be inspected before claiming coverage.','Full-page state screenshots are evidence links; no new browser capture or AI call is performed.','Derived indices are reproducible and disposable; they never modify the approved corpus.']};
  await atomicJson(file,dossier);
  await atomicJson(cacheFile,{version:VERSION,key:built.inventory.sourceIdentity,sha256:await fileHash(file)});
  return {dossier,file,cacheHit:false};
}
