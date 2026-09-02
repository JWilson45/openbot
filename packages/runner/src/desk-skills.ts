import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DESK_SKILL_NAME_CAP = 32;
export const DESK_SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;

/** Seeded write-if-absent. bun build --compile would miss a files/ tree. */
export const DESK_SKILLS_README_MD = `Shared desk skills. Each skill is \`desk/skills/<name>/SKILL.md\` (kebab-case). Overlay lists names only; read the file before improvising.

This folder is shared. Ada can read Bob's skill files. It is not a jail.

Do not store vault tokens, \`auth.json\`, cookies, or SSH keys here.

Operator \`~/.grok/skills\` are not loaded.
`;

export const CONFIRM_SERIES_SKILL_MD = `---
name: confirm-series
description: Confirm a proposed calendar series after the human agrees in chat. The calendar tick fires; this file does not.
---

# Confirm series

CreateEvent and ProposeRoutine always insert status=proposed and do not fire.

When the human agrees in this thread, call ConfirmSeries with that seriesId (do not use SendMessage urgency=needs_user for that). They can also Confirm in the Calendar UI.

SendMessage urgency=normal unless the human must approve an irreversible action. Min 2 minutes between fires. seriesId comes from ListCalendar or CreateEvent.

ProposeRoutine / ConfirmSeries MCP behavior is unchanged by this file. This skill documents the dance; it does not fire at 9am.

Do not put vault tokens, auth.json, cookies, or SSH keys in skill files.
`;

export const SHARED_CHROMIUM_SKILL_MD = `---
name: shared-chromium
description: Use YOUR tab of the shared desk Chromium. One Chromium, cookies shared, tab per desk bot.
---

# Shared Chromium

Navigate, BrowserSnapshot, Click, Type, Wait on YOUR tab of the shared desk Chromium. Each desk bot has its own tab; cookies/logins are shared. Takeover is the human's tab and does not block yours.

Snapshot is how you see your page. Click a visible label or CSS selector; Type into the focused field (Click it first). Prefer these tools over raw CDP. Do not curl pages.

Do not put vault tokens, auth.json, cookies, or SSH keys in skill files.
`;

function writeIfAbsent(path: string, body: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function ensureDeskSkills(desk: string): void {
  const root = join(desk, "skills");
  mkdirSync(root, { recursive: true });
  writeIfAbsent(join(root, "README.md"), DESK_SKILLS_README_MD);
  writeIfAbsent(join(root, "confirm-series", "SKILL.md"), CONFIRM_SERIES_SKILL_MD);
  writeIfAbsent(join(root, "shared-chromium", "SKILL.md"), SHARED_CHROMIUM_SKILL_MD);
}

/** ASCII-sorted kebab names that have SKILL.md; cap applied after sort. */
export function listDeskSkillNames(desk: string, cap = DESK_SKILL_NAME_CAP): string[] {
  const root = join(desk, "skills");
  let ents: ReturnType<typeof readdirSync>;
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names: string[] = [];
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    if (!DESK_SKILL_NAME_RE.test(ent.name)) continue;
    if (!existsSync(join(root, ent.name, "SKILL.md"))) continue;
    names.push(ent.name);
  }
  names.sort();
  const limit = Number.isFinite(cap)
    ? Math.min(Math.max(0, Math.floor(cap)), DESK_SKILL_NAME_CAP)
    : DESK_SKILL_NAME_CAP;
  return names.slice(0, limit);
}
