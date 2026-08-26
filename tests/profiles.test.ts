import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  conventionalOrgHome,
  listProfiles,
  openbotStateRoot,
  registerProfile,
  resolveOpenbotHome,
  useProfile,
} from "../apps/server/src/profiles.ts";
import { tempHome } from "./helpers.ts";

const cli = join(import.meta.dir, "../apps/server/src/cli.ts");

function isolatedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) env[key] = value;
  }
  env.HOME = home;
  for (const key of [
    "OPENBOT_HOME",
    "OPENBOT_ORG",
    "OPENBOT_ORG_SLUG",
    "OPENBOT_ORG_NAME",
    "OPENBOT_ORG_ID",
    "OPENBOT_PUBLIC_ORIGIN",
    "OPENBOT_FEDERATION",
  ]) {
    delete env[key];
  }
  return env;
}

async function runOpenbot(
  args: string[],
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv(home),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("resolveOpenbotHome", () => {
  test("--home wins over slug and does not require a registry", () => {
    const userHome = tempHome();
    const data = tempHome();
    const got = resolveOpenbotHome({
      userHome,
      homeFlag: data,
      orgFlag: "acme",
    });
    expect(got.home).toBe(data);
    expect(got.source).toBe("home-flag");
    expect(got.remember).toBe(false);
    expect(got.slug).toBe("acme");
  });

  test("named slug uses ~/.openbot/orgs/<slug> when unregistered", () => {
    const userHome = tempHome();
    const state = openbotStateRoot(userHome);
    const got = resolveOpenbotHome({ userHome, orgFlag: "acme" });
    expect(got.home).toBe(conventionalOrgHome(state, "acme"));
    expect(got.slug).toBe("acme");
    expect(got.source).toBe("org");
    expect(got.remember).toBe(true);
  });

  test("current profile is used when no flags are passed", () => {
    const userHome = tempHome();
    const state = openbotStateRoot(userHome);
    const home = conventionalOrgHome(state, "acme");
    registerProfile(state, "acme", home);
    useProfile(state, "acme");
    const got = resolveOpenbotHome({ userHome });
    expect(got.home).toBe(home);
    expect(got.slug).toBe("acme");
    expect(got.source).toBe("current");
  });

  test("org init adopts a legacy ~/.openbot sqlite as the first profile", () => {
    const userHome = tempHome();
    const state = openbotStateRoot(userHome);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "openbot.sqlite"), "");
    const got = resolveOpenbotHome({ userHome, createSlug: "acme" });
    expect(got.home).toBe(state);
    expect(got.slug).toBe("acme");
    expect(got.source).toBe("create");
  });

  test("second org init creates ~/.openbot/orgs/<slug>", () => {
    const userHome = tempHome();
    const state = openbotStateRoot(userHome);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "openbot.sqlite"), "");
    registerProfile(state, "acme", state);
    const got = resolveOpenbotHome({ userHome, createSlug: "beta" });
    expect(got.home).toBe(conventionalOrgHome(state, "beta"));
    expect(got.slug).toBe("beta");
  });

  test("requireExisting unknown slug fails", () => {
    const userHome = tempHome();
    expect(() => resolveOpenbotHome({ userHome, orgFlag: "ghost", requireExisting: true })).toThrow(
      /unknown profile ghost/,
    );
  });
});

