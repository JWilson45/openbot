import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Home folder for one bot. Shared desk is not a security boundary — bots can still `../` into siblings. */
export function botProjectDir(desk: string, botId: string): string {
  return join(desk, "projects", botId);
}

export function isInsideDir(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function isInsideDesk(desk: string, path: string): boolean {
  return isInsideDir(desk, path);
}

function resolvedBotProject(desk: string, botId: string): string {
  const dir = resolve(botProjectDir(desk, botId));
  const projects = resolve(desk, "projects");
  if (dir === projects || !isInsideDesk(projects, dir)) {
    throw new Error("bot project path must be inside desk/projects");
  }
  return dir;
}

/** Create `desk/projects/<botId>/`. Not isolation; the parent desk is still shared. */
export function ensureBotProject(desk: string, botId: string, name: string): string {
  const dir = resolvedBotProject(desk, botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".openbot-bot.json"), JSON.stringify({ id: botId, name, updatedAt: Date.now() }));
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      `Workspace for bot ${name}. Shared desk is the parent. Not a security boundary.\n`,
    );
  }
  // Grok 1.0.5 may walk cwd/.grok/skills and bypass the names-only overlay budget.
  const nativeSkills = join(dir, ".grok", "skills");
  if (existsSync(nativeSkills)) {
    rmSync(nativeSkills, { recursive: true, force: true });
  }
  return dir;
}

/** Permanent purge deletes only `projects/<botId>`. Archive does not. Wipe desk still wipes the whole desk. */
export function deleteBotProject(desk: string, botId: string): void {
  rmSync(resolvedBotProject(desk, botId), { recursive: true, force: true });
}

export function gatewayWorkspaceDir(desk: string): string {
  return join(desk, ".openbot", "gateway");
}

/** Diplomat cwd. Not a project folder and not isolation. */
export function ensureGatewayWorkspace(desk: string): string {
  const dir = resolve(gatewayWorkspaceDir(desk));
  const expected = resolve(desk, ".openbot", "gateway");
  if (dir !== expected || !isInsideDesk(desk, dir)) {
    throw new Error("gateway workspace path must be desk/.openbot/gateway");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
