"use strict";
/** Copyright (c) 2019, Microsoft Corporation (MIT License).
 * Aether node-pty 1.1.0 system ConPTY close repair. No native ABI changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
var shellPid = Number(process.argv[2]);
var message;
try {
    if (!Number.isSafeInteger(shellPid) || shellPid <= 0) throw new Error('Invalid console shell PID');
    var getConsoleProcessList = require('./utils').loadNativeModule('conpty_console_list').module.getConsoleProcessList;
    message = { shellPid: shellPid, consoleProcessList: getConsoleProcessList(shellPid).filter(function (pid) { return pid !== process.pid; }) };
} catch (error) {
    message = { shellPid: shellPid, error: { name: error.name, message: error.message, code: error.code, stack: error.stack } };
}
if (!process.send || !process.connected) {
    console.error('[node-pty console helper] IPC unavailable', message.error || message);
    process.exitCode = 1;
} else {
    process.send(message, function (error) {
        if (error) console.error('[node-pty console helper] IPC send failed', error);
        if (process.connected) process.disconnect();
        process.exit(error ? 1 : 0);
    });
}
