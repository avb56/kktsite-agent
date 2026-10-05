// Установка из архива выпуска: install.sh / install.cmd запускают вложенный
// node с `main.js install …` — логика одна на все ОС.
//
//   install   [--dir <корень>] [--user U] [--arch x64|ia32] [--port N] [--https-port N] [--host A] [--driver P]
//   uninstall [--dir <корень>]
//
// Корень по умолчанию: Linux — /opt/kktsite-agent, macOS —
// /usr/local/kktsite-agent, Windows — %ProgramFiles%\kktsite-agent. Раскладка —
// layout.js. На Linux и macOS корень отдаётся пользователю службы (агент
// работает от него и сам ставит обновления); код от его имени и исполняется,
// так что прав это ему не добавляет. Данные агента (ККТ, учётки,
// сертификат) лежат отдельно и при удалении не трогаются.
//
// Windows-zip — на обе разрядности (scripts/pack-windows.mjs):
//   kktsite-agent-<версия>-windows/{x64,ia32}/{node,app}, install.cmd …
// install.cmd запускает 32-битный node (работает на любой Windows), а ставится
// та половина, что совпадает с установленным драйвером Атола (winreg.js);
// --arch — выбрать руками. В versions/<версия> — обычная раскладка {node, app}.

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { rmSync } from './fsx.js';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sNodeFile } from './layout.js';
import { oParseArgs, oPlatformService } from './service.js';
import { fSwitchCurrent } from './update.js';
import { aAtolDriverArchs, bWindows64, sChooseArch } from './winreg.js';

const S_APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function sDefaultRoot() {
  // ProgramW6432 — настоящий Program Files: у 32-битного процесса (install.cmd
  // на 32-битном node) ProgramFiles указывает на «Program Files (x86)».
  if (process.platform === 'win32') {
    return join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'kktsite-agent');
  }
  if (process.platform === 'darwin') return '/usr/local/kktsite-agent';
  return '/opt/kktsite-agent';
}

function fRequireAdmin() {
  if (process.platform === 'win32') {
    try { execFileSync('net', ['session'], { stdio: 'ignore' }); } catch {
      throw new Error('Запустите install.cmd от имени администратора (правый щелчок → «Запуск от имени администратора»)');
    }
  } else if (process.getuid?.() !== 0) {
    throw new Error('Запустите через sudo: sudo ./install.sh');
  }
}

/** --dir отдельно, остальное — как есть в service install. */
function oSplitArgs(aArgs) {
  const aRest = [];
  let sDir = sDefaultRoot();
  let sUser = process.env.SUDO_USER || '';
  let sArch = '';
  for (let n = 0; n < aArgs.length; n += 1) {
    const aMatch = /^--(dir|user|arch)(?:=(.*))?$/.exec(aArgs[n]);
    if (!aMatch) { aRest.push(aArgs[n]); continue; }
    const sValue = aMatch[2] ?? aArgs[++n];
    if (!sValue) throw new Error(`У --${aMatch[1]} нет значения`);
    if (aMatch[1] === 'dir') sDir = resolve(sValue);
    else if (aMatch[1] === 'arch') sArch = sValue;
    else sUser = sValue;
  }
  if (sArch && !['x64', 'ia32'].includes(sArch)) throw new Error(`--arch: x64 или ia32, а не ${sArch}`);
  return { sDir, sUser, sArch, aRest };
}

/**
 * Копировать каталог. Не fs.cpSync: в Node 22 на Windows он копирует каталог
 * через std::filesystem, получая путь байтами UTF-8 как ANSI, — путь с
 * кириллицей (папка пользователя) искажается, вызов без кода ошибки бросает
 * исключение C++, и процесс завершается молча (01.10.2026: 32-разрядная
 * установка оставляла пустой versions\\0.2.0). mkdir/readdir/copyFile идут
 * через libuv — с юникодными путями он работает правильно.
 */
