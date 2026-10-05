#!/usr/bin/env node
// Локальный сервер кассы (kktsite-agent). Для кассы выглядит как «АТОЛ. Web
// Requests»: в настройках ККТ она подключается как «Атол Сервер» по адресу
// http://<пк>:16732/api/v2/. В отличие от Web Requests — несколько ККТ, без
// лицензии на сервер в ККТ и без обязательной авторизации. Страница настроек
// ККТ — http://<пк>:16732/.
//
//   kktsite-agent                         — запустить сервер
//   kktsite-agent users list|add|del …    — учётные записи (basic-авторизация)
//   kktsite-agent service install|uninstall|status — автозапуск службой ОС (service.js)
//   kktsite-agent install|uninstall …    — установка из архива выпуска (installer.js)
//   kktsite-agent --version              — версия; самопроверка при обновлении
//
// Настройка — переменными окружения:
//   KKT_AGENT_PORT    порт (16732, как у Web Requests; оба на одном ПК не
//                     уживутся — одному из них нужен другой порт)
//   KKT_AGENT_HOST    на каком адресе слушать (0.0.0.0 — вся локальная сеть:
//                     общая касса для нескольких ПК; 127.0.0.1 — только этот ПК)
//   KKT_AGENT_HTTPS_PORT  порт https (порт + 1); https включается кнопкой на
//                     странице настроек — там же выпускается сертификат (tls.js)
//   KKT_AGENT_DRIVER  где драйвер ДТО 10 (каталог или файл); по умолчанию —
//                     поиск, как у обёрток Атола
//   KKT_AGENT_DATA    каталог данных (список ККТ, учётки)

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { oLoadDriver } from './driver.js';
import { Registry } from './registry.js';
import { oCreateAgentServer } from './server.js';
import { pInstallCommand, pUninstallCommand } from './installer.js';
import { pServiceCommand } from './service.js';
import { oGetSettings } from './settings.js';
import { oCreateHttpsController } from './tls.js';
import { oInstallLayout } from './layout.js';
import { Updater } from './update.js';
import { sDataDir } from './store.js';
import { aUserNames, fAddUser, fDeleteUser } from './users.js';

