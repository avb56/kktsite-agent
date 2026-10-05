// Проверка службы агента в CI (.github/workflows/agent.yml), на любой ОС:
//
//   node scripts/ci-service-check.mjs 16733            — агент отвечает; после
//        kill процесса служба поднимает его снова (новый PID, снова отвечает)
//   node scripts/ci-service-check.mjs 16733 --stopped  — после uninstall порт закрыт
//
// Драйвера ДТО на машинах CI нет — агент поднимается и без него (driverError
// в serverInfo), для проверки службы этого достаточно.

import { execFileSync } from 'node:child_process';

const [sPort = '16733', sMode] = process.argv.slice(2);
const sBase = `http://127.0.0.1:${sPort}/api/v2`;
const pSleep = (nMs) => new Promise((f) => setTimeout(f, nMs));

async function pInfo() {
  try {
    const oRes = await fetch(`${sBase}/serverInfo`, { signal: AbortSignal.timeout(2000) });
    return oRes.ok ? await oRes.json() : null;
  } catch {
    return null;
  }
}

async function pWait(fCheck, nSeconds, sWhat) {
  for (let n = 0; n < nSeconds * 2; n += 1) {
    const vResult = await fCheck();
    if (vResult) return vResult;
    await pSleep(500);
  }
  throw new Error(`За ${nSeconds} с не дождались: ${sWhat}`);
}

const sRun = (sCommand, aArgs) => execFileSync(sCommand, aArgs, { encoding: 'utf8' }).trim();

/** PID процесса, который слушает порт. */
function nListenerPid() {
  let sOut = '';
  try {
    if (process.platform === 'win32') {
      sOut = sRun('powershell', ['-NoProfile', '-Command',
        // SilentlyContinue: пока агент перезапускается, порт никто не слушает — это не ошибка.
        `(Get-NetTCPConnection -LocalPort ${sPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);
    } else if (process.platform === 'darwin') {
      sOut = sRun('lsof', ['-nP', `-iTCP:${sPort}`, '-sTCP:LISTEN', '-t']).split('\n')[0];
    } else {
      sOut = /pid=(\d+)/.exec(sRun('ss', ['-ltnpH', `sport = :${sPort}`]))?.[1] ?? '';
    }
  } catch { /* никто не слушает */ }
  return Number(sOut) || 0;
}

function fKill(nPid) {
  if (process.platform === 'win32') sRun('taskkill', ['/F', '/PID', String(nPid)]);
  else process.kill(nPid, 'SIGKILL');
}

if (sMode === '--stopped') {
  await pWait(async () => !(await pInfo()), 30, 'остановки агента после uninstall');
  await pSleep(12000); // дольше паузы перезапуска всех трёх служб (5–10 с)
  if (await pInfo()) throw new Error('Агент снова поднялся после uninstall — служба не удалена');
  console.log('Агент остановлен, служба удалена');
} else {
  const oInfo = await pWait(pInfo, 90, `ответа агента на ${sBase}/serverInfo`);
  if (oInfo.product !== 'kktsite-agent') throw new Error(`На порту не агент: ${JSON.stringify(oInfo)}`);
  console.log(`Агент ${oInfo.serverVersion} отвечает, os=${oInfo.os}, драйвер: ${oInfo.driverVersion || oInfo.driverError}`);

  const nPid = await pWait(nListenerPid, 10, 'PID агента');
  console.log(`Убиваю агент, PID ${nPid}`);
  fKill(nPid);
  await pWait(async () => nListenerPid() !== nPid, 20, 'завершения агента');
  // launchd по умолчанию не перезапускает чаще раза в 10 с.
  const nNewPid = await pWait(async () => (await pInfo()) && nListenerPid(), 60, 'перезапуска агента службой');
  if (nNewPid === nPid) throw new Error('PID не сменился — агент не перезапускался');
  console.log(`Служба перезапустила агент, PID ${nNewPid}`);
}
