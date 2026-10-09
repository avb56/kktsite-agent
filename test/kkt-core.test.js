// kkt-core — драйверы ККТ на чистом JS (АТОЛ v3, Вики Принт, эмулятор) из
// avb56/kkt-core-dist. Агент их пока не использует; тест держит в порядке
// саму зависимость: архив выпуска ставится, require работает, эмулятор отвечает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('kkt-core: require и задание эмулятору', async () => {
  const { KKT, configure } = require('kkt-core');
  configure({ log: { info() {}, warn() {}, error() {} } });
  const oKKT = new KKT({ sConnectionType: 'emulate', sVendorOrUrl: 'auto', id: '0000000000000000', sNameKKT: '' });
  const [oStatus] = await oKKT.pTaskSender({ type: 'getDeviceStatus' });
  assert.ok(['opened', 'closed', 'expired'].includes(oStatus.deviceStatus.shift));
});
