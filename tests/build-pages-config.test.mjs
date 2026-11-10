import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('national Pages deployment overrides the action default ten-minute timeout', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  const actionTimeout = Number(deploy.match(/\n\s+timeout:\s*(\d+)/)?.[1]);
  const jobMinutes = Number(deploy.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  assert(actionTimeout >= 1800000, 'large metadata site needs at least thirty minutes for deployment');
  assert(actionTimeout < jobMinutes * 60000, 'action timeout must fit within the deploy job');
  assert.match(deploy, /uses: actions\/deploy-pages@v4[\s\S]*with:[\s\S]*timeout:/);
});
