"use strict";
/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.argsToCommandLine = exports.WindowsPtyAgent = void 0;
var fs = require("fs");
var os = require("os");
var path = require("path");
var child_process_1 = require("child_process");
var net_1 = require("net");
var windowsConoutConnection_1 = require("./windowsConoutConnection");
var utils_1 = require("./utils");
var conptyNative;
var winptyNative;
/**
 * The amount of time to wait for additional data after the conpty shell process has exited before
 * shutting down the socket. The timer will be reset if a new data event comes in after the timer
 * has started.
 */
var FLUSH_DATA_INTERVAL = 1000;
/**
 * This agent sits between the WindowsTerminal class and provides a common interface for both conpty
 * and winpty.
 */
var WindowsPtyAgent = /** @class */ (function () {
    function WindowsPtyAgent(file, args, env, cwd, cols, rows, debug, _useConpty, _useConptyDll, conptyInheritCursor) {
        var _this = this;
        if (_useConptyDll === void 0) { _useConptyDll = false; }
        if (conptyInheritCursor === void 0) { conptyInheritCursor = false; }
        this._useConpty = _useConpty;
        this._useConptyDll = _useConptyDll;
        this._pid = 0;
        this._innerPid = 0;
        if (this._useConpty === undefined || this._useConpty === true) {
            this._useConpty = this._getWindowsBuildNumber() >= 18309;
        }
        if (this._useConpty) {
            if (!conptyNative) {
                conptyNative = utils_1.loadNativeModule('conpty').module;
            }
        }
        else {
            if (!winptyNative) {
                winptyNative = utils_1.loadNativeModule('pty').module;
            }
        }
        this._ptyNative = this._useConpty ? conptyNative : winptyNative;
        // Sanitize input variable.
        cwd = path.resolve(cwd);
        // Compose command line
        var commandLine = argsToCommandLine(file, args);
        // Open pty session.
        var term;
        if (this._useConpty) {
            term = this._ptyNative.startProcess(file, cols, rows, debug, this._generatePipeName(), conptyInheritCursor, this._useConptyDll);
        }
        else {
            term = this._ptyNative.startProcess(file, commandLine, env, cwd, cols, rows, debug);
            this._pid = term.pid;
            this._innerPid = term.innerPid;
        }
        // Not available on windows.
        this._fd = term.fd;
        // Generated incremental number that has no real purpose besides  using it
        // as a terminal id.
        this._pty = term.pty;
        // Create terminal pipe IPC channel and forward to a local unix socket.
        this._outSocket = new net_1.Socket();
        this._outSocket.setEncoding('utf8');
        // The conout socket must be ready out on another thread to avoid deadlocks
        this._conoutSocketWorker = new windowsConoutConnection_1.ConoutConnection(term.conout, this._useConptyDll);
        this._conoutSocketWorker.onReady(function () {
            _this._conoutSocketWorker.connectSocket(_this._outSocket);
        });
        this._outSocket.on('connect', function () {
            _this._outSocket.emit('ready_datapipe');
        });
        var inSocketFD = fs.openSync(term.conin, 'w');
        this._inSocket = new net_1.Socket({
            fd: inSocketFD,
            readable: false,
            writable: true
        });
        this._inSocket.setEncoding('utf8');
        if (this._useConpty) {
            var connect = this._ptyNative.connect(this._pty, commandLine, cwd, env, this._useConptyDll, function (c) { return _this._$onProcessExit(c); });
            this._innerPid = connect.pid;
        }
    }
    Object.defineProperty(WindowsPtyAgent.prototype, "inSocket", {
        get: function () { return this._inSocket; },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(WindowsPtyAgent.prototype, "outSocket", {
        get: function () { return this._outSocket; },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(WindowsPtyAgent.prototype, "fd", {
        get: function () { return this._fd; },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(WindowsPtyAgent.prototype, "innerPid", {
        get: function () { return this._innerPid; },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(WindowsPtyAgent.prototype, "pty", {
        get: function () { return this._pty; },
        enumerable: false,
        configurable: true
    });
    WindowsPtyAgent.prototype.resize = function (cols, rows) {
        if (this._useConpty) {
            if (this._exitCode !== undefined) {
                throw new Error('Cannot resize a pty that has already exited');
            }
            this._ptyNative.resize(this._pty, cols, rows, this._useConptyDll);
            return;
        }
        this._ptyNative.resize(this._pid, cols, rows);
    };
    WindowsPtyAgent.prototype.clear = function () {
        if (this._useConpty) {
            this._ptyNative.clear(this._pty, this._useConptyDll);
        }
    };
    WindowsPtyAgent.prototype.kill = function () {
        var _this = this;
        if (this._useConpty && !this._useConptyDll) {
            if (this._aetherClosePromise) return this._aetherClosePromise;
            this._aetherCleanupErrors = [];
            this._inSocket.readable = false;
            this._outSocket.readable = false;
            this._aetherClosePromise = Promise.resolve().then(function () {
                return _this._exitCode !== undefined ? [] : _this._getConsoleProcessList();
            }).catch(function (error) {
                // Only the known AttachConsole race with a confirmed exited shell is expected.
                var exited = _this._exitCode !== undefined;
                if (!exited && error.code === 'PTY_CONSOLE_QUERY_FAILED' && error.message === 'AttachConsole failed') {
                    try { process.kill(_this._innerPid, 0); }
                    catch (probeError) { exited = probeError.code === 'ESRCH'; }
                }
                if (!(exited && error.code === 'PTY_CONSOLE_QUERY_FAILED' && error.message === 'AttachConsole failed')) {
                    _this._aetherRecordCleanupError('console-query', error);
                }
                return [];
            }).then(function (processList) {
                // The list is queried while this console is still open. Never kill delayed PIDs
                // after ClosePseudoConsole, and never include the helper or this owner process.
                if (_this._exitCode === undefined) {
                    processList.forEach(function (pid) {
                        if (pid === process.pid) return;
                        try { process.kill(pid); }
                        catch (error) {
                            if (error.code !== 'ESRCH') _this._aetherRecordCleanupError('console-process-kill', error);
                        }
                    });
                }
                try { _this._ptyNative.kill(_this._pty, false); }
                catch (error) { _this._aetherRecordCleanupError('native-close', error); }
                return _this._aetherDisposeWorker();
            }).then(function () { return _this._aetherCleanupResult(); });
            return this._aetherClosePromise;
        }
        // Tell the agent to kill the pty, this releases handles to the process
        if (this._useConpty) {
            if (!this._useConptyDll) {
                this._inSocket.readable = false;
                this._outSocket.readable = false;
                this._getConsoleProcessList().then(function (consoleProcessList) {
                    consoleProcessList.forEach(function (pid) {
                        try {
                            process.kill(pid);
                        }
                        catch (e) {
                            // Ignore if process cannot be found (kill ESRCH error)
                        }
                    });
                });
                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._conoutSocketWorker.dispose();
            }
            else {
                // Close the input write handle to signal the end of session.
                this._inSocket.destroy();
                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._outSocket.on('data', function () {
                    _this._conoutSocketWorker.dispose();
                });
            }
        }
        else {
            // Because pty.kill closes the handle, it will kill most processes by itself.
            // Process IDs can be reused as soon as all handles to them are
            // dropped, so we want to immediately kill the entire console process list.
            // If we do not force kill all processes here, node servers in particular
            // seem to become detached and remain running (see
            // Microsoft/vscode#26807).
            var processList = this._ptyNative.getProcessList(this._pid);
            this._ptyNative.kill(this._pid, this._innerPid);
            processList.forEach(function (pid) {
                try {
                    process.kill(pid);
                }
                catch (e) {
                    // Ignore if process cannot be found (kill ESRCH error)
                }
            });
        }
    };
    WindowsPtyAgent.prototype._getConsoleProcessList = function () {
        var _this = this;
        return new Promise(function (resolve, reject) {
            var agent;
            var settled = false;
            var received = false;
            var result;
            var failure;
            var exitTimeout;
            function makeError(code, message, source) {
                var error = new Error(message);
                error.code = code;
                if (source && source.stack) error.stack = source.stack;
                if (source && source.name) error.name = source.name;
                return error;
            }
            function finish(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearTimeout(exitTimeout);
                if (agent) {
                    agent.removeListener('message', onMessage);
                    agent.removeListener('error', onError);
                    agent.removeListener('exit', onExit);
                    if (agent.connected) agent.disconnect();
                    // Own cleanup failures are observable; do not keep an abandoned IPC handle.
                    agent.unref();
                }
                if (error) reject(error); else resolve(result);
            }
            function stopHelper(error) {
                if (settled || exitTimeout) return;
                failure = error;
                clearTimeout(timeout);
                if (agent && agent.pid) {
                    try { agent.kill(); }
                    catch (killError) { failure = makeError('PTY_HELPER_KILL_FAILED', killError.message, killError); }
                    exitTimeout = setTimeout(function () {
                        finish(makeError('PTY_HELPER_EXIT_TIMEOUT', 'Console query helper did not exit after termination'));
                    }, 500);
                } else finish(error);
            }
            function onMessage(message) {
                if (settled || received || failure) return;
                received = true;
                if (!message || message.shellPid !== _this._innerPid) {
                    stopHelper(makeError('PTY_CONSOLE_QUERY_INVALID', 'Console query helper returned a mismatched shell PID'));
                    return;
                }
                if (message.error) {
                    failure = makeError('PTY_CONSOLE_QUERY_FAILED', message.error.message, message.error);
                } else if (Array.isArray(message.consoleProcessList) && message.consoleProcessList.every(function (pid) {
                    return Number.isSafeInteger(pid) && pid > 0 && pid !== agent.pid && pid !== process.pid;
                })) {
                    result = Array.from(new Set(message.consoleProcessList));
                } else {
                    failure = makeError('PTY_CONSOLE_QUERY_INVALID', 'Console query helper returned an invalid process list');
                }
                // Wait for the send callback and actual helper exit, bounded by the same deadline.
            }
            function onError(error) {
                stopHelper(makeError('PTY_CONSOLE_HELPER_ERROR', error.message, error));
            }
            function onExit(code, signal) {
                if (failure) finish(failure);
                else if (!received) finish(makeError('PTY_CONSOLE_HELPER_EXIT', 'Console query helper exited without a message: ' + code + '/' + signal));
                else if (code !== 0) finish(makeError('PTY_CONSOLE_HELPER_EXIT', 'Console query helper exited unsuccessfully: ' + code + '/' + signal));
                else finish();
            }
            var timeout = setTimeout(function () {
                stopHelper(makeError('PTY_CONSOLE_QUERY_TIMEOUT', 'Console process query exceeded 2000ms'));
            }, 2000);
            try {
                agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], {
                    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
                });
                agent.on('message', onMessage);
                agent.on('error', onError);
                agent.on('exit', onExit);
            } catch (error) { finish(makeError('PTY_CONSOLE_HELPER_ERROR', error.message, error)); }
        });
    };
    WindowsPtyAgent.prototype._aetherRecordCleanupError = function (phase, error) {
        if (!this._aetherCleanupErrors) this._aetherCleanupErrors = [];
        this._aetherCleanupErrors.push({ phase: phase, code: error.code || 'PTY_CLEANUP_ERROR',
            name: error.name || 'Error', message: error.message || String(error), stack: error.stack });
        // Preserve genuine diagnostic stderr for consumers that do not inspect cleanupError.
        console.error('[node-pty cleanup/' + phase + ']', error);
    };
    WindowsPtyAgent.prototype._aetherCleanupResult = function () {
        var errors = this._aetherCleanupErrors || [];
        return errors.length ? { cleanupError: { code: 'PTY_CLEANUP_FAILED',
            message: errors.map(function (error) { return error.phase + ': ' + error.message; }).join('; '), errors: errors.slice() } } : {};
    };
    WindowsPtyAgent.prototype._aetherDisposeWorker = function () {
        var _this = this;
        var timeout;
        return Promise.race([
            Promise.resolve().then(function () { return _this._conoutSocketWorker.dispose(); }),
            new Promise(function (_, reject) {
                timeout = setTimeout(function () {
                    var error = new Error('ConPTY output worker cleanup exceeded 4000ms');
                    error.code = 'PTY_WORKER_EXIT_TIMEOUT'; reject(error);
                }, 4000);
            })
        ]).catch(function (error) { _this._aetherRecordCleanupError('worker-dispose', error); })
            .then(function () { clearTimeout(timeout); });
    };
    WindowsPtyAgent.prototype.aetherCompleteClose = function () {
        var _this = this;
        if (this._aetherClosePromise) return this._aetherClosePromise;
        if (this._useConpty && !this._useConptyDll) {
            this._aetherClosePromise = this._aetherDisposeWorker().then(function () { return _this._aetherCleanupResult(); });
            return this._aetherClosePromise;
        }
        return Promise.resolve({});
    };
    Object.defineProperty(WindowsPtyAgent.prototype, "exitCode", {
        get: function () {
            if (this._useConpty) {
                return this._exitCode;
            }
            var winptyExitCode = this._ptyNative.getExitCode(this._innerPid);
            return winptyExitCode === -1 ? undefined : winptyExitCode;
        },
        enumerable: false,
        configurable: true
    });
    WindowsPtyAgent.prototype._getWindowsBuildNumber = function () {
        var osVersion = (/(\d+)\.(\d+)\.(\d+)/g).exec(os.release());
        var buildNumber = 0;
        if (osVersion && osVersion.length === 4) {
            buildNumber = parseInt(osVersion[3]);
        }
        return buildNumber;
    };
    WindowsPtyAgent.prototype._generatePipeName = function () {
        return "conpty-" + Math.random() * 10000000;
    };
    /**
     * Triggered from the native side when a contpy process exits.
     */
    WindowsPtyAgent.prototype._$onProcessExit = function (exitCode) {
        var _this = this;
        this._exitCode = exitCode;
        if (!this._useConptyDll) {
            this._flushDataAndCleanUp();
            this._outSocket.on('data', function () { return _this._flushDataAndCleanUp(); });
        }
    };
    WindowsPtyAgent.prototype._flushDataAndCleanUp = function () {
        var _this = this;
        if (this._useConptyDll) {
            return;
        }
        if (this._closeTimeout) {
            clearTimeout(this._closeTimeout);
        }
        this._closeTimeout = setTimeout(function () { return _this._cleanUpProcess(); }, FLUSH_DATA_INTERVAL);
    };
    WindowsPtyAgent.prototype._cleanUpProcess = function () {
        if (this._useConptyDll) {
            return;
        }
        this._inSocket.readable = false;
        this._outSocket.readable = false;
        this._outSocket.destroy();
    };
    return WindowsPtyAgent;
}());
exports.WindowsPtyAgent = WindowsPtyAgent;
// Convert argc/argv into a Win32 command-line following the escaping convention
// documented on MSDN (e.g. see CommandLineToArgvW documentation). Copied from
// winpty project.
function argsToCommandLine(file, args) {
    if (isCommandLine(args)) {
        if (args.length === 0) {
            return file;
        }
        return argsToCommandLine(file, []) + " " + args;
    }
    var argv = [file];
    Array.prototype.push.apply(argv, args);
    var result = '';
    for (var argIndex = 0; argIndex < argv.length; argIndex++) {
        if (argIndex > 0) {
            result += ' ';
        }
        var arg = argv[argIndex];
        // if it is empty or it contains whitespace and is not already quoted
        var hasLopsidedEnclosingQuote = xOr((arg[0] !== '"'), (arg[arg.length - 1] !== '"'));
        var hasNoEnclosingQuotes = ((arg[0] !== '"') && (arg[arg.length - 1] !== '"'));
        var quote = arg === '' ||
            (arg.indexOf(' ') !== -1 ||
                arg.indexOf('\t') !== -1) &&
                ((arg.length > 1) &&
                    (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes));
        if (quote) {
            result += '\"';
        }
        var bsCount = 0;
        for (var i = 0; i < arg.length; i++) {
            var p = arg[i];
            if (p === '\\') {
                bsCount++;
            }
            else if (p === '"') {
                result += repeatText('\\', bsCount * 2 + 1);
                result += '"';
                bsCount = 0;
            }
            else {
                result += repeatText('\\', bsCount);
                bsCount = 0;
                result += p;
            }
        }
        if (quote) {
            result += repeatText('\\', bsCount * 2);
            result += '\"';
        }
        else {
            result += repeatText('\\', bsCount);
        }
    }
    return result;
}
exports.argsToCommandLine = argsToCommandLine;
function isCommandLine(args) {
    return typeof args === 'string';
}
function repeatText(text, count) {
    var result = '';
    for (var i = 0; i < count; i++) {
        result += text;
    }
    return result;
}
function xOr(arg1, arg2) {
    return ((arg1 && !arg2) || (!arg1 && arg2));
}
//# sourceMappingURL=windowsPtyAgent.js.map