export function fCopyDir(sFrom, sTo) {
  mkdirSync(sTo, { recursive: true });
  for (const oEntry of readdirSync(sFrom, { withFileTypes: true })) {
    const sSrc = join(sFrom, oEntry.name);
    const sDst = join(sTo, oEntry.name);
    if (oEntry.isDirectory()) fCopyDir(sSrc, sDst);
    else if (oEntry.isFile()) copyFileSync(sSrc, sDst);
    // Ссылок в архиве выпуска нет (pack.mjs разыменовывает), прочее пропускаем.
  }
}

const aRunInstalled = (sRoot, aArgs) => [
  join(sRoot, 'current', 'node', sNodeFile()),
  [join(sRoot, 'current', 'app', 'src', 'main.js'), ...aArgs],
];

/** Вопрос в консоли: ответ строкой (Enter — пустая строка). */
function pAsk(sQuestion) {
  const oRl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((fResolve) => oRl.question(sQuestion, (sAnswer) => { oRl.close(); fResolve(sAnswer.trim()); }));
}

const sBits = (sArch) => (sArch === 'x64' ? '64' : '32');

/**
 * Драйвера Атола нет — какую половину ставить. В консоли спросить
 * (рекомендуемая — по разрядности Windows), без консоли — ошибка с действием.
 * На 32-битной Windows выбора нет.
 */
async function pAskArch({ bInteractive, bOs64, fAsk }) {
  const sAfter = 'Поставьте драйвер ДТО 10 Атола той же разрядности, затем на странице настроек — «Перезапустить сервер».';
  if (!bOs64) {
    console.log(`Драйвер ДТО 10 Атола не найден. Windows 32-битная — ставлю 32-разрядного агента. ${sAfter}`);
    return 'ia32';
  }
  if (!bInteractive) {
    throw new Error('Не найден драйвер ДТО 10 Атола. Установите его и запустите install.cmd снова, '
      + 'или укажите разрядность будущего драйвера: --arch x64 или --arch ia32.');
  }
  const sAnswer = await fAsk([
    'Драйвер ДТО 10 Атола не найден. Агент должен совпадать по разрядности с драйвером,',
    'который вы поставите:',
    '  1 — 64-разрядный (рекомендуется: Windows 64-битная)',
    '  2 — 32-разрядный',
    '  Enter — отмена',
    'Ваш выбор: ',
  ].join('\n'));
  const sArch = { 1: 'x64', 2: 'ia32' }[sAnswer];
  if (!sArch) throw new Error('Установка отменена.');
  console.log(`Ставлю ${sBits(sArch)}-разрядного агента. ${sAfter}`);
  return sArch;
}

/**
 * Откуда копировать: распакованный архив одной платформы — он сам; Windows-zip
 * на обе разрядности (sPackDir — его половина ia32 или x64) — половина под
 * драйвер Атола; драйвера нет — спросить (pAskArch).
 */
export async function pChooseSource(sPackDir, sArch = '', {
  fDriverArchs = aAtolDriverArchs,
  bInteractive = Boolean(process.stdin.isTTY),
  bOs64 = bWindows64(),
  fAsk = pAsk,
} = {}) {
  const sCombined = dirname(sPackDir);
  const bCombined = ['x64', 'ia32'].includes(basename(sPackDir))
    && existsSync(join(sCombined, 'x64', 'app')) && existsSync(join(sCombined, 'ia32', 'app'));
  if (!bCombined) return sPackDir;
  if (sArch) return join(sCombined, sArch);
  const aDrivers = fDriverArchs();
  let sChosen = sChooseArch(aDrivers);
  if (sChosen) console.log(`Драйвер Атола: ${aDrivers.map(sBits).join(' и ')}-разрядный; ставлю агента ${sBits(sChosen)}-разрядного.`);
  else sChosen = await pAskArch({ bInteractive, bOs64, fAsk });
  return join(sCombined, sChosen);
}

