import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('national Pages deployment overrides the action default ten-minute timeout', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  const actionTimeout = Number(deploy.match(/\n\s+timeout:\s*(\d+)/)?.[1]);
  const jobMinutes = Number(deploy.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  assert.equal(actionTimeout, 600000, 'deploy-pages cannot exceed the documented 10-minute limit');
  assert(actionTimeout < jobMinutes * 60000, 'action timeout must fit within the deploy job');
  assert.match(deploy, /uses: actions\/deploy-pages@v4[\s\S]*with:[\s\S]*timeout:/);
});

test('checked-in Pages policy cannot serve conventional domestic batches or separate overseas collections', async () => {
  const readJson = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
  const [config, canonical, workflow] = await Promise.all([
    readJson('../config/pages-publication.json'), readJson('../data/catalog.json'),
    readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8'),
  ]);
  const cities = new Map(canonical.collections.map(city => [city.id, city]));
  assert.equal(config.domesticSupplementOnly, true);
  assert(!config.cities.includes('all'));
  assert(config.cities.includes('371600'), 'Existing Binzhou hidden coverage must remain selected');
  assert(config.cities.every(id => cities.has(id)));
  assert.equal(config.overseasSourceCities.length, 28);
  assert.equal(new Set(config.overseasSourceCities).size, 28);
  assert(config.overseasSourceCities.includes('191001'));
  assert(config.overseasSourceCities.every(id => !config.cities.includes(id)));
  assert.equal(config.overseasSourceCities.reduce((sum, id) => sum + cities.get(id).count, 0), 97);
  assert.match(workflow, /browser_data_check\.mjs[^\n]*--require-pages --city 191001/);
});