const { version: S_VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fLog(sMessage) {
  console.log(`${new Date().toISOString()} ${sMessage}`);
}

function fUsersCommand([sCommand, sName, sPassword]) {
  if (sCommand === 'list' || !sCommand) {
    const aNames = aUserNames();
    console.log(aNames.length ? aNames.join('\n') : 'Учётных записей нет — авторизация выключена');
  } else if (sCommand === 'add') {
    fAddUser(sName, sPassword);
    console.log(`Учётная запись ${sName} сохранена. Авторизация включена.`);
  } else if (sCommand === 'del') {
    fDeleteUser(sName);
    console.log(`Учётная запись ${sName} удалена.${aUserNames().length ? '' : ' Учёток не осталось — авторизация выключена.'}`);
  } else {
    throw new Error('Команды: users list | users add <имя> <пароль> | users del <имя>');
  }
}

async function pServe() {
  const nPort = Number(process.env.KKT_AGENT_PORT || 16732);
  const sHost = process.env.KKT_AGENT_HOST || '0.0.0.0';

  fLog(`kktsite-agent ${S_VERSION}, данные: ${sDataDir()}`);
  const oDriver = oLoadDriver(process.env.KKT_AGENT_DRIVER);
  if (oDriver.loaded) fLog(`Драйвер ДТО ${oDriver.version}: ${oDriver.path}`);
  else fLog(`Драйвер ДТО не загружен — ККТ не подключить: ${oDriver.error}`);
  if (oDriver.warning) fLog(`ВНИМАНИЕ: ${oDriver.warning}`);

  oGetSettings(); // срок хранения заданий — из settings.json
  const oRegistry = new Registry();
  // HTTPS — тот же обработчик на соседнем порту; включается кнопкой на странице.
  const oHttps = oCreateHttpsController({
    fHandler: (oReq, oRes) => oServer.emit('request', oReq, oRes),
    nPort: Number(process.env.KKT_AGENT_HTTPS_PORT || nPort + 1),
    sHost,
    fLog,
  });
  const oLayout = oInstallLayout();
  // Перед выходом на обновление — закрыть драйвер, как при остановке: служба
  // поднимет новую версию, и она сразу откроет ККТ.
  const oUpdater = new Updater({
    oLayout,
    fLog,
    fExit: async () => {
      // Не рвать чек: дождаться, пока очереди всех ККТ опустеют.
      if (!await oRegistry.pWaitIdle()) fLog('Очередь не опустела за 10 минут — перезапускаюсь всё равно');
      fStop('обновление');
    },
  });
  // Перезапуск со страницы — только под службой: она и поднимет агент заново
  // (systemd выставляет INVOCATION_ID, launchd — XPC_SERVICE_NAME; на Windows
  // установленный агент всегда запущен run.cmd с циклом перезапуска).
  const oRestart = {
    bCan: Boolean(process.env.INVOCATION_ID)
      || process.env.XPC_SERVICE_NAME === 'ru.kktsite.agent'
      || (process.platform === 'win32' && Boolean(oLayout)),
    async pRestart() {
      if (!await oRegistry.pWaitIdle()) fLog('Очередь не опустела за 10 минут — перезапускаюсь всё равно');
      fStop('перезапуск со страницы');
    },
  };
  const oServer = oCreateAgentServer({ oRegistry, sVersion: S_VERSION, fLog, oHttps, oUpdater, oRestart });
  await new Promise((fResolve, fReject) => {
    oServer.once('error', fReject);
    oServer.listen(nPort, sHost, fResolve);
  });
  fLog(`Слушаю http://${sHost}:${nPort}/api/v2/, настройки ККТ — http://${sHost === '0.0.0.0' ? '127.0.0.1' : sHost}:${nPort}/`);
  await oHttps.pRestore();
  await oRegistry.pRestore(fLog);
  if (oLayout) {
    fLog(`Установка ${oLayout.sRoot}, ${oLayout.sPlatform}; обновления — ${oLayout.sUpdateUrl}${oUpdater.bAuto ? '' : ' (автообновление выключено)'}`);
    oUpdater.fStart();
  }

  // Остановка: закрыть драйвер, но НЕ запоминать ККТ отключёнными — после
  // перезапуска (обновления, перезагрузки ПК) они должны подключиться сами.
  const fStop = (sSignal) => {
    fLog(`${sSignal}: остановка`);
    for (const oDevice of oRegistry.mDevices.values()) {
      if (oDevice.oHandle && !oDevice.bReopen) try { oDevice.oHandle.fClose(); } catch { /* уже закрыт */ }
    }
    oServer.close();
    oHttps.close();
    process.exit(0);
  };
  process.on('SIGINT', fStop);
  process.on('SIGTERM', fStop);
}

// Запуск — в функции, а не await на верхнем уровне модуля: его нет в Node 12
// (сборка для Windows 7 — scripts/pack.mjs --bundle-node12).
async function pMain([sCommand, ...aArgs]) {
  if (sCommand === '--version') {
    // Самопроверка новой версии перед переключением (update.js): версия и
    // то, что нативная обёртка грузится этим node. Драйвер не загружается.
    createRequire(import.meta.url)('node-atol-wrapper');
    console.log(`kktsite-agent ${S_VERSION}`);
  } else if (sCommand === 'install') console.log(await pInstallCommand(aArgs));
  else if (sCommand === 'uninstall') console.log(await pUninstallCommand(aArgs));
  else if (sCommand === 'users') fUsersCommand(aArgs);
  else if (sCommand === 'service') console.log(await pServiceCommand(aArgs));
  else if (!sCommand) await pServe();
  else throw new Error(`Неизвестная команда: ${sCommand}. Запуск без аргументов — сервер; users … — учётные записи; service … — автозапуск`);
}

pMain(process.argv.slice(2)).catch((oError) => {
  console.error(oError.message);
  process.exit(1);
});
