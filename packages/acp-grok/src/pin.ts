export const PINNED_GROK_CLI = "1.0.5";

type Semver = { major: number; minor: number; patch: number };

function parseSemver(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function parseGrokCliVersion(output: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(output);
  return m?.[1] ?? null;
}

export function detectGrokCliVersion(): string | null {
  try {
    if (!Bun.which("grok")) return null;
    const proc = Bun.spawnSync(["grok", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4000,
    });
    const text = `${proc.stdout?.toString() ?? ""}\n${proc.stderr?.toString() ?? ""}`;
    return parseGrokCliVersion(text);
  } catch {
    return null;
  }
}

export type GrokCliPinStatus = {
  pinned: string;
  detected: string | null;
  ok: boolean;
  warning?: string;
};

export function grokCliPinStatus(detected?: string | null): GrokCliPinStatus {
  const pinned = PINNED_GROK_CLI;
  const v = detected === undefined ? detectGrokCliVersion() : detected;
  if (!v) {
    return {
      pinned,
      detected: null,
      ok: true,
      warning: `grok CLI not found on PATH; OpenBot pins ${pinned}. Install grok and run grok login as the service user.`,
    };
  }
  const got = parseSemver(v);
  const pin = parseSemver(pinned);
  if (!got || !pin) {
    return {
      pinned,
      detected: v,
      ok: true,
      warning: `could not parse grok CLI version ${v} (pin ${pinned})`,
    };
  }
  const sameMajorMinor = got.major === pin.major && got.minor === pin.minor;
  const sameMajorGte = got.major === pin.major && cmpSemver(got, pin) >= 0;
  const ok = sameMajorMinor || sameMajorGte;
  const older = cmpSemver(got, pin) < 0;
  let warning: string | undefined;
  if (older) {
    warning = `grok CLI ${v} is older than pin ${pinned}`;
  } else if (!ok) {
    warning = `grok CLI ${v} does not match pin ${pinned} (same major required)`;
  }
  return { pinned, detected: v, ok, ...(warning ? { warning } : {}) };
}
