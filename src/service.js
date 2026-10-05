// Автозапуск агента: служба ОС, которая поднимает агент при загрузке ПК и
// перезапускает, если он упал.
//
//   kktsite-agent service install [--port N] [--https-port N] [--host A] [--driver P] [--user U]
//   kktsite-agent service uninstall
//   kktsite-agent service status
//
// Ставится с правами администратора (sudo / «Запуск от имени администратора»):
//   — Linux: системная служба systemd /etc/systemd/system/kktsite-agent.service,
//     работает от обычного пользователя (User=; по умолчанию — тот, кто вызвал
//     sudo). Не от root: пакет Атола ставит библиотеки драйвера с правами 666,
//     и root-процесс загрузил бы подменённую библиотеку. Доступ к ККТ по USB
//     даёт правило udev Атола, к COM-портам — группа dialout. Журнал —
//     journalctl -u kktsite-agent;
//   — Windows: задача планировщика «при запуске системы» от SYSTEM, запускает
//     run.cmd из %ProgramData%\kktsite-agent (там же данные агента) — он
//     перезапускает агент, если тот завершился. Настоящей службе Windows нужен
//     нативный обработчик SCM; задача планировщика обходится без него. Файлы
//     драйвера на Windows — в Program Files, подменить их без прав
//     администратора нельзя, поэтому SYSTEM здесь не то же, что root на Linux;
//   — macOS: LaunchDaemon /Library/LaunchDaemons/ru.kktsite.agent.plist, от
//     пользователя (UserName), KeepAlive.
//
// Служба запускает агент из того каталога, откуда вызвали install, тем же
// node (process.execPath): перенесли каталог или обновили node — install
// заново. Установка из архива выпуска (layout.js) — через <корень>/current:
// обновления переключают current, служба остаётся прежней. Порт, адрес и путь к драйверу записываются в службу; не заданы в
// параметрах — берутся из KKT_AGENT_* окружения, иначе — по умолчанию агента.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from './fsx.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oInstallLayout } from './layout.js';

export const S_SERVICE = 'kktsite-agent';
const S_UNIT_PATH = `/etc/systemd/system/${S_SERVICE}.service`;
const S_PLIST_LABEL = 'ru.kktsite.agent';
const S_PLIST_PATH = `/Library/LaunchDaemons/${S_PLIST_LABEL}.plist`;

// Установлен из архива выпуска — служба запускает через ссылку current (её
// переключает обновление); из репозитория — тем node и тем main.js, что сейчас.
const O_LAYOUT = oInstallLayout();
const S_MAIN = O_LAYOUT?.sCurrentMain ?? fileURLToPath(new URL('./main.js', import.meta.url));
const S_NODE = O_LAYOUT?.sCurrentNode ?? process.execPath;

/** --port 16733 --user kassa → { port: '16733', user: 'kassa' } */
export function oParseArgs(aArgs) {
  const oArgs = {};
  for (let n = 0; n < aArgs.length; n += 1) {
    const aMatch = /^--(port|https-port|host|driver|user)(?:=(.*))?$/.exec(aArgs[n]);
    if (!aMatch) throw new Error(`Неизвестный параметр: ${aArgs[n]}. Есть: --port, --https-port, --host, --driver, --user`);
    oArgs[aMatch[1]] = aMatch[2] ?? aArgs[++n];
    if (oArgs[aMatch[1]] === undefined) throw new Error(`У --${aMatch[1]} нет значения`);
  }
  for (const sName of ['port', 'https-port']) {
    if (oArgs[sName] !== undefined && !/^\d{1,5}$/.test(oArgs[sName])) throw new Error(`Неверный порт: ${oArgs[sName]}`);
  }
  return oArgs;
}

