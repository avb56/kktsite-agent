// Windows-архив на обе разрядности: выбор по драйверу Атола, свой zip.
// Реестр подменяется — тесты идут на любой ОС.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sTmp = mkdtempSync(join(tmpdir(), 'kkt-agent-win-'));
process.env.KKT_AGENT_DATA = join(sTmp, 'data');
after(() => rmSync(sTmp, { recursive: true, force: true }));

const { aAtolDriverArchs, sChooseArch, bWindows64, sPeArch, aShtrihDriverArchs, sArchMismatch } = await import('../src/winreg.js');
const { bNotInstalled } = await import('../src/driver.js');
const { pChooseSource, fCopyDir } = await import('../src/installer.js');
const { pWriteZip } = await import('../scripts/zip.mjs');
const { pPackTarGz } = await import('../src/tar.js');

/** Подложный reg query: ключ есть в перечисленных представлениях. */
const fReg = (aViews) => (aArgs) => {
  if (!aViews.includes(aArgs.at(-1))) throw new Error('ERROR: The system was unable to find the specified registry key');
  return '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\ATOL\\Drivers\\10.0\\KKT\r\n    INSTALL_DIR    REG_SZ    C:\\Program Files\\ATOL\\Drivers10\\KKT\r\n';
};
const oEnv64 = { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' }; // 32-битный node на 64-битной Windows
const oEnv32 = { PROCESSOR_ARCHITECTURE: 'x86' };

test('разрядность драйвера Атола по реестру', () => {
  assert.equal(bWindows64(oEnv64), true);
  assert.equal(bWindows64({ PROCESSOR_ARCHITECTURE: 'AMD64' }), true);
  assert.equal(bWindows64(oEnv32), false);
  assert.deepEqual(aAtolDriverArchs({ fRun: fReg(['/reg:32']), oEnv: oEnv64 }), ['ia32'], '32-битный драйвер на 64-битной Windows');
  assert.deepEqual(aAtolDriverArchs({ fRun: fReg(['/reg:64']), oEnv: oEnv64 }), ['x64']);
  assert.deepEqual(aAtolDriverArchs({ fRun: fReg(['/reg:64', '/reg:32']), oEnv: oEnv64 }), ['x64', 'ia32']);
  assert.deepEqual(aAtolDriverArchs({ fRun: fReg(['/reg:64', '/reg:32']), oEnv: oEnv32 }), ['ia32'], 'на 32-битной Windows /reg:64 не считается');
  assert.deepEqual(aAtolDriverArchs({ fRun: fReg([]), oEnv: oEnv64 }), []);
  assert.equal(sChooseArch(['x64', 'ia32']), 'x64');
  assert.equal(sChooseArch(['ia32']), 'ia32');
  assert.equal(sChooseArch([]), '');
});

test('установщик: из архива на обе разрядности — под драйвер Атола, иначе Посцентра, иначе Windows', async () => {
  const sPack = join(sTmp, 'kktsite-agent-0.2.0-windows');
  for (const sArch of ['x64', 'ia32']) mkdirSync(join(sPack, sArch, 'app'), { recursive: true });
  const sFromIa32 = join(sPack, 'ia32'); // install.cmd запускает 32-битную половину
  const fNoShtrih = () => assert.fail('драйвер Атола найден — Посцентр не смотрим');
  assert.equal(await pChooseSource(sFromIa32, '', { fDriverArchs: () => ['ia32'], fShtrihArchs: fNoShtrih }), join(sPack, 'ia32'));
  assert.equal(await pChooseSource(sFromIa32, '', { fDriverArchs: () => ['x64'], fShtrihArchs: fNoShtrih }), join(sPack, 'x64'));
  assert.equal(await pChooseSource(sFromIa32, 'ia32', { fDriverArchs: () => assert.fail('--arch — реестр не нужен') }), join(sPack, 'ia32'), '--arch важнее');
  // Атола нет — по драйверу Посцентра; нет и его — по Windows, без вопросов.
  assert.equal(await pChooseSource(sFromIa32, '', { fDriverArchs: () => [], fShtrihArchs: () => ['ia32'], bOs64: true }), join(sPack, 'ia32'));
  assert.equal(await pChooseSource(sFromIa32, '', { fDriverArchs: () => [], fShtrihArchs: () => [], bOs64: true }), join(sPack, 'x64'));
  assert.equal(await pChooseSource(sFromIa32, '', { fDriverArchs: () => [], fShtrihArchs: () => [], bOs64: false }), join(sPack, 'ia32'));

  const sSingle = join(sTmp, 'kktsite-agent-0.2.0-linux-x64');
  mkdirSync(join(sSingle, 'app'), { recursive: true });
  assert.equal(await pChooseSource(sSingle, '', { fDriverArchs: () => assert.fail('реестр не нужен') }), sSingle, 'архив одной платформы — как есть');
});

function aPythonZipInfo(sZip) {
  // На Windows-раннерах GitHub Python — `python`, на остальных — `python3`.
  return JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, i.compress_type, i.flag_bits, i.extra.hex()] for i in z.infolist()]))
