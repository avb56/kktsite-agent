// COM-порт агента (serial.js): порты из реестра Windows, предел записи и
// закрытия — виртуальный порт без второй стороны (ComProxy выключена,
// 28.11.2026) не должен вешать подключение и остановку. Привязка serialport
// подменяется — тесты идут на любой ОС.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sTmp = mkdtempSync(join(tmpdir(), 'kkt-agent-serial-'));
process.env.KKT_AGENT_DATA = join(sTmp, 'data');
after(() => rmSync(sTmp, { recursive: true, force: true }));

const { aParseSerialComm, aListSerialPorts, oSerialPort, oSerialLimits, fUseBinding, sPortBusy } = await import('../src/serial.js');
const { Registry } = await import('../src/registry.js');

const S_REG = [
  '',
  'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM',
  '    \\Device\\Serial0    REG_SZ    COM1',
  '    \\Device\\USBSER000    REG_SZ    COM3',
  '    \\Device\\com0com10    REG_SZ    COM10',
  '',
].join('\r\n');

test('порты из реестра SERIALCOMM — и те, которых serialport не видит', async () => {
  assert.deepEqual(aParseSerialComm(S_REG), [
    { path: 'COM1', device: 'Serial0' }, { path: 'COM3', device: 'USBSER000' }, { path: 'COM10', device: 'com0com10' },
  ]);
  fUseBinding({ list: async () => [{ path: 'COM3', vendorId: '0483', productId: '5740' }, { path: 'COM1' }] });
  const aPorts = await aListSerialPorts({ fRegQuery: async () => S_REG });
  assert.deepEqual(aPorts.map((o) => o.path), ['COM1', 'COM3', 'COM10']);
  assert.equal(aPorts[1].vendorId, '0483', 'порт из serialport — со сведениями USB');
  assert.equal(aPorts[2].device, 'com0com10');
  // Реестр не прочитался — только serialport.
  assert.deepEqual((await aListSerialPorts({ fRegQuery: async () => { throw new Error('нет reg'); } })).map((o) => o.path), ['COM1', 'COM3']);
});

/** Порт, запись в который не завершается, а закрытие висит. */
function oDeadPort() {
  return {
    isOpen: true,
    nWrites: 0,
    write() { this.nWrites++; return new Promise(() => {}); },
    read: () => new Promise(() => {}),
    close: () => new Promise(() => {}),
  };
}

test('запись, которая не завершается, — ошибка через nWriteMs; следующие — сразу; чтение обрывается; закрытие не виснет', async () => {
  const oSaved = { ...oSerialLimits };
  Object.assign(oSerialLimits, { nWriteMs: 50, nCloseMs: 50 });
  try {
    const oDead = oDeadPort();
    fUseBinding({ list: async () => [], open: async () => oDead });
    const oPort = oSerialPort('COM10');
    await oPort.open();
    const oWriter = oPort.writable.getWriter();
    const oReader = oPort.readable.getReader();
    const pRead = oReader.read();
    await assert.rejects(oWriter.write(new Uint8Array([2, 80])), /COM10 не принимает данные/);
    await assert.rejects(pRead, /не принимает данные/, 'ждущее чтение оборвалось — kkt-core прервёт команду');
    await assert.rejects(oWriter.write(new Uint8Array([5])), /не принимает данные/);
    assert.equal(oDead.nWrites, 1, 'в зависший порт больше не пишем');
    const nAt = Date.now();
    await oPort.close();
    await oReader.cancel();
    assert.ok(Date.now() - nAt < 1000, 'закрытие не ждёт драйвер дольше nCloseMs');
  } finally {
    Object.assign(oSerialLimits, oSaved);
  }
});

test('занят ли порт: Access denied — занят другой программой', async () => {
  fUseBinding({ open: async () => { throw new Error('Opening COM3: Access denied'); } });
  assert.equal(await sPortBusy('COM3'), 'порт занят другой программой');
  let bClosed = false;
  fUseBinding({ open: async () => ({ close: async () => { bClosed = true; } }) });
  assert.equal(await sPortBusy('COM3'), '');
  assert.ok(bClosed);
});

test('остановка не ждёт подключения ККТ, которое висит', async () => {
  const oRegistry = new Registry();
  oRegistry.mDevices.set('1', { bOpening: true, bPumping: false, aWaiting: [], oBlock: null, pSerial: () => new Promise(() => {}) });
  assert.equal(await oRegistry.pWaitIdle(2000), true);
  // Висит не подключение, а цепочка с работой — ждём не дольше срока.
  oRegistry.mDevices.set('1', { bOpening: false, bPumping: false, aWaiting: [], oBlock: null, pSerial: () => new Promise(() => {}) });
  const nAt = Date.now();
  assert.equal(await oRegistry.pWaitIdle(300), false);
  assert.ok(Date.now() - nAt < 1500);
});