describe("openbot profiles CLI", () => {
  test("org init acme registers a profile and later org needs no --home", async () => {
    const userHome = tempHome();
    const init = await runOpenbot(["org", "init", "acme", "--name", "Acme"], userHome);
    expect(init.code).toBe(0);
    expect(init.stderr).toBe("");
    const written = JSON.parse(init.stdout.trim()) as { slug: string; home: string; profile: string };
    expect(written.slug).toBe("acme");
    expect(written.profile).toBe("acme");
    expect(written.home).toBe(conventionalOrgHome(openbotStateRoot(userHome), "acme"));
    expect(existsSync(join(written.home, "openbot.sqlite"))).toBe(true);

    const listed = await runOpenbot(["orgs"], userHome);
    expect(listed.code).toBe(0);
    const roster = JSON.parse(listed.stdout.trim()) as {
      current: string;
      orgs: Array<{ slug: string; home: string; current: boolean }>;
      profiles: Array<{ slug: string; home: string; current: boolean }>;
      note: string;
    };
    expect(roster.current).toBe("acme");
    expect(roster.orgs).toEqual([{ slug: "acme", home: written.home, current: true }]);
    expect(roster.profiles).toEqual(roster.orgs);
    expect(roster.note).toContain("acme");

    const show = await runOpenbot(["org"], userHome);
    expect(show.code).toBe(0);
    const json = JSON.parse(show.stdout.trim()) as { slug: string; home: string; profile: string };
    expect(json.slug).toBe("acme");
    expect(json.home).toBe(written.home);
    expect(json.profile).toBe("acme");
  });

  test("two orgs switch with use", async () => {
    const userHome = tempHome();
    const acme = await runOpenbot(["org", "init", "acme", "--name", "Acme"], userHome);
    expect(acme.code).toBe(0);
    const beta = await runOpenbot(["org", "init", "beta", "--name", "Beta"], userHome);
    expect(beta.code).toBe(0);
    const betaJson = JSON.parse(beta.stdout.trim()) as { slug: string; home: string; orgId: string };
    expect(betaJson.slug).toBe("beta");
    expect(betaJson.home).toContain(`${join("orgs", "beta")}`);

    const useAcme = await runOpenbot(["use", "acme"], userHome);
    expect(useAcme.code).toBe(0);
    expect((JSON.parse(useAcme.stdout.trim()) as { current: string }).current).toBe("acme");
    const showAcme = await runOpenbot(["org"], userHome);
    expect((JSON.parse(showAcme.stdout.trim()) as { slug: string }).slug).toBe("acme");

    const showBeta = await runOpenbot(["org", "beta"], userHome);
    expect(showBeta.code).toBe(0);
    expect((JSON.parse(showBeta.stdout.trim()) as { slug: string; orgId: string }).orgId).toBe(betaJson.orgId);

    const unknown = await runOpenbot(["use", "ghost"], userHome);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("unknown profile ghost");
  });

  test("--home still isolates and does not write the user registry", async () => {
    const userHome = tempHome();
    const data = tempHome();
    const init = await runOpenbot(["org", "init", "--home", data, "--slug", "acme"], userHome);
    expect(init.code).toBe(0);
    expect(init.stderr).toContain("openbot use acme --home");
    expect(existsSync(join(openbotStateRoot(userHome), "profiles.json"))).toBe(false);
    expect(existsSync(join(data, "openbot.sqlite"))).toBe(true);
    expect(listProfiles(openbotStateRoot(userHome)).profiles).toEqual([]);
  });

  test("use --home imports an existing data dir as the current profile", async () => {
    const userHome = tempHome();
    const data = tempHome();
    const init = await runOpenbot(["org", "init", "--home", data, "--slug", "acme", "--name", "Acme"], userHome);
    expect(init.code).toBe(0);
    const imported = await runOpenbot(["use", "acme", "--home", data], userHome);
    expect(imported.code).toBe(0);
    expect(imported.stderr).toBe("");
    const json = JSON.parse(imported.stdout.trim()) as { current: string; home: string; org: string };
    expect(json.current).toBe("acme");
    expect(json.org).toBe("acme");
    expect(json.home).toBe(data);
    const show = await runOpenbot(["org"], userHome);
    expect(show.code).toBe(0);
    const org = JSON.parse(show.stdout.trim()) as { slug: string; name: string; home: string };
    expect(org.slug).toBe("acme");
    expect(org.name).toBe("Acme");
    expect(org.home).toBe(data);
  });

  test("use with no slug lists orgs", async () => {
    const userHome = tempHome();
    const init = await runOpenbot(["org", "init", "acme"], userHome);
    expect(init.code).toBe(0);
    const listed = await runOpenbot(["use"], userHome);
    expect(listed.code).toBe(0);
    const json = JSON.parse(listed.stdout.trim()) as { current: string; orgs: Array<{ slug: string }>; note: string };
    expect(json.current).toBe("acme");
    expect(json.orgs.map((o) => o.slug)).toEqual(["acme"]);
    expect(json.note).toContain("openbot use");
  });

  test("use warns when OPENBOT_HOME would override the current org", async () => {
    const userHome = tempHome();
    const data = tempHome();
    const init = await runOpenbot(["org", "init", "acme"], userHome);
    expect(init.code).toBe(0);
    const proc = Bun.spawn({
      cmd: [process.execPath, cli, "use", "acme"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...isolatedEnv(userHome), OPENBOT_HOME: data },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toContain("OPENBOT_HOME");
    expect(stderr).toContain("set -e OPENBOT_HOME");
    expect((JSON.parse(stdout.trim()) as { current: string }).current).toBe("acme");
  });
});
