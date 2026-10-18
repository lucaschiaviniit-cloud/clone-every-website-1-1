import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectScenarios } from '../../src/evaluate/selection.js';
import type { Scenario } from '../../src/core/schema.js';

const scenarios:Scenario[]=[{id:'load',action:'time'},{id:'open',action:'click',selector:'#toggle',sections:['menu']},{id:'close',action:'click',selector:'#toggle',dependsOn:['open'],sections:['menu']},{id:'footer',action:'scroll',progress:1,sections:['footer']}];
test('Targeted checkpoints preserve the sequential setup, and unknown/global impact expands',()=>{
  const result=selectScenarios(scenarios,{mode:'targeted',impactKnown:true,scenarioIds:['close']});
  assert.deepEqual(result.measuredIds,['close']);assert.deepEqual(result.setupIds,['load','open']);assert.equal(result.fullCoverage,false);
  assert.deepEqual(selectScenarios(scenarios,{mode:'targeted',scenarioIds:['close']}).measuredIds,scenarios.map(s=>s.id));
  assert.equal(selectScenarios(scenarios,{mode:'targeted',impactKnown:true,sharedSystems:['fonts'],scenarioIds:['close']}).fullCoverage,true);
  assert.equal(selectScenarios(scenarios,{mode:'targeted',impactKnown:true,changedSections:['unknown']}).fullCoverage,true);
});
test('Selection rejects missing IDs and forward dependencies instead of silently skipping them',()=>{
  assert.throws(()=>selectScenarios(scenarios,{mode:'targeted',scenarioIds:['missing']}),/Unknown/);
  assert.throws(()=>selectScenarios([{id:'x',action:'time',dependsOn:['y']},{id:'y',action:'time'}]),/dependency/);
});