/** Переменные окружения службы: из параметров, иначе из текущего окружения. */
export function oServiceEnv(oArgs, oEnv = process.env) {
  const oResult = {};
  const fSet = (sName, vValue) => { if (vValue) oResult[sName] = String(vValue); };
  fSet('KKT_AGENT_PORT', oArgs.port ?? oEnv.KKT_AGENT_PORT);
  fSet('KKT_AGENT_HTTPS_PORT', oArgs['https-port'] ?? oEnv.KKT_AGENT_HTTPS_PORT);
  fSet('KKT_AGENT_HOST', oArgs.host ?? oEnv.KKT_AGENT_HOST);
  fSet('KKT_AGENT_DRIVER', oArgs.driver ?? oEnv.KKT_AGENT_DRIVER);
  return oResult;
}

// systemd: значение Environment= в кавычках, с экранированием.
const sSystemdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function sSystemdUnit({ sUser, sNode, sMain, oEnv, sDataDir }) {
  const aEnv = Object.entries({ ...oEnv, KKT_AGENT_DATA: sDataDir })
    .map(([sName, sValue]) => `Environment=${sSystemdQuote(`${sName}=${sValue}`)}`);
  return `# Создано командой: kktsite-agent service install. Удалить: kktsite-agent service uninstall
[Unit]
Description=kktsite-agent — локальный сервер кассы (ККТ Атол, API как у Web Requests)
Wants=network-online.target
After=network-online.target uem-agent.service

[Service]
Type=simple
User=${sUser}
${aEnv.join('\n')}
ExecStart=${sSystemdQuote(sNode)} ${sSystemdQuote(sMain)}
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
`;
}

const sXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sLaunchdPlist({ sUser, sNode, sMain, oEnv, sDataDir }) {
  const aEnv = Object.entries({ ...oEnv, KKT_AGENT_DATA: sDataDir })
    .map(([sName, sValue]) => `    <key>${sXml(sName)}</key><string>${sXml(sValue)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Создано командой: kktsite-agent service install. Удалить: kktsite-agent service uninstall -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${S_PLIST_LABEL}</string>
  <key>UserName</key><string>${sXml(sUser)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${sXml(sNode)}</string>
    <string>${sXml(sMain)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${aEnv.join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${sXml(join(sDataDir, 'agent.log'))}</string>
  <key>StandardErrorPath</key><string>${sXml(join(sDataDir, 'agent.log'))}</string>
</dict>
</plist>
`;
}

// cmd: значение в set "ИМЯ=значение" — кавычки вокруг всего, % удваивается.
const sCmdValue = (s) => String(s).replace(/%/g, '%%').replace(/"/g, '');

export function sWindowsRunner({ sNode, sMain, oEnv, sDataDir }) {
  const aEnv = Object.entries({ ...oEnv, KKT_AGENT_DATA: sDataDir })
    .map(([sName, sValue]) => `set "${sName}=${sCmdValue(sValue)}"`);
  return `@echo off
rem Создано командой: kktsite-agent service install. Удалить: kktsite-agent service uninstall
rem Запускает агент и перезапускает его через 5 с, если он завершился.
chcp 65001 >nul
${aEnv.join('\r\n')}
:loop
"${sCmdValue(sNode)}" "${sCmdValue(sMain)}" >> "${sCmdValue(join(sDataDir, 'agent.log'))}" 2>&1
rem Пауза 5 с. Не timeout: без консоли (задача планировщика) он сразу выходит с ошибкой.
ping -n 6 127.0.0.1 >nul
goto loop
`.replace(/\r?\n/g, '\r\n');
}

// ——— выполнение ———

function sRun(sCommand, aArgs, bQuiet = false) {
  return execFileSync(sCommand, aArgs, { encoding: 'utf8', stdio: bQuiet ? 'pipe' : ['ignore', 'pipe', 'pipe'] });
}

function fRequireRoot() {
  if (process.getuid?.() !== 0) {
    throw new Error('Службу ставят с правами администратора: sudo node src/main.js service …');
  }
}

/** Пользователь, от которого будет работать агент, и его домашний каталог. */
function oTargetUser(oArgs) {
  const sUser = oArgs.user || process.env.SUDO_USER;
  if (!sUser) throw new Error('Не понять, от какого пользователя запускать агент: укажите --user <имя>');
  if (sUser === 'root') throw new Error('Агент не запускается от root (см. src/service.js) — укажите --user <имя>');
  let sHome;
  try {
    sHome = process.platform === 'darwin'
      ? sRun('dscl', ['.', '-read', `/Users/${sUser}`, 'NFSHomeDirectory'], true).split(':')[1].trim()
      : sRun('getent', ['passwd', sUser], true).split(':')[5];
  } catch {
    throw new Error(`Нет такого пользователя: ${sUser}`);
  }
  return { sUser, sHome };
}

function oLinux() {
  return {
    pInstall(oArgs, { sNode = S_NODE, sMain = S_MAIN } = {}) {
      fRequireRoot();
      const { sUser, sHome } = oTargetUser(oArgs);
      const sDataDir = join(sHome, '.config', S_SERVICE);
      writeFileSync(S_UNIT_PATH, sSystemdUnit({ sUser, sNode, sMain, oEnv: oServiceEnv(oArgs), sDataDir }));
      sRun('systemctl', ['daemon-reload']);
      sRun('systemctl', ['enable', S_SERVICE], true);
      // restart, а не start: при повторном install подхватить новые настройки.
      sRun('systemctl', ['restart', S_SERVICE]);
      return `Служба ${S_SERVICE} установлена и запущена от пользователя ${sUser} (${S_UNIT_PATH}).\n`
        + `Журнал: journalctl -u ${S_SERVICE} -f`;
    },
    pUninstall() {
      fRequireRoot();
      if (!existsSync(S_UNIT_PATH)) return `Служба ${S_SERVICE} не установлена.`;
      try { sRun('systemctl', ['disable', '--now', S_SERVICE], true); } catch { /* уже остановлена */ }
      rmSync(S_UNIT_PATH);
      sRun('systemctl', ['daemon-reload']);
      return `Служба ${S_SERVICE} остановлена и удалена. Данные агента (список ККТ, учётки) не тронуты.`;
    },
    pStatus() {
      if (!existsSync(S_UNIT_PATH)) return `Служба ${S_SERVICE} не установлена.`;
      let sState;
      try { sState = sRun('systemctl', ['is-active', S_SERVICE], true).trim(); } catch (oError) { sState = String(oError.stdout || '').trim() || 'неизвестно'; }
      return `Служба ${S_SERVICE}: ${sState} (${S_UNIT_PATH}).\nЖурнал: journalctl -u ${S_SERVICE}`;
    },
  };
}

function oMac() {
  return {
    pInstall(oArgs, { sNode = S_NODE, sMain = S_MAIN } = {}) {
      fRequireRoot();
      const { sUser, sHome } = oTargetUser(oArgs);
      const sDataDir = join(sHome, 'Library', 'Application Support', S_SERVICE);
      // Журнал launchd открывает сам, до запуска агента: без каталога агент не стартует.
      // Каталог создаёт root — отдать его пользователю, иначе агент не запишет данные.
      if (!existsSync(sDataDir)) {
        mkdirSync(sDataDir, { recursive: true, mode: 0o700 });
        sRun('chown', [sUser, sDataDir], true);
      }
      try { sRun('launchctl', ['bootout', `system/${S_PLIST_LABEL}`], true); } catch { /* не была загружена */ }
      writeFileSync(S_PLIST_PATH, sLaunchdPlist({ sUser, sNode, sMain, oEnv: oServiceEnv(oArgs), sDataDir }), { mode: 0o644 });
      sRun('launchctl', ['bootstrap', 'system', S_PLIST_PATH]);
      return `Служба ${S_PLIST_LABEL} установлена и запущена от пользователя ${sUser} (${S_PLIST_PATH}).\n`
        + `Журнал: ${join(sDataDir, 'agent.log')}`;
    },
    pUninstall() {
      fRequireRoot();
      if (!existsSync(S_PLIST_PATH)) return `Служба ${S_PLIST_LABEL} не установлена.`;
      try { sRun('launchctl', ['bootout', `system/${S_PLIST_LABEL}`], true); } catch { /* уже выгружена */ }
      rmSync(S_PLIST_PATH);
      return `Служба ${S_PLIST_LABEL} остановлена и удалена. Данные агента не тронуты.`;
    },
    pStatus() {
      if (!existsSync(S_PLIST_PATH)) return `Служба ${S_PLIST_LABEL} не установлена.`;
      try {
        sRun('launchctl', ['print', `system/${S_PLIST_LABEL}`], true);
        return `Служба ${S_PLIST_LABEL} загружена (${S_PLIST_PATH}).`;
      } catch {
        return `Служба ${S_PLIST_LABEL} установлена, но не загружена (${S_PLIST_PATH}).`;
      }
    },
  };
}

function oWindows() {
  const sDataDir = join(process.env.ProgramData || 'C:\\ProgramData', S_SERVICE);
  const sRunner = join(sDataDir, 'run.cmd');
  // schtasks /End завершает run.cmd, но не запущенный им node.exe: у Windows
  // дочерние процессы переживают родителя. Остановить агент — node.exe с
  // нашим main.js в командной строке. Get-WmiObject, а не Get-CimInstance:
  // на Windows 7 — PowerShell 2.0, в нём Get-CimInstance нет.
  const fStop = (sMain = S_MAIN) => {
    try { sRun('schtasks', ['/End', '/TN', S_SERVICE], true); } catch { /* не запущена */ }
    const sMainPs = sMain.replace(/'/g, "''");
    try {
      sRun('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${sMainPs}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], true);
    } catch { /* агент не запущен */ }
  };
  const fRequireAdmin = () => {
    try { sRun('net', ['session'], true); } catch {
      throw new Error('Службу ставят с правами администратора: командная строка «Запуск от имени администратора»');
    }
  };
  return {
    pInstall(oArgs, { sNode = S_NODE, sMain = S_MAIN } = {}) {
      fRequireAdmin();
      if (oArgs.user) throw new Error('На Windows агент работает от SYSTEM — --user не нужен');
      mkdirSync(sDataDir, { recursive: true });
      fStop(sMain); // повторный install: старый агент освобождает порт и ККТ
      writeFileSync(sRunner, sWindowsRunner({ sNode, sMain, oEnv: oServiceEnv(oArgs), sDataDir }));
      sRun('schtasks', ['/Create', '/F', '/TN', S_SERVICE, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', sRunner], true);
      sRun('schtasks', ['/Run', '/TN', S_SERVICE], true);
      return `Задача ${S_SERVICE} создана и запущена (запуск при старте системы, от SYSTEM).\n`
        + `Данные и журнал: ${sDataDir}`;
    },
    pUninstall({ sMain = S_MAIN } = {}) {
      fRequireAdmin();
      fStop(sMain);
      try {
        sRun('schtasks', ['/Delete', '/F', '/TN', S_SERVICE], true);
      } catch {
        return `Задача ${S_SERVICE} не установлена.`;
      }
      rmSync(sRunner, { force: true });
      return `Задача ${S_SERVICE} остановлена и удалена. Данные агента (${sDataDir}) не тронуты.`;
    },
    pStatus() {
      try {
        const sOut = sRun('schtasks', ['/Query', '/TN', S_SERVICE, '/FO', 'LIST'], true);
        return sOut.trim();
      } catch {
        return `Задача ${S_SERVICE} не установлена.`;
      }
    },
  };
}

export function oPlatformService(sPlatform = process.platform) {
  if (sPlatform === 'linux') return oLinux();
  if (sPlatform === 'darwin') return oMac();
  if (sPlatform === 'win32') return oWindows();
  throw new Error(`Служба для ${sPlatform} не поддерживается`);
}

export async function pServiceCommand([sCommand, ...aArgs]) {
  const oService = oPlatformService();
  if (sCommand === 'install') return oService.pInstall(oParseArgs(aArgs));
  if (sCommand === 'uninstall') return oService.pUninstall();
  if (sCommand === 'status' || !sCommand) return oService.pStatus();
  throw new Error('Команды: service install [--port N] [--https-port N] [--host A] [--driver P] [--user U] | service uninstall | service status');
}
