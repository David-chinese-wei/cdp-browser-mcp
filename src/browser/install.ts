import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'chromium' | 'opera' | 'vivaldi' | 'auto';

export interface InstalledBrowser {
  kind: BrowserKind;
  display: string;
  executable: string;
}

const ORDER: BrowserKind[] = ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'opera'];

function candidates(): Array<{ kind: BrowserKind; display: string; paths: string[] }> {
  const os = platform();
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  if (os === 'win32') {
    return [
      {
        kind: 'chrome',
        display: 'Google Chrome',
        paths: [
          join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ],
      },
      {
        kind: 'edge',
        display: 'Microsoft Edge',
        paths: [
          join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ],
      },
      {
        kind: 'brave',
        display: 'Brave',
        paths: [join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
      },
      {
        kind: 'vivaldi',
        display: 'Vivaldi',
        paths: [join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe')],
      },
      {
        kind: 'opera',
        display: 'Opera',
        paths: [
          join(localAppData, 'Programs', 'Opera', 'opera.exe'),
          join(programFiles, 'Opera', 'opera.exe'),
        ],
      },
      {
        kind: 'chromium',
        display: 'Chromium',
        paths: [join(localAppData, 'Chromium', 'Application', 'chrome.exe')],
      },
    ];
  }

  if (os === 'darwin') {
    return [
      { kind: 'chrome', display: 'Google Chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
      {
        kind: 'edge',
        display: 'Microsoft Edge',
        paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      },
      {
        kind: 'brave',
        display: 'Brave',
        paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      },
      { kind: 'chromium', display: 'Chromium', paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
      { kind: 'vivaldi', display: 'Vivaldi', paths: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'] },
      { kind: 'opera', display: 'Opera', paths: ['/Applications/Opera.app/Contents/MacOS/Opera'] },
    ];
  }

  return [
    { kind: 'chrome', display: 'Google Chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'] },
    { kind: 'chromium', display: 'Chromium', paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
    { kind: 'edge', display: 'Microsoft Edge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { kind: 'brave', display: 'Brave', paths: ['/usr/bin/brave-browser', '/usr/bin/brave'] },
  ];
}

/** Locate an installed Chromium based browser. */
export function findInstalledBrowser(preferred: BrowserKind = 'auto'): InstalledBrowser | null {
  const all = candidates();
  if (preferred !== 'auto') {
    const hit = all.find((c) => c.kind === preferred);
    const path = hit?.paths.find((p) => existsSync(p));
    if (hit && path) return { kind: hit.kind, display: hit.display, executable: path };
  }
  for (const kind of ORDER) {
    const hit = all.find((c) => c.kind === kind);
    const path = hit?.paths.find((p) => existsSync(p));
    if (hit && path) return { kind: hit.kind, display: hit.display, executable: path };
  }
  return null;
}

export function listInstalledBrowsers(): InstalledBrowser[] {
  const out: InstalledBrowser[] = [];
  for (const c of candidates()) {
    const path = c.paths.find((p) => existsSync(p));
    if (path) out.push({ kind: c.kind, display: c.display, executable: path });
  }
  return out;
}
