// Мост kkt-core → драйвер Посцентра (src/shtrih-drv.js): обрыв связи у драйвера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oDriverSocket } from '../src/shtrih-drv.js';

const aFrame = (aBody) => { const a = [aBody.length, ...aBody]; return [2, ...a, a.reduce((x, c) => x ^ c, 0)]; };

test('драйвер потерял ККТ — сокет закрыт, причина видна, кадры больше не уходят', async () => {
  let nCalls = 0;
  const oDrv = { call: (sMethod, oProps, aOut, f) => { nCalls += 1; f(null, { ResultCode: -1, ResultCodeDescription: 'Нет связи' }); } };
  const aLog = [];
  const oSocket = oDriverSocket(oDrv, 30, (s) => aLog.push(s));
  let bClosedEvent = false;
  oSocket.onclose = () => { bClosedEvent = true; };
  assert.equal(oSocket.bClosed, false);
  oSocket.send(new Uint8Array(aFrame([0xFC])));
  await new Promise((f) => setTimeout(f, 20));
  assert.equal(oSocket.bClosed, true);
  assert.ok(bClosedEvent, 'onclose — устройство переподключит ККТ');
  assert.equal(oSocket.sLastError, 'Нет связи');
  assert.match(aLog.join('\n'), /нет связи с ККТ — Нет связи/);
  oSocket.send(new Uint8Array(aFrame([0xFC])));
  await new Promise((f) => setTimeout(f, 20));
  assert.equal(nCalls, 1, 'после закрытия в драйвер не ходим');
});

test('ENQ, пока команда у драйвера, — ACK (ответ готовится), после ответа — NAK', async () => {
  let fFinish;
  const oDrv = { call: (sMethod, oProps, aOut, f) => { fFinish = () => f(null, { ResultCode: 0, TransferBytes: 'FC 00 01 02' }); } };
  const oSocket = oDriverSocket(oDrv, 30);
  const aRx = [];
  oSocket.onmessage = (o) => aRx.push(...new Uint8Array(o.data));
  const pTick = () => new Promise((f) => setTimeout(f, 10));
  oSocket.send(new Uint8Array([5]));
  await pTick();
  assert.deepEqual(aRx.splice(0), [0x15]);
  oSocket.send(new Uint8Array(aFrame([0xFC])));
  await pTick();
  assert.deepEqual(aRx.splice(0), [6], 'кадр принят');
  oSocket.send(new Uint8Array([5]));
  await pTick();
  assert.deepEqual(aRx.splice(0), [6], 'драйвер ещё работает — ACK');
  fFinish();
  await pTick();
  assert.deepEqual(aRx.splice(0), aFrame([0xFC, 0, 1, 2]));
  oSocket.send(new Uint8Array([6, 5]));
  await pTick();
  assert.deepEqual(aRx.splice(0), [0x15], 'ответ отдан — снова NAK');
});
