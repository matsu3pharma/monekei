'use strict';
// OS の機能を呼ぶ部分（ブラウザで開く・設定ファイルをテキストエディタで開く）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

// 既定のブラウザで開く
function openUrl(url) {
  if (process.platform === 'win32') return run('explorer.exe', [url]);
  if (process.platform === 'darwin') return run('open', [url]);
  return run('xdg-open', [url]);
}

function existing(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || null;
}

// Chrome / Edge があれば、アドレスバー等の無い「アプリ用ウィンドウ」で開く。無ければ既定のブラウザ。
async function openAppWindow(url) {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
    const exe = existing(
      roots.flatMap((r) =>
        r
          ? [path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')]
          : []
      )
    );
    if (exe && (await run(exe, [`--app=${url}`]))) return true;
  } else if (process.platform === 'darwin') {
    const app = existing(['/Applications/Google Chrome.app', '/Applications/Microsoft Edge.app', '/Applications/Brave Browser.app']);
    // -n: Chrome がすでに起動していても --app の指定を渡す
    if (app && (await run('open', ['-na', app, '--args', `--app=${url}`]))) return true;
  }
  return openUrl(url);
}

// 設定ファイルをテキストエディタで開く（Windows: メモ帳 / Mac: テキストエディット）
function openFile(file) {
  if (process.platform === 'win32') return run('notepad.exe', [file]);
  if (process.platform === 'darwin') return run('open', ['-t', file]);
  return run('xdg-open', [file]);
}

// 黒い画面が無いアプリとして動くときのエラー表示用（OK を押すまで待つ）
function alert(title, message) {
  return new Promise((resolve) => {
    let child;
    try {
      if (process.platform === 'win32') {
        const ps =
          'Add-Type -AssemblyName PresentationFramework;' +
          `[System.Windows.MessageBox]::Show($env:PSM_MSG, $env:PSM_TITLE) | Out-Null`;
        child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, PSM_MSG: message, PSM_TITLE: title },
        });
      } else if (process.platform === 'darwin') {
        const script = 'on run argv\ndisplay alert (item 1 of argv) message (item 2 of argv)\nend run';
        child = spawn('osascript', ['-e', script, title, message], { stdio: 'ignore' });
      } else {
        child = spawn('xmessage', [`${title}\n\n${message}`], { stdio: 'ignore' });
      }
    } catch {
      resolve();
      return;
    }
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

// Windows: デスクトップにショートカットを作る（OneDrive でデスクトップが移動していても正しい場所に作る）
function createWindowsShortcut(name, target, workingDir) {
  return new Promise((resolve) => {
    const ps =
      "$d=[Environment]::GetFolderPath('Desktop');" +
      '$p=Join-Path $d ($env:PSM_NAME + ".lnk");' +
      'if (Test-Path $p) { exit 0 };' +
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);' +
      '$s.TargetPath=$env:PSM_TARGET;$s.WorkingDirectory=$env:PSM_DIR;$s.IconLocation=$env:PSM_TARGET + ",0";$s.Save()';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PSM_NAME: name, PSM_TARGET: target, PSM_DIR: workingDir },
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

module.exports = { openUrl, openAppWindow, openFile, alert, createWindowsShortcut };
