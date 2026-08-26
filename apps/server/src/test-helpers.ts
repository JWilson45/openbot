import { completeGithubLogin, cookieHeader, writeAllowlistFile } from "@openbot/auth";
import { createApp, type HomeConfig } from "./app.ts";

export function startTestServer(cfg: Partial<HomeConfig> & { home: string; port?: number }) {
  const port = cfg.port ?? 0;
  const created = createApp({
    home: cfg.home,
    port,
    githubClientId: cfg.githubClientId,
    githubClientSecret: cfg.githubClientSecret,
    publicOrigin: cfg.publicOrigin,
    logger: cfg.logger,
  });
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: created.app.fetch,
    websocket: (created as { websocket: unknown }).websocket as never,
  });
  created.ctx.port = server.port;
  const origin = `http://127.0.0.1:${server.port}`;
  return { ...created, server, origin };
}

export function loginCookie(
  created: { ctx: import("./app.ts").AppContext },
  login: string,
): { cookie: string; session: ReturnType<typeof completeGithubLogin> } {
  writeAllowlistFile(created.ctx.home, [login]);
  created.ctx.allowlist.add(login.toLowerCase());
  const session = completeGithubLogin(created.ctx.db, created.ctx.allowlist, { login });
  return { cookie: `${cookieHeader(session.token).split(";")[0]}`, session };
}
