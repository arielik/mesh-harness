// `mesh up --install`: run the daemon as a user service (launchd on macOS, systemd on Linux).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ServiceSpec {
  node: string;
  script: string;
  path: string;
  logFile: string;
}

export const LAUNCHD_LABEL = "dev.mesh-harness.daemon";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(s: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(s.node)}</string>
    <string>${xml(s.script)}</string>
    <string>up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(s.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(s: ServiceSpec): string {
  const q = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  return `[Unit]
Description=mesh-harness daemon (watches your Claude Code sessions)
After=default.target

[Service]
ExecStart=${q(s.node)} ${q(s.script)} up
Environment=PATH=${s.path}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export interface InstalledService {
  file: string;
  enable: string[];
  disable: string[];
}

export function installService(platform: NodeJS.Platform, home: string, s: ServiceSpec): InstalledService {
  if (platform === "darwin") {
    const file = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, launchdPlist(s));
    return {
      file,
      enable: [`launchctl bootstrap gui/$(id -u) ${file}`],
      disable: [`launchctl bootout gui/$(id -u) ${file}`],
    };
  }
  if (platform === "linux") {
    const file = join(home, ".config", "systemd", "user", "mesh.service");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(s));
    return {
      file,
      enable: ["systemctl --user daemon-reload", "systemctl --user enable --now mesh.service"],
      disable: ["systemctl --user disable --now mesh.service"],
    };
  }
  throw new Error(`service install is not supported on ${platform}; run "mesh up" yourself`);
}
