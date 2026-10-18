import type { ElementSnapshot } from './core/schema.js';

/** Preserve the former first-match semantics even when a selector/tag occurs twice. */
export function changedSelectors(previous:ElementSnapshot[],current:ElementSnapshot[]) {
  const index=new Map<string,ElementSnapshot>();
  const key=(e:ElementSnapshot)=>JSON.stringify([e.selector,e.tag]);
  for(const element of previous)if(!index.has(key(element)))index.set(key(element),element);
  return current.filter(element=>{
    const before=index.get(key(element));
    return !before||JSON.stringify([before.attributes,before.styles,before.box])!==JSON.stringify([element.attributes,element.styles,element.box]);
  }).map(element=>element.selector);
}
