import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeOrgSlug } from "./org.ts";

export const PROFILES_FILE = "profiles.json";
export const ORGS_DIR = "orgs";

export type ProfileRecord = { home: string };

export type ProfileRegistry = {
  version: 1;
  current: string | null;
  profiles: Record<string, ProfileRecord>;
};

export type ResolveOpts = {
  userHome: string;
  homeFlag?: string;
  orgFlag?: string;
  envHome?: string;
  envOrg?: string;
  /** `org init <slug>` — create or adopt a home for this slug. */
  createSlug?: string;
  /** Fail if the slug is not registered and has no sqlite yet. */
  requireExisting?: boolean;
};

export type ResolveResult = {
  home: string;
  slug: string | null;
  source: "home-flag" | "env-home" | "org" | "current" | "legacy" | "default" | "create";
  remember: boolean;
  stateRoot: string;
};

export function openbotStateRoot(userHome = process.env.HOME || homedir()): string {
  return join(userHome, ".openbot");
}

export function emptyRegistry(): ProfileRegistry {
  return { version: 1, current: null, profiles: {} };
}

export function loadRegistry(stateRoot: string): ProfileRegistry {
  const path = join(stateRoot, PROFILES_FILE);
  if (!existsSync(path)) return emptyRegistry();
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return emptyRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${PROFILES_FILE} at ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid ${PROFILES_FILE} at ${path}`);
  }
  const o = parsed as Record<string, unknown>;
  const profiles: Record<string, ProfileRecord> = {};
  if (o.profiles && typeof o.profiles === "object" && !Array.isArray(o.profiles)) {
    for (const [key, value] of Object.entries(o.profiles as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const home = (value as { home?: unknown }).home;
      if (typeof home === "string" && home.trim()) profiles[key] = { home: resolve(home) };
    }
  }
  const current = typeof o.current === "string" && o.current.trim() ? o.current.trim() : null;
  return {
    version: 1,
    current: current && profiles[current] ? current : null,
    profiles,
  };
}

export function saveRegistry(stateRoot: string, reg: ProfileRegistry): void {
  mkdirSync(stateRoot, { recursive: true });
  const path = join(stateRoot, PROFILES_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1 as const, current: reg.current, profiles: reg.profiles }, null, 2)}\n`,
  );
  renameSync(tmp, path);
}

export function conventionalOrgHome(stateRoot: string, slug: string): string {
  return join(stateRoot, ORGS_DIR, slug);
}

export function isLegacyStateRoot(stateRoot: string): boolean {
  return existsSync(join(stateRoot, "openbot.sqlite"));
}

export function slugForHome(reg: ProfileRegistry, home: string): string | null {
  const abs = resolve(home);
  for (const [slug, rec] of Object.entries(reg.profiles)) {
    if (resolve(rec.home) === abs) return slug;
  }
  return null;
}

export function registerProfile(stateRoot: string, slug: string, home: string): ProfileRegistry {
  const id = normalizeOrgSlug(slug);
  const homeAbs = resolve(home);
  const reg = loadRegistry(stateRoot);
  for (const [key, rec] of Object.entries(reg.profiles)) {
    if (key === id) continue;
    if (resolve(rec.home) === homeAbs) delete reg.profiles[key];
  }
  reg.profiles[id] = { home: homeAbs };
  if (reg.current && !reg.profiles[reg.current]) reg.current = id;
  saveRegistry(stateRoot, reg);
  return reg;
}

export function setCurrentProfile(stateRoot: string, slug: string): ProfileRegistry {
  const id = normalizeOrgSlug(slug);
  const reg = loadRegistry(stateRoot);
  if (!reg.profiles[id]) throw new Error(`unknown profile ${id}; run: openbot org init ${id}`);
  reg.current = id;
  saveRegistry(stateRoot, reg);
  return reg;
}

