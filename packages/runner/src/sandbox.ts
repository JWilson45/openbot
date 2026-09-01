import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SandboxMode = "auto" | "none" | "bwrap" | "seatbelt" | "required";

export type SandboxPolicy = {
  openbotHome: string;
  desk: string;
  grokHome: string;
  operatorHome?: string;
  extraRead?: string[];
};

export type SandboxWrap = {
  cmd: string[];
  backend: "none" | "bwrap" | "seatbelt";
  reason: string;
};

export class SandboxRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRequiredError";
  }
}

export function sandboxModeFromEnv(raw = process.env.OPENBOT_SANDBOX): SandboxMode {
  const v = (raw ?? "auto").trim().toLowerCase();
  if (v === "none" || v === "off" || v === "0") return "none";
  if (v === "bwrap" || v === "seatbelt" || v === "required" || v === "auto") return v;
  return "auto";
}

function which(bin: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function vaultFiles(openbotHome: string): string[] {
  return [
    join(openbotHome, "master.key"),
    join(openbotHome, "org.ed25519"),
    join(openbotHome, "allowlist"),
    join(openbotHome, "openbot.sqlite"),
    join(openbotHome, "openbot.sqlite-wal"),
    join(openbotHome, "openbot.sqlite-shm"),
  ];
}

function dockerSocks(): string[] {
  return ["/var/run/docker.sock", "/run/docker.sock"];
}

function sensitiveHomeDirs(operatorHome: string): string[] {
  return [
    join(operatorHome, ".ssh"),
    join(operatorHome, ".gnupg"),
    join(operatorHome, ".aws"),
    join(operatorHome, ".grok"),
    join(operatorHome, ".config", "gh"),
  ];
}

export function seatbeltProfile(policy: SandboxPolicy): string {
  const op = policy.operatorHome ?? "";
  const denySub: string[] = [];
  if (op) denySub.push(`(subpath "${op}")`);
  denySub.push(`(subpath "${policy.openbotHome}")`);
  const allowSub = [`(subpath "${policy.desk}")`, `(subpath "${policy.grokHome}")`];
  for (const p of policy.extraRead ?? []) allowSub.push(`(subpath "${dirname(p)}")`);
  const denyLit = [...vaultFiles(policy.openbotHome), ...dockerSocks()].map((p) => `(literal "${p}")`);
  return `(version 1)
(allow default)
(deny file-read* file-write*
  ${denySub.join("\n  ")}
)
(allow file-read* file-write*
  ${allowSub.join("\n  ")}
)
(deny file-read* file-write*
  ${denyLit.join("\n  ")}
)
`;
}

export function bwrapArgs(policy: SandboxPolicy): string[] {
  const args = [
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    policy.desk,
    policy.desk,
    "--bind",
    policy.grokHome,
    policy.grokHome,
  ];
  for (const f of vaultFiles(policy.openbotHome)) {
    if (existsSync(f)) args.push("--bind", "/dev/null", f);
  }
  for (const sock of dockerSocks()) {
    if (existsSync(sock)) args.push("--bind", "/dev/null", sock);
  }
  const op = policy.operatorHome;
  if (op) {
    for (const dir of sensitiveHomeDirs(op)) {
      if (existsSync(dir)) args.push("--tmpfs", dir);
    }
  }
  return args;
}

function extraReadFromCmd(cmd: string[]): string[] {
  const out: string[] = [];
  const bin = cmd[0];
  if (!bin) return out;
  try {
    const resolved = bin.includes("/") ? resolve(bin) : which(bin);
    if (resolved && existsSync(resolved)) out.push(realpathSync(resolved));
  } catch {
    /* ignore */
  }
  if (cmd[1] && (cmd[1].endsWith(".ts") || cmd[1].endsWith(".js"))) {
    try {
      out.push(realpathSync(resolve(cmd[1])));
    } catch {
      out.push(resolve(cmd[1]));
    }
  }
  return out;
}

export function wrapSandboxCommand(
  cmd: string[],
  policy: SandboxPolicy,
  opts?: { mode?: SandboxMode; platform?: NodeJS.Platform; acpOverride?: boolean },
): SandboxWrap {
  const mode = opts?.mode ?? sandboxModeFromEnv();
  const platform = opts?.platform ?? process.platform;
  const acpOverride = opts?.acpOverride ?? Boolean(process.env.OPENBOT_ACP_COMMAND?.trim());
  if (mode === "none") return { cmd, backend: "none", reason: "OPENBOT_SANDBOX=none" };
  if (mode === "auto" && acpOverride) {
    return { cmd, backend: "none", reason: "OPENBOT_ACP_COMMAND" };
  }

  const policyWithExtras: SandboxPolicy = {
    ...policy,
    extraRead: [...(policy.extraRead ?? []), ...extraReadFromCmd(cmd)],
    operatorHome: policy.operatorHome ?? process.env.HOME ?? homedir(),
  };

  const wantSeatbelt = mode === "seatbelt" || (mode === "auto" && platform === "darwin") || (mode === "required" && platform === "darwin");
  const wantBwrap = mode === "bwrap" || (mode === "auto" && platform === "linux") || (mode === "required" && platform === "linux");

  if (wantSeatbelt) {
    const exe = which("sandbox-exec");
    if (exe) {
      return {
        cmd: [exe, "-p", seatbeltProfile(policyWithExtras), ...cmd],
        backend: "seatbelt",
        reason: "sandbox-exec",
      };
    }
    if (mode === "required" || mode === "seatbelt") {
      throw new SandboxRequiredError("OPENBOT_SANDBOX requires sandbox-exec on PATH");
    }
  }

  if (wantBwrap) {
    const exe = which("bwrap");
    if (exe) {
      return {
        cmd: [exe, ...bwrapArgs(policyWithExtras), "--", ...cmd],
        backend: "bwrap",
        reason: "bwrap",
      };
    }
    if (mode === "required" || mode === "bwrap") {
      throw new SandboxRequiredError("OPENBOT_SANDBOX requires bwrap on PATH");
    }
  }

  if (mode === "required") {
    throw new SandboxRequiredError("OPENBOT_SANDBOX=required but no sandbox backend is available");
  }
  return { cmd, backend: "none", reason: `no sandbox backend on ${platform}` };
}