/** Windows, установка из консоли: открыть страницу настроек — следующий шаг всё равно там. */
function fOpenSettingsPage(sUrl) {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return;
  try {
    spawn('cmd', ['/c', 'start', '', sUrl], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* не открылось — адрес напечатан */ }
}

export async function pInstallCommand(aArgs) {
  fRequireAdmin();
  const sInfo = join(S_APP_DIR, 'package-info.json');
  if (!existsSync(sInfo)) throw new Error('install — для архива выпуска. Из репозитория служба ставится: service install');
  const { version: sVersion } = JSON.parse(readFileSync(sInfo, 'utf8'));
  const { sDir: sRoot, sUser, sArch, aRest } = oSplitArgs(aArgs);
  if (process.platform !== 'win32') {
    if (!sUser) throw new Error('Не понять, от какого пользователя запускать агент: укажите --user <имя>');
    if (sUser === 'root') throw new Error('Агент не запускается от root — укажите --user <имя>');
  }

  const sSource = await pChooseSource(realpathSync(dirname(S_APP_DIR)), sArch); // распакованный архив
  const sTarget = join(sRoot, 'versions', sVersion);
  if (relative(sTarget, sSource) !== '') {
    // Та же версия уже стоит и работает — службу сначала остановить, иначе
    // на Windows её файлы заняты.
    if (existsSync(sTarget)) {
      try { await oPlatformService().pUninstall({ sMain: aRunInstalled(sRoot, [])[1][0] }); } catch { /* не было службы */ }
      rmSync(sTarget, { recursive: true, force: true });
    }
    console.log(`Копирую в ${sTarget}…`);
    try {
      fCopyDir(sSource, sTarget);
    } catch (oError) {
      rmSync(sTarget, { recursive: true, force: true });
      throw new Error(`Не скопировать ${sSource} в ${sTarget}: ${oError.message}`);
    }
  }
  fSwitchCurrent(sRoot, sVersion);
  if (process.platform !== 'win32') execFileSync('chown', ['-R', sUser, sRoot]);
  console.log(`kktsite-agent ${sVersion} установлен в ${sRoot}`);

  // Установленный node запускается и грузит обёртку — иначе служба крутилась
  // бы в перезапусках без толку. Ошибка — с кодом выхода и выводом.
  const [sNode, [sMain]] = aRunInstalled(sRoot, []);
  console.log('Проверяю, что установленный агент запускается…');
  try {
    execFileSync(sNode, [sMain, '--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
  } catch (oError) {
    throw new Error(`Установленный агент не запускается (${sNode}): код ${oError.status ?? oError.signal ?? oError.code}\n${oError.stderr || ''}${oError.stdout || ''}`);
  }

  // Служба — в этом же процессе, с путями через current (не вложенным node:
  // одним местом, где сбой мог бы пройти молча, меньше).
  const aServiceArgs = [...aRest, ...(process.platform === 'win32' ? [] : ['--user', sUser])];
  console.log('Ставлю службу…');
  console.log(await oPlatformService().pInstall(oParseArgs(aServiceArgs), { sNode, sMain }));
  const nPort = Number(/--port(?:=|\s+)(\d+)/.exec(aRest.join(' '))?.[1] || 16732);
  fOpenSettingsPage(`http://127.0.0.1:${nPort}/`);
  return `Страница настроек: http://127.0.0.1:${nPort}/ — там добавьте ККТ.`;
}

export async function pUninstallCommand(aArgs) {
  fRequireAdmin();
  const { sDir: sRoot } = oSplitArgs(aArgs);
  if (!existsSync(sRoot)) return `В ${sRoot} агент не установлен.`;
  if (!existsSync(join(sRoot, 'current'))) {
    // Установка оборвалась до переключения current — служба не ставилась.
    rmSync(sRoot, { recursive: true, force: true });
    return `В ${sRoot} была недоделанная установка — убрана.`;
  }
  const [, [sMain]] = aRunInstalled(sRoot, []);
  try {
    console.log(await oPlatformService().pUninstall({ sMain }));
  } catch (oError) {
    console.log(`Служба: ${oError.message}`);
  }
  rmSync(sRoot, { recursive: true, force: true });
  return `kktsite-agent удалён из ${sRoot}. Данные агента (ККТ, учётки, сертификат) не тронуты.`;
}