export function useProfile(stateRoot: string, slug: string, home?: string): ProfileRegistry {
  const id = normalizeOrgSlug(slug);
  if (home?.trim()) {
    registerProfile(stateRoot, id, home.trim());
    return setCurrentProfile(stateRoot, id);
  }
  const reg = loadRegistry(stateRoot);
  if (!reg.profiles[id]) {
    const conv = conventionalOrgHome(stateRoot, id);
    if (!existsSync(join(conv, "openbot.sqlite"))) {
      throw new Error(`unknown profile ${id}; run: openbot org init ${id}  (or: openbot use ${id} --home DIR)`);
    }
    registerProfile(stateRoot, id, conv);
  }
  return setCurrentProfile(stateRoot, id);
}

export function listProfiles(stateRoot: string): {
  current: string | null;
  profiles: Array<{ slug: string; home: string; current: boolean }>;
} {
  const reg = loadRegistry(stateRoot);
  if (Object.keys(reg.profiles).length === 0 && isLegacyStateRoot(stateRoot)) {
    const slug = "local";
    return {
      current: slug,
      profiles: [{ slug, home: resolve(stateRoot), current: true }],
    };
  }
  const rows = Object.entries(reg.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, rec]) => ({
      slug,
      home: rec.home,
      current: slug === reg.current,
    }));
  return { current: reg.current, profiles: rows };
}

function optionalSlug(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  return normalizeOrgSlug(t);
}

function resolveNamedSlug(
  stateRoot: string,
  reg: ProfileRegistry,
  slug: string,
  kind: "org" | "create",
  requireExisting: boolean | undefined,
): ResolveResult {
  if (reg.profiles[slug]) {
    return {
      home: resolve(reg.profiles[slug]!.home),
      slug,
      source: kind,
      remember: true,
      stateRoot,
    };
  }
  if (kind === "create" && isLegacyStateRoot(stateRoot) && Object.keys(reg.profiles).length === 0) {
    return { home: resolve(stateRoot), slug, source: "create", remember: true, stateRoot };
  }
  const conv = conventionalOrgHome(stateRoot, slug);
  if (requireExisting && !existsSync(join(conv, "openbot.sqlite"))) {
    throw new Error(`unknown profile ${slug}; run: openbot org init ${slug}`);
  }
  return { home: conv, slug, source: kind, remember: true, stateRoot };
}

export function resolveOpenbotHome(opts: ResolveOpts): ResolveResult {
  const stateRoot = openbotStateRoot(opts.userHome);
  const reg = loadRegistry(stateRoot);

  if (opts.homeFlag?.trim()) {
    const home = resolve(opts.homeFlag.trim());
    return {
      home,
      slug:
        slugForHome(reg, home) ??
        optionalSlug(opts.createSlug) ??
        optionalSlug(opts.orgFlag) ??
        optionalSlug(opts.envOrg) ??
        null,
      source: "home-flag",
      remember: false,
      stateRoot,
    };
  }

  if (opts.createSlug?.trim() || opts.orgFlag?.trim()) {
    const slug = optionalSlug(opts.createSlug) ?? optionalSlug(opts.orgFlag)!;
    return resolveNamedSlug(
      stateRoot,
      reg,
      slug,
      opts.createSlug?.trim() ? "create" : "org",
      opts.requireExisting,
    );
  }

  if (opts.envHome?.trim()) {
    const home = resolve(opts.envHome.trim());
    return {
      home,
      slug: slugForHome(reg, home) ?? optionalSlug(opts.envOrg) ?? null,
      source: "env-home",
      remember: false,
      stateRoot,
    };
  }

  if (opts.envOrg?.trim()) {
    return resolveNamedSlug(stateRoot, reg, optionalSlug(opts.envOrg)!, "org", opts.requireExisting);
  }

  if (reg.current && reg.profiles[reg.current]) {
    return {
      home: resolve(reg.profiles[reg.current]!.home),
      slug: reg.current,
      source: "current",
      remember: false,
      stateRoot,
    };
  }

  if (isLegacyStateRoot(stateRoot)) {
    return {
      home: resolve(stateRoot),
      slug: slugForHome(reg, stateRoot),
      source: "legacy",
      remember: false,
      stateRoot,
    };
  }

  return { home: resolve(stateRoot), slug: null, source: "default", remember: false, stateRoot };
}
