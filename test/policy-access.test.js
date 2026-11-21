// Ключ и адрес сервера политик агента (src/core.js): адрес из сборки — когда
// касса его не присылала; пустой ключ — демо; присланное кассой — главнее.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('oPolicyAccess: адрес из сборки без кассы; ключ со страницы и пустой ключ', async () => {
  const sDir = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  const sWas = process.env.KKT_AGENT_DATA;
  process.env.KKT_AGENT_DATA = sDir;
  delete process.env.KKT_AGENT_POLICY_URL;
  try {
    const { fConfigureCore, oPolicyAccess, oPutPolicyAccess } = await import('../src/core.js');
    fConfigureCore({ fLog() {}, sPolicyUrl: 'https://srv.example/api/policy/lease' });
    assert.deepEqual(oPolicyAccess(), { license: '', policyUrl: 'https://srv.example/api/policy/lease' });
    // Ключ со страницы агента — адрес остаётся из сборки.
    assert.deepEqual(oPutPolicyAccess({ license: ' lic_ABCDEFGH ' }), { license: '…EFGH', policyUrl: 'https://srv.example/api/policy/lease' });
    assert.equal(oPolicyAccess().license, 'lic_ABCDEFGH');
    // Касса прислала свой адрес — он главнее.
    oPutPolicyAccess({ license: 'lic_ABCDEFGH', policyUrl: 'https://dev.example/api/policy/lease' });
    assert.equal(oPolicyAccess().policyUrl, 'https://dev.example/api/policy/lease');
    // Убрать ключ — демо.
    assert.equal(oPutPolicyAccess({ license: '' }).license, '');
    assert.equal(oPolicyAccess().license, '');
  } finally {
    if (sWas === undefined) delete process.env.KKT_AGENT_DATA; else process.env.KKT_AGENT_DATA = sWas;
    rmSync(sDir, { recursive: true, force: true });
  }
});
