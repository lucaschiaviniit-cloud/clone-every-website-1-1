import type { Scenario } from '../core/schema.js';

export interface SelectionOptions {
  mode?: 'full'|'targeted'|'smoke';
  scenarioIds?: string[];
  changedSections?: string[];
  sharedSystems?: string[];
  impactKnown?: boolean;
}

/** Earlier actions remain setup: configured scenarios are a sequential session. */
export function selectScenarios(scenarios:Scenario[],options:SelectionOptions={}) {
  const mode=options.mode??'full',ids=scenarios.map(s=>s.id);
  if(new Set(ids).size!==ids.length)throw new Error('Scenario IDs must be unique');
  for(const s of scenarios)for(const dependency of s.dependsOn??[]) {
    if(!ids.includes(dependency)||ids.indexOf(dependency)>=ids.indexOf(s.id))throw new Error(`Invalid scenario dependency ${s.id}: ${dependency}`);
  }
  for(const id of options.scenarioIds??[])if(!ids.includes(id))throw new Error(`Unknown scenario ${id}`);
  const globalSystems=['fonts','global-css','layout','scroll','runtime'];
  const forceFull=mode==='full'||(mode==='targeted'&&(!options.impactKnown||(options.sharedSystems??[]).some(s=>globalSystems.includes(s))));
  let selected:Scenario[];
  if(forceFull)selected=scenarios;
  else if(options.scenarioIds?.length)selected=scenarios.filter(s=>options.scenarioIds!.includes(s.id));
  else if(mode==='targeted') {
    selected=scenarios.filter(s=>(s.sections??[]).some(x=>options.changedSections?.includes(x))||(s.sharedSystems??[]).some(x=>options.sharedSystems?.includes(x)));
    // No proven impact mapping must never silently turn into an empty check.
    if(!selected.length)selected=scenarios;
  }else {
    // Preserve open/close/re-entry and post-overlay real-input checks as a group.
    selected=scenarios.filter((s,i)=>i===0||['click','wheel','swipe','resize','key','focus','hover'].includes(s.action));
  }
  const measured=new Set(selected.map(s=>s.id)),last=Math.max(-1,...selected.map(s=>ids.indexOf(s.id)));
  return {
    requestedMode:mode,
    effectiveMode:forceFull||selected.length===scenarios.length?'full':mode,
    measuredIds:[...measured],
    setupIds:scenarios.slice(0,last+1).filter(s=>!measured.has(s.id)).map(s=>s.id),
    actions:scenarios.slice(0,last+1),
    fullCoverage:selected.length===scenarios.length,
    reason:forceFull&&mode!=='full'?'Unknown or shared impact: expanded to full coverage':'Sequential prerequisites replayed before selected checkpoints',
  };
}