`, sZip], { encoding: 'utf8' }));
}

test('zip: читается, без zip64 и дескрипторов данных, только ASCII-имена', async () => {
  const sSrc = join(sTmp, 'zip-src');
  mkdirSync(join(sSrc, 'sub'), { recursive: true });
  writeFileSync(join(sSrc, 'a.txt'), 'повторяется '.repeat(500));
  writeFileSync(join(sSrc, 'sub', 'empty'), '');
  const sZip = join(sTmp, 't.zip');
  await pWriteZip(sSrc, sZip, 'top');
  const aInfo = aPythonZipInfo(sZip);
  assert.deepEqual(aInfo.map((a) => a[0]), ['top/', 'top/a.txt', 'top/sub/', 'top/sub/empty']);
  assert.equal(aInfo.find((a) => a[0] === 'top/a.txt')[1], 8, 'сжимаемое — deflate');
  for (const [sName, , nFlags, sExtra] of aInfo) {
    assert.equal(nFlags & 0x08, 0, `${sName}: без дескриптора данных`);
    assert.equal(sExtra, '', `${sName}: без extra (zip64)`);
  }

  writeFileSync(join(sSrc, 'файл.txt'), 'x');
  await assert.rejects(pWriteZip(sSrc, join(sTmp, 'bad.zip'), 'top'), /не ASCII/);
});

test('Windows-zip на обе разрядности из двух tar.gz', async () => {
  const sFiles = join(sTmp, 'files');
  mkdirSync(sFiles, { recursive: true });
  for (const sArch of ['x64', 'ia32']) {
    const sStage = join(sTmp, `stage-${sArch}`);
    mkdirSync(join(sStage, 'node'), { recursive: true });
    mkdirSync(join(sStage, 'app', 'src'), { recursive: true });
    writeFileSync(join(sStage, 'node', 'node.exe'), sArch);
    writeFileSync(join(sStage, 'app', 'src', 'main.js'), '//');
    for (const sFile of ['install.cmd', 'uninstall.cmd', 'README.txt', 'install.sh', 'uninstall.sh']) writeFileSync(join(sStage, sFile), sFile);
    await pPackTarGz(sStage, join(sFiles, `kktsite-agent-0.2.0-windows-${sArch}.tar.gz`), `kktsite-agent-0.2.0-windows-${sArch}`);
  }
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/pack-windows.mjs', import.meta.url)), sFiles], { stdio: 'pipe' });
  const aNames = aPythonZipInfo(join(sFiles, 'kktsite-agent-0.2.0-windows.zip')).map((a) => a[0]);
  const sTop = 'kktsite-agent-0.2.0-windows/';
  for (const sName of ['install.cmd', 'uninstall.cmd', 'README.txt', 'x64/node/node.exe', 'ia32/node/node.exe', 'x64/app/src/main.js', 'ia32/app/src/main.js']) {
    assert.ok(aNames.includes(sTop + sName), `есть ${sName}`);
  }
  assert.ok(!aNames.some((s) => s.endsWith('.sh')), 'сценариев Linux в Windows-zip нет');
  assert.ok(!aNames.includes(`${sTop}x64/install.cmd`), 'сценарии — только наверху');
  assert.equal(readFileSync(join(sFiles, 'kktsite-agent-0.2.0-windows-x64.tar.gz')).length > 0, true, 'tar.gz на разрядность остаются');
});

test('установщик копирует каталог сам, кириллица в пути — не помеха', () => {
  // fs.cpSync в Node 22 на Windows молча ронял процесс на таком пути (installer.js).
  const sFrom = join(sTmp, 'Загрузки', 'kktsite-agent-0.2.0-windows', 'ia32');
  mkdirSync(join(sFrom, 'app', 'src'), { recursive: true });
  mkdirSync(join(sFrom, 'node'), { recursive: true });
  writeFileSync(join(sFrom, 'node', 'node.exe'), 'exe');
  writeFileSync(join(sFrom, 'app', 'src', 'main.js'), '// main');
  const sTo = join(sTmp, 'Program Files', 'kktsite-agent', 'versions', '0.2.0');
  fCopyDir(sFrom, sTo);
  assert.equal(readFileSync(join(sTo, 'node', 'node.exe'), 'utf8'), 'exe');
  assert.equal(readFileSync(join(sTo, 'app', 'src', 'main.js'), 'utf8'), '// main');
});

test('Windows-zip для Windows 7 — из windows7-x64 и windows7-ia32', async () => {
  const sFiles = join(sTmp, 'files7');
  mkdirSync(sFiles, { recursive: true });
  for (const sArch of ['x64', 'ia32']) {
    const sStage = join(sTmp, `stage7-${sArch}`);
    mkdirSync(join(sStage, 'node'), { recursive: true });
    mkdirSync(join(sStage, 'app', 'src'), { recursive: true });
    writeFileSync(join(sStage, 'node', 'node.exe'), `node12-${sArch}`);
    writeFileSync(join(sStage, 'app', 'src', 'main.js'), '//');
    writeFileSync(join(sStage, 'install.cmd'), 'cmd');
    await pPackTarGz(sStage, join(sFiles, `kktsite-agent-0.2.2-windows7-${sArch}.tar.gz`), `kktsite-agent-0.2.2-windows7-${sArch}`);
  }
  const sScript = fileURLToPath(new URL('../scripts/pack-windows.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [sScript, sFiles], { stdio: 'pipe' }), /windows-x64/, 'без --family ищет сборки для 10/11');
  execFileSync(process.execPath, [sScript, sFiles, '--family', 'windows7'], { stdio: 'pipe' });
  const aNames = aPythonZipInfo(join(sFiles, 'kktsite-agent-0.2.2-windows7.zip')).map((a) => a[0]);
  assert.ok(aNames.includes('kktsite-agent-0.2.2-windows7/ia32/node/node.exe'));
  assert.ok(aNames.includes('kktsite-agent-0.2.2-windows7/install.cmd'));
});

test('разрядность DLL по заголовку PE, поиск драйвера Посцентра, подсказки', () => {
  const fPe = (nMachine) => {
    const a = Buffer.alloc(0x100);
    a.writeUInt16LE(0x5a4d, 0);
    a.writeUInt32LE(0x80, 0x3c);
    a.writeUInt32LE(0x4550, 0x80);
    a.writeUInt16LE(nMachine, 0x84);
    return a;
  };
  assert.equal(sPeArch('x', { fRead: () => fPe(0x8664) }), 'x64');
  assert.equal(sPeArch('x', { fRead: () => fPe(0x14c) }), 'ia32');
  assert.equal(sPeArch('x', { fRead: () => null }), '');
  assert.equal(sPeArch('x', { fRead: () => Buffer.from('не PE, просто текст, длиннее шестидесяти четырёх байт для проверки') }), '');

  const oFiles = { [join('D:\\pc', 'classic_fr_drv_ng.dll')]: 'ia32', [join('C:\\W', 'System32', 'classic_fr_drv_ng.dll')]: 'x64' };
  const fArch = (sFile) => oFiles[sFile] || '';
  assert.deepEqual(aShtrihDriverArchs({ oEnv: { PATH: 'D:\\pc;E:\\x', SystemRoot: 'C:\\W' }, fArch }), ['ia32', 'x64']);
  assert.deepEqual(aShtrihDriverArchs({ oEnv: { SystemRoot: 'C:\\W' }, fArch }), ['x64']);
  assert.deepEqual(aShtrihDriverArchs({ sPath: join('D:\\pc', 'classic_fr_drv_ng.dll'), oEnv: { SystemRoot: 'Z:' }, fArch }), ['ia32'], 'путь к самой DLL');

  assert.equal(sArchMismatch('Атола', [], { sOwn: 'x64' }), '', 'драйвера нет — молчим');
  assert.equal(sArchMismatch('Атола', ['x64'], { sOwn: 'x64' }), '');
  assert.match(sArchMismatch('Атола', ['ia32'], { sOwn: 'x64' }), /32-разрядный драйвер Атола, а агент 64-разрядный: переустановите агента/);
  assert.match(sArchMismatch('Посцентра', ['ia32'], { sOwn: 'x64', aAtolArchs: ['x64'] }), /поставьте 64-разрядный драйвер Посцентра/, 'агент совпадает с Атолом — менять драйвер Посцентра');
  assert.match(sArchMismatch('Посцентра', ['ia32'], { sOwn: 'x64' }), /переустановите агента/);

  const sHead = 'ATOL DTO 10 driver library not found. Tried:\n';
  assert.equal(bNotInstalled(`${sHead}  /x/libfptr10.so: /x/libfptr10.so: cannot open shared object file: No such file or directory\n  <system library path>: libfptr10.so: cannot open shared object file: No such file or directory`, 'linux'), true);
  assert.equal(bNotInstalled(`${sHead}  /x/libfptr10.so: libdep.so.1: cannot open shared object file: No such file or directory`, 'linux'), false, 'файл есть, нет зависимости — не «нет драйвера»');
});

// «Windows error 126» драйвера Посцентра — словами (стенд, Windows 10 x64, 26.11.2026).
test('sShtrihLoadHint: нет файла по пути, файл глубже, нет Visual C++', async () => {
  const { sShtrihLoadHint } = await import('../src/winreg.js');
  const { join } = await import('node:path');
  const oEnv = { SystemRoot: 'W' };
  const sDeep = join('D', 'dist', 'win_1.6', 'x86_64', 'dynamic', 'classic_fr_drv_ng.dll');
  const sDeep32 = join('D', 'dist', 'win_1.6', 'i386', 'dynamic', 'classic_fr_drv_ng.dll');
  const oBase = { sOwn: 'x64', oEnv, fDir: s => s === 'D', fFind: () => [sDeep32, sDeep], fArch: s => (s.includes('x86_64') ? 'x64' : 'ia32') };
  // Указан корень архива — подсказать 64-разрядную DLL глубже.
  assert.match(sShtrihLoadHint({ ...oBase, sPath: 'D', fExists: () => false }), /глубже\. Укажите папку «D.dist.win_1\.6.x86_64.dynamic»/);
  // Пути нет вовсе.
  assert.match(sShtrihLoadHint({ ...oBase, sPath: 'X', fExists: () => false }), /По пути «X» нет файла classic_fr_drv_ng\.dll.*x86_64\\dynamic/);
  // Файл есть, Visual C++ нет ни рядом, ни в System32.
  const aHave = [join('E', 'classic_fr_drv_ng.dll')];
  assert.match(sShtrihLoadHint({ ...oBase, sPath: 'E', fExists: s => aHave.includes(s) }), /Visual C\+\+ 2015–2022 \(64-разрядный\): нет msvcp140\.dll, vcruntime140\.dll\. Поставьте vc_redist\.x64\.exe/);
  // Visual C++ в System32 — дело не в нём.
  aHave.push(join('W', 'System32', 'msvcp140.dll'), join('W', 'System32', 'vcruntime140.dll'));
  assert.match(sShtrihLoadHint({ ...oBase, sPath: 'E', fExists: s => aHave.includes(s) }), /распакуйте папку x86_64\\dynamic/);
  // Путь не задан и драйвера в системе нет — не ставили, молчим.
  assert.equal(sShtrihLoadHint({ ...oBase, sPath: '', fExists: () => false }), '');
  // 32-разрядный агент — x86.
  assert.match(sShtrihLoadHint({ ...oBase, sOwn: 'ia32', sPath: 'E', fExists: s => s === join('E', 'classic_fr_drv_ng.dll') }), /vc_redist\.x86\.exe/);
});
