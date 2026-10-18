// Header policy ported from webEmbedding har_replay.py at the audited commit.
// Copyright (c) 2026 Jongho, MIT. See licenses/webEmbedding-LICENSE.
const HOP_BY_HOP = new Set(['connection','content-encoding','content-length','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
export const sensitiveName = /authorization|cookie|password|passwd|token|secret|session|api[_-]?key|access[_-]?key|email/i;
export function safeHeaders(headers:Record<string,string>,replay=false) {
  return Object.fromEntries(Object.entries(headers).filter(([name])=>!sensitiveName.test(name)&&(!replay||!HOP_BY_HOP.has(name.toLowerCase()))));
}
export function publicUrl(raw:string):string {
  try { const u=new URL(raw);u.username='';u.password='';for(const k of u.searchParams.keys()) if(sensitiveName.test(k)) u.searchParams.set(k,'[REDACTED]');return u.href; } catch { return '[invalid URL]'; }
}
export function normalizeUrl(raw:string) { const u=new URL(raw);u.hash='';return u.href; } // preserve query order and values: no speculative equivalence
