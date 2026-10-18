import { z } from 'zod';

export const MODULES = ['D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','D11','D12','D13','D14','D15','D16'] as const;
export const EvidenceSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), kind: z.enum(MODULES),
  captureId: z.string(), pageId: z.literal('home'), stateId: z.string(), viewportId: z.string(),
  source: z.object({ url: z.string().optional(), selector: z.string().optional(), repositoryAdapter: z.string().optional(), method: z.string() }),
  timestampIso: z.iso.datetime(), status: z.enum(['captured','unavailable','unsupported','failed','inferred']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), file: z.string().optional(), error: z.string().optional()
}).superRefine((r,c) => { if (r.status === 'captured' && (!r.file || !r.sha256)) c.addIssue({ code:'custom', message:'captured requires file and SHA256' }); });
export type EvidenceRecord = z.infer<typeof EvidenceSchema>;
export interface Viewport { id: string; width: number; height: number }
export interface ScenarioExpectation {
  selector?: string; attribute?: string; value?: string; visible?: boolean; text?: string;
  visuallyVisible?: boolean; scrollChanged?: boolean; minScrollDelta?: number;
  mediaReady?: boolean; videoPlaying?: boolean;
}
export interface Scenario {
  id: string; action: 'time'|'scroll'|'hover'|'click'|'focus'|'key'|'wheel'|'swipe'|'resize'; atMs?: number; progress?: number;
  selector?: string; key?: string; waitMs?: number; deltaX?: number; deltaY?: number;
  from?: {x:number;y:number}; to?: {x:number;y:number}; steps?: number; width?: number; height?: number;
  dependsOn?: string[]; sections?: string[]; sharedSystems?: string[];
  expect?: ScenarioExpectation; precondition?: ScenarioExpectation;
}
export interface ReadinessConfig {
  selectors?: string[]; fonts?: boolean; images?: boolean;
  stableMs?: number; pollMs?: number; timeoutMs?: number; fallback?: 'fixed'|'fail';
}
export interface CaptureConfig {
  captureMediaCache?: boolean;
  mediaMode?: 'original'|'placeholders';
  mediaPlaceholders?: { preserveUrls?:string[]; imageDimensions?:Record<string,{width:number;height:number}> };
  viewports: Viewport[]; settleMs: number; timeoutMs: number; readySelector?: string;
  maxElements: number; maxBodyBytes: number; locale: string; timezoneId: string;
  reducedMotion: 'reduce'|'no-preference'; colorScheme: 'light'|'dark';
  motionProtocol: 'waapi-seek'|'natural-sampled'; scenarios: Scenario[]; allowedHosts: string[];
  ownershipAuthorization?: { source: string; statement: string; recordedAt: string };
  assetDiscovery?: boolean;
  readiness?: ReadinessConfig;
  selective?: { schemaVersion:1; purpose:'fusion'; selectors:string[]; viewportIds:string[]; scenarioIds:string[] };
}
const ExpectationSchema=z.object({selector:z.string().optional(),attribute:z.string().optional(),value:z.string().optional(),visible:z.boolean().optional(),text:z.string().optional(),visuallyVisible:z.boolean().optional(),scrollChanged:z.boolean().optional(),minScrollDelta:z.number().nonnegative().optional(),mediaReady:z.boolean().optional(),videoPlaying:z.boolean().optional()}).refine(e=>!!e.selector||(e.scrollChanged!==undefined&&e.attribute===undefined&&e.text===undefined&&e.visible===undefined&&e.visuallyVisible===undefined&&e.mediaReady===undefined&&e.videoPlaying===undefined),{message:'Element expectations require a selector'});
const PointSchema=z.object({x:z.number().finite(),y:z.number().finite()});
const IdentifierSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,'Use a stable ID without path separators');
export const ScenarioSchema=z.object({
  id:IdentifierSchema,action:z.enum(['time','scroll','hover','click','focus','key','wheel','swipe','resize']),atMs:z.number().nonnegative().optional(),progress:z.number().min(0).max(1).optional(),selector:z.string().optional(),key:z.string().optional(),waitMs:z.number().nonnegative().optional(),
  deltaX:z.number().finite().optional(),deltaY:z.number().finite().optional(),from:PointSchema.optional(),to:PointSchema.optional(),steps:z.number().int().min(1).max(120).optional(),width:z.number().int().positive().optional(),height:z.number().int().positive().optional(),
  dependsOn:z.array(z.string()).optional(),sections:z.array(z.string()).optional(),sharedSystems:z.array(z.string()).optional(),expect:ExpectationSchema.optional(),precondition:ExpectationSchema.optional()
}).superRefine((s,c)=>{
  if(s.precondition&&(s.precondition.scrollChanged!==undefined||s.precondition.videoPlaying!==undefined))c.addIssue({code:'custom',message:'Movement/playback checks require an action interval; use expect, not precondition'});
  if(s.action==='resize'&&(!s.width||!s.height))c.addIssue({code:'custom',message:'resize requires width and height'});
  if(s.action==='swipe'&&(!s.from||!s.to))c.addIssue({code:'custom',message:'swipe requires from and to'});
});
export const ConfigSchema = z.object({
  viewports: z.array(z.object({ id:IdentifierSchema, width:z.number().int().positive(), height:z.number().int().positive() })).min(1),
  settleMs:z.number().nonnegative(), timeoutMs:z.number().positive(), readySelector:z.string().optional(),
  maxElements:z.number().int().positive(), maxBodyBytes:z.number().int().positive(), locale:z.string(), timezoneId:z.string(),
  reducedMotion:z.enum(['reduce','no-preference']),colorScheme:z.enum(['light','dark']),motionProtocol:z.enum(['waapi-seek','natural-sampled']),
  ownershipAuthorization:z.object({source:z.string(),statement:z.string(),recordedAt:z.iso.datetime()}).optional(),
  assetDiscovery:z.boolean().optional(),
  captureMediaCache:z.boolean().optional(),
  mediaMode:z.enum(['original','placeholders']).default('original'),
  mediaPlaceholders:z.object({preserveUrls:z.array(z.url()).optional(),imageDimensions:z.record(z.string(),z.object({width:z.number().int().positive().max(16384),height:z.number().int().positive().max(16384)})).optional()}).strict().optional(),
  readiness:z.object({selectors:z.array(z.string()).min(1).optional(),fonts:z.boolean().optional(),images:z.boolean().optional(),stableMs:z.number().nonnegative().optional(),pollMs:z.number().positive().optional(),timeoutMs:z.number().positive().optional(),fallback:z.enum(['fixed','fail']).optional()}).optional(),
  allowedHosts:z.array(z.string()), scenarios:z.array(ScenarioSchema).min(1),
  selective:z.object({schemaVersion:z.literal(1),purpose:z.literal('fusion'),selectors:z.array(z.string().min(1)).min(1),viewportIds:z.array(IdentifierSchema).min(1),scenarioIds:z.array(IdentifierSchema).min(1)}).strict().optional()
});
export interface Resource {
  captureSource?: 'same-context-media-cache';
  substitution?: {kind:'image'|'video';originalBodyDownloaded:false;dimensionsSource:'configured'|'markup'|'fallback'|'shared-video';width:number;height:number;limitations:string[]};
  viewportId:string;
  url:string; method:string; type:string; mime:string; status:number; headers:Record<string,string>;
  file?:string; sha256?:string; bytes?:number; error?:string; replayable:boolean;
}
export interface StateRef { viewportId:string; stateId:string; snapshotFile:string; screenshotFile:string; domFile:string; assertionFile:string }
export interface Manifest {
  schemaVersion:1; captureId:string; status:'complete'|'blocked'; targetUrl:string; createdAt:string;
  config:CaptureConfig; environment:Record<string,unknown>; evidence:EvidenceRecord[]; resources:Resource[];
  states:StateRef[]; errors:string[]; policy?:Record<string,unknown>; corpusSha256?:string;
  scope?: { kind:'fusion-selective'; selectors:string[]; viewportIds:string[]; measuredIds:string[]; setupIds:string[]; network:'runtime-required-resources' };
}
export interface ElementSnapshot {
  elementId:string; selector:string; tag:string; id:string; testId:string; text:string;
  attributes:Record<string,string>; box:{x:number;y:number;width:number;height:number;pageX:number;pageY:number};
  rects:{x:number;y:number;width:number;height:number}[]; visible:boolean;
  inViewport?:boolean; effectiveOpacity?:number; visibilityLimitations?:string[];
  styles:Record<string,string>; before:Record<string,string>|null; after:Record<string,string>|null;
  textRects:{x:number;y:number;width:number;height:number}[];
}
export interface Snapshot {
  url:string; timestampIso:string; browserTimeMs:number; scroll:{x:number;y:number;width:number;height:number};
  viewport:{width:number;height:number;dpr:number}; totalElements:number; truncated:boolean;
  elements:ElementSnapshot[]; html:string; shadows:unknown[]; frames:unknown[]; css:unknown[];
  media?:MediaObservation[]; limitations?:string[];
  fonts:unknown[]; animations:any[]; canvases:any[]; session:unknown; runtime:Record<string,unknown>;
  scope?: { kind:'fusion-selective'; selectors:string[]; ancestorSelectors:string[]; sharedContext:string[] };
}

export interface MediaObservation {
  selector:string; tag:string; source:string; visible:boolean; inViewport:boolean;
  ready:boolean; decoded?:'not-observed'; complete?:boolean; naturalWidth?:number; naturalHeight?:number;
  readyState?:number; currentTime?:number; paused?:boolean; ended?:boolean; error?:string;
}
