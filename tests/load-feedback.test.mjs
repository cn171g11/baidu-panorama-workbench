import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadFeedback } from '../city-viewer/js/load-feedback.js';

function fixture(t) {
  const nodes = new Map();
  const ids = ['map','loading-overlay','loading-title','loading-progress','loading-detail','loading-bar','loading-cancel','loading-retry','loading-close'];
  for (const id of ids) nodes.set(id, { hidden: true, textContent: '', dataset: {}, value: 0, setAttribute(key,value){this[key]=value;}, removeAttribute(key){delete this[key];} });
  const history = [], feedback = createLoadFeedback({ getElementById: id => nodes.get(id) }, {onChange:state=>history.push(state)});
  t.after(()=>feedback.cancel());
  return {feedback,nodes,history};
}

test('both kinds of load start visible and completing street does not hide a pending blue transfer', t => {
  const {feedback,nodes}=fixture(t);
  const blue=feedback.start('blue','山西省 · 小蓝点'),street=feedback.start('street','滨州市 · 街景');
  assert.equal(nodes.get('loading-overlay').hidden,false);
  assert.equal(nodes.get('loading-title').textContent,'滨州市 · 街景');
  assert.match(nodes.get('loading-detail').textContent,/山西省/);
  feedback.finish(street);
  assert.equal(nodes.get('loading-overlay').hidden,false);
  assert.equal(nodes.get('loading-title').textContent,'山西省 · 小蓝点');
  assert.equal(nodes.get('map')['aria-busy'],'true');
  feedback.finish(blue);
  assert.equal(nodes.get('loading-overlay').hidden,true);
  assert.equal(nodes.get('map')['aria-busy'],'false');
});

test('stale finish/error/progress cannot replace the panel after a rapid same-kind selection', t => {
  const {feedback,nodes}=fixture(t);
  const previous=feedback.start('blue','old'),current=feedback.start('blue','new');
  feedback.update(previous,{message:'stale progress',fraction:.9});
  feedback.fail(previous,Error('stale error'));feedback.finish(previous);
  assert.equal(nodes.get('loading-title').textContent,'new');
  assert.equal(nodes.get('loading-overlay').hidden,false);
  feedback.update(current,{message:'real transfer',phase:'download',verifiedRows:3,filesDone:1,filesTotal:2,fraction:.5});
  assert.equal(nodes.get('loading-bar').value,.5);
  assert.equal(feedback.getState().pending[0].verifiedRows,3);
});

test('no invented percentage while waiting; valid byte/verified progress caps below complete until finish', t => {
  const {feedback,nodes}=fixture(t);
  const token=feedback.start('street','test');
  assert.equal(Object.hasOwn(nodes.get('loading-bar'),'value'),false);
  feedback.update(token,{fraction:1,message:'validated, painting'});
  assert.equal(nodes.get('loading-bar').value,.99);
  feedback.finish(token);assert.equal(nodes.get('loading-overlay').hidden,true);
});

test('failed load remains visible with retry and close, not an eight-second ephemeral toast', t => {
  const {feedback,nodes}=fixture(t);let retries=0;
  const token=feedback.start('street','test',{retry:()=>retries++});
  feedback.fail(token,Error('HTTP 500'));
  assert.equal(nodes.get('loading-overlay').dataset.state,'error');
  assert.equal(nodes.get('loading-overlay').hidden,false);
  assert.equal(nodes.get('loading-retry').hidden,false);
  assert.equal(nodes.get('loading-cancel').hidden,true);
  assert.match(nodes.get('loading-progress').textContent,/500/);
  assert.equal(feedback.getState().pending.length,0);
  feedback.retry();assert.equal(retries,1);assert.equal(nodes.get('loading-overlay').hidden,true);
});

test('cancel closes only selected tasks; cancelled completions do not revive a panel', t => {
  const {feedback,nodes}=fixture(t);let aborted=0;
  const street=feedback.start('street','street',{cancel:()=>aborted++});
  const blue=feedback.start('blue','blue',{cancel:()=>aborted++});
  feedback.cancel('street');assert.equal(aborted,1);assert.equal(nodes.get('loading-overlay').hidden,false);
  feedback.fail(street,Error('late'));assert.equal(feedback.getState().error,null);
  feedback.cancel();assert.equal(aborted,2);assert.equal(nodes.get('loading-overlay').hidden,true);
  feedback.finish(blue);assert.equal(nodes.get('loading-overlay').hidden,true);
});
