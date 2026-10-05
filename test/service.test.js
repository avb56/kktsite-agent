// Тексты службы для трёх ОС — без установки: установка проверяется руками
// (README, «Автозапуск»), здесь — что в службу попадает то, что нужно.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oParseArgs, oServiceEnv, sLaunchdPlist, sSystemdUnit, sWindowsRunner } from '../src/service.js';

const oBase = {
  sUser: 'kassa',
  sNode: '/usr/bin/node',
  sMain: '/opt/kktsite agent/src/main.js',
  oEnv: { KKT_AGENT_PORT: '16733' },
  sDataDir: '/home/kassa/.config/kktsite-agent',
};

test('параметры install', () => {
  assert.deepEqual(oParseArgs(['--port', '16733', '--user=kassa']), { port: '16733', user: 'kassa' });
  assert.deepEqual(oParseArgs(['--https-port=16734']), { 'https-port': '16734' });
  assert.throws(() => oParseArgs(['--port', 'abc']), /Неверный порт/);
  assert.throws(() => oParseArgs(['--pigeon']), /Неизвестный параметр/);
  assert.throws(() => oParseArgs(['--user']), /нет значения/);
});

test('окружение службы: параметры важнее окружения, пустое не пишется', () => {
  const oEnv = { KKT_AGENT_PORT: '1', KKT_AGENT_DRIVER: '/usr/lib' };
  assert.deepEqual(oServiceEnv({ port: '16733' }, oEnv), { KKT_AGENT_PORT: '16733', KKT_AGENT_DRIVER: '/usr/lib' });
  assert.deepEqual(oServiceEnv({}, {}), {});
});

test('systemd: пользователь, окружение, путь с пробелом, перезапуск', () => {
  const sUnit = sSystemdUnit(oBase);
  assert.match(sUnit, /^User=kassa$/m);
  assert.match(sUnit, /^Environment="KKT_AGENT_PORT=16733"$/m);
  assert.match(sUnit, /^Environment="KKT_AGENT_DATA=\/home\/kassa\/.config\/kktsite-agent"$/m);
  assert.match(sUnit, /^ExecStart="\/usr\/bin\/node" "\/opt\/kktsite agent\/src\/main.js"$/m);
  assert.match(sUnit, /^Restart=always$/m);
  assert.match(sUnit, /^WantedBy=multi-user.target$/m);
  assert.doesNotMatch(sUnit, /User=root/);
});

test('launchd: UserName, KeepAlive, XML экранирован', () => {
  const sPlist = sLaunchdPlist({ ...oBase, oEnv: { KKT_AGENT_DRIVER: '/a&b<c' } });
  assert.match(sPlist, /<key>UserName<\/key><string>kassa<\/string>/);
  assert.match(sPlist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(sPlist, /<string>\/a&amp;b&lt;c<\/string>/);
});

test('Windows: run.cmd с циклом перезапуска и CRLF', () => {
  const sCmd = sWindowsRunner({
    sNode: 'C:\\Program Files\\nodejs\\node.exe',
    sMain: 'C:\\kkt\\src\\main.js',
    oEnv: { KKT_AGENT_PORT: '16733' },
    sDataDir: 'C:\\ProgramData\\kktsite-agent',
  });
  assert.match(sCmd, /set "KKT_AGENT_PORT=16733"\r\n/);
  assert.match(sCmd, /set "KKT_AGENT_DATA=C:\\ProgramData\\kktsite-agent"/);
  assert.match(sCmd, /"C:\\Program Files\\nodejs\\node.exe" "C:\\kkt\\src\\main.js" >> /);
  assert.match(sCmd, /goto loop/);
  assert.doesNotMatch(sCmd, /^timeout /m, 'timeout без консоли не ждёт');
  assert.match(sCmd, /^ping -n 6 127\.0\.0\.1 >nul\r$/m);
  assert.doesNotMatch(sCmd.replace(/\r\n/g, ''), /\n/, 'только CRLF');
});
