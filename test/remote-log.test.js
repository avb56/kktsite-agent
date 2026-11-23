// Журнал агента на сервер kktsite (src/remote-log.js): что уходит, куда, с чем.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KKT_AGENT_DATA = mkdtempSync(join(tmpdir(), 'kkt-agent-rlog-'));
const { fConfigureRemoteLog, fRemoteLog, pFlush, sLogUrl, fResetRemoteLog, sMaskText } = await import('../src/remote-log.js');
const { fSetDebug } = await import('../src/debug.js');

test('адрес приёма — у сервера политик', () => {
  assert.equal(sLogUrl('https://srv.kktsite.ru/api/policy/lease'), 'https://srv.kktsite.ru/api/log');
  assert.equal(sLogUrl(''), '');
});

test('предупреждения и ошибки — всегда, обычное — только с отладкой; ключ — в заголовке', async () => {
  fResetRemoteLog();
  const aSent = [];
  let nStatus = 201;
  let sKey = '';
  fConfigureRemoteLog({
    sVersion: '9.9.9',
    fAccess: () => ({ license: sKey, policyUrl: 'https://srv.test/api/policy/lease' }),
    fFetch: async (sUrl, o) => { aSent.push({ sUrl, o, oBody: JSON.parse(o.body) }); return { status: nStatus }; },
  });
  fSetDebug(false);
  fRemoteLog('info', 'обычное');
  fRemoteLog('warn', 'предупреждение');
  fRemoteLog('error', 'ошибка');
  assert.equal(await pFlush(), false, 'ключа нет — ждём');
  assert.equal(aSent.length, 0);
  assert.match(readFileSync(join(process.env.KKT_AGENT_DATA, 'remote-log.json'), 'utf8'), /предупреждение/, 'очередь — в файле');

  sKey = 'lic_testtesttest';
  fSetDebug(true);
  fRemoteLog('info', 'обычное с отладкой');
  nStatus = 503;
  assert.equal(await pFlush(), false, 'сервер недоступен — записи остаются');
  nStatus = 201;
  assert.equal(await pFlush(), true);
  const oLast = aSent.at(-1);
  assert.equal(oLast.sUrl, 'https://srv.test/api/log');
  assert.equal(oLast.o.headers.Authorization, 'License lic_testtesttest');
  assert.deepEqual(oLast.oBody.entries.map((o) => [o.lvl, o.txt]), [['warn', 'предупреждение'], ['error', 'ошибка'], ['info', 'обычное с отладкой']]);
  assert.equal(oLast.oBody.entries[0].ver, 'agent-9.9.9');
  assert.ok(oLast.oBody.entries[0].did && oLast.oBody.entries[0].sid);
  assert.equal(await pFlush(), true, 'пусто — нечего слать');
  fSetDebug(false);
});

test('персональные данные — [ПД] до отправки', () => {
  assert.equal(sMaskText('Неверный ИНН кассира: 12345, покупатель ivan@mail.ru, +7 912 345-67-89'), 'Неверный ИНН кассира: [ПД], покупатель [ПД], [ПД]');
  const sKeep = 'ККТ РИТЕЙЛ-02Ф, з/н: 0166440019002983, ФД 92, tcp://192.168.137.111:7778';
  assert.equal(sMaskText(sKeep), sKeep);
  assert.equal(sMaskText('http://u:p@pc:16732/api/v2/'), 'http://u:***@pc:16732/api/v2/');
});

test('отладочный журнал выключается сам через 20 минут; срок ставит агент', async () => {
  const { oPutSettings, oGetSettings } = await import('../src/settings.js');
  const { bDebugOn } = await import('../src/debug.js');
  const nBefore = Date.now();
  oPutSettings({ debugLog: true, debugLogUntil: 1 });
  const o = oGetSettings();
  assert.equal(o.debugLog, true);
  assert.ok(o.debugLogUntil >= nBefore + 20 * 60e3 - 1000 && o.debugLogUntil <= Date.now() + 20 * 60e3, 'срок — 20 минут, не из запроса');
  assert.equal(bDebugOn(), true);
  oPutSettings({ debugLog: false });
  assert.equal(oGetSettings().debugLogUntil, 0);
  assert.equal(bDebugOn(), false);
});
