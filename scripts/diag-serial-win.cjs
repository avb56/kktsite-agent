// Замер задержек COM-порта Штриха в VCOM тем же Node и serialport, что в агенте
// (21.11.2026: на Windows 7 x32 команды через агента шли секундами, а
// браузер и драйвер ПосЦентра на том же порту — быстро).
//
// Гипотеза: в Windows-сборке @serialport/bindings-cpp чтение висит всегда
// (ReadFileEx на 1 байт без таймаута), а старый usbser.sys Windows 7 не
// пропускает запись, пока висит чтение. Протокол Штриха в VCOM — «ККТ говорит
// только в ответ», так что запись ждёт чтения, чтение — ответа.
//
// Два варианта по 10 раз, ENQ (05h) → первый байт ответа (NAK 15h или ACK 06h):
//   A — как агент: чтение висит постоянно, ENQ пишется поверх;
//   B — без висящего чтения: ENQ, после записи — чтение.
// Печатает время записи и время до ответа, в мс.
//
// Запуск (служба агента остановлена или ККТ удалена из агента — порт занят):
//   "C:\Program Files\kktsite-agent\current\node\node.exe" diag-serial-win.cjs COM34
'use strict';
const path = require('path');

const sCom = process.argv[2];
if (!sCom) { console.log('Укажите порт: node diag-serial-win.cjs COM34'); process.exit(1); }
const sApp = process.env.AGENT_APP || 'C:\\Program Files\\kktsite-agent\\current\\app';
const { autoDetect } = require(path.join(sApp, 'node_modules', '@serialport', 'bindings-cpp'));
const N_RUNS = 10, N_TIMEOUT_MS = 5000;

const nNow = () => Number(process.hrtime.bigint() / 1000000n);
const pSleep = (n) => new Promise((f) => setTimeout(f, n));
const pTimeout = (p, n) => Promise.race([p, pSleep(n).then(() => 'таймаут')]);

async function pModeA(oPort) {
  // Чтение — своим циклом, как serial.js агента.
  let fOnByte = null;
  let bRun = true;
  const aBuf = Buffer.alloc(4096);
  (async () => {
    while (bRun) {
      try {
        const { bytesRead } = await oPort.read(aBuf, 0, aBuf.length);
        if (bytesRead && fOnByte) { const f = fOnByte; fOnByte = null; f(); }
      } catch (oError) { if (bRun) console.log('  чтение:', oError.message); break; }
    }
  })();
  await pSleep(300); // чтение уже висит
  for (let n = 1; n <= N_RUNS; n += 1) {
    const pByte = new Promise((f) => { fOnByte = f; });
    const nAt = nNow();
    await pTimeout(oPort.write(Buffer.from([0x05])), N_TIMEOUT_MS);
    const nWrite = nNow() - nAt;
    const vByte = await pTimeout(pByte, N_TIMEOUT_MS);
    console.log(`  A${n}: запись ${nWrite} мс, ответ ${vByte === 'таймаут' ? 'нет за 5 с' : (nNow() - nAt) + ' мс'}`);
    await pSleep(300);
  }
  bRun = false;
}

async function pModeB(oPort) {
  const aBuf = Buffer.alloc(4096);
  for (let n = 1; n <= N_RUNS; n += 1) {
    const nAt = nNow();
    await pTimeout(oPort.write(Buffer.from([0x05])), N_TIMEOUT_MS);
    const nWrite = nNow() - nAt;
    const vRead = await pTimeout(oPort.read(aBuf, 0, aBuf.length), N_TIMEOUT_MS);
    console.log(`  B${n}: запись ${nWrite} мс, ответ ${vRead === 'таймаут' ? 'нет за 5 с' : (nNow() - nAt) + ' мс'}`);
    if (vRead === 'таймаут') { console.log('  чтение висит — дальше B не показателен'); break; }
    await pSleep(300);
  }
}

(async () => {
  console.log(`Node ${process.version} ${process.arch}, порт ${sCom}`);
  const oBinding = autoDetect();
  // B первым: в A чтение остаётся висеть до закрытия порта.
  let oPort = await oBinding.open({ path: sCom, baudRate: 115200 });
  console.log('B — без висящего чтения:');
  await pModeB(oPort);
  await oPort.close().catch(() => {});
  await pSleep(500);
  oPort = await oBinding.open({ path: sCom, baudRate: 115200 });
  console.log('A — как агент (чтение висит всегда):');
  await pModeA(oPort);
  await oPort.close().catch(() => {});
  process.exit(0);
})().catch((oError) => { console.log('Ошибка:', oError.message); process.exit(1); });
