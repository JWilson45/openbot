import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

const repoRoot = resolve(import.meta.dir, "..");

type Rule = {
  packageName: string;
  internal: ReadonlySet<string>;
  external: ReadonlySet<string>;
};

const rules: Readonly<Record<string, Rule>> = {
  "packages/core": {
    packageName: "@openbot/core",
    internal: new Set(),
    external: new Set(["zod"]),
  },
  "packages/application": {
    packageName: "@openbot/application",
    internal: new Set(["@openbot/core"]),
    external: new Set(),
  },
  "packages/db": {
    packageName: "@openbot/db",
    internal: new Set(["@openbot/application", "@openbot/calendar", "@openbot/core"]),
    external: new Set(),
  },
  "packages/attachments": {
    packageName: "@openbot/attachments",
    internal: new Set(["@openbot/application", "@openbot/core", "@openbot/db"]),
    external: new Set(),
  },
  "packages/protocol-mcp": {
    packageName: "@openbot/protocol-mcp",
    internal: new Set(["@openbot/core", "@openbot/application"]),
    external: new Set(["@modelcontextprotocol/server"]),
  },
  "packages/protocol-a2a": {
    packageName: "@openbot/protocol-a2a",
    internal: new Set(["@openbot/core", "@openbot/application"]),
    external: new Set(["@a2a-js/sdk"]),
  },
  "packages/protocol-ag-ui": {
    packageName: "@openbot/protocol-ag-ui",
    internal: new Set(["@openbot/core", "@openbot/application"]),
    external: new Set(["@ag-ui/core", "@ag-ui/encoder"]),
  },
  "packages/runtime-grok": {
    packageName: "@openbot/runtime-grok",
    internal: new Set(["@openbot/application", "@openbot/compute-protocol", "@openbot/core"]),
    external: new Set(),
  },
};

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry)) files.push(path);
  }
  return files;
}

function packageSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0]!;
}

function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const add = (node: ts.Expression | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

function internalPackageForRelative(file: string, specifier: string): string | null {
  const target = normalize(resolve(dirname(file), specifier));
  const packageRoot = join(repoRoot, "packages") + sep;
  if (!target.startsWith(packageRoot)) return null;
  const directory = target.slice(packageRoot.length).split(sep)[0];
  if (!directory) return null;
  const manifest = join(packageRoot, directory, "package.json");
  if (!existsSync(manifest)) return `relative:${relative(repoRoot, target)}`;
  const value = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
  return value.name ?? `relative:${relative(repoRoot, target)}`;
}

const violations: string[] = [];
for (const [directory, rule] of Object.entries(rules)) {
  const absoluteDirectory = join(repoRoot, directory);
  if (!existsSync(absoluteDirectory)) continue;

  const manifestPath = join(absoluteDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: string;
    dependencies?: Record<string, string>;
  };
  if (manifest.name !== rule.packageName) {
    violations.push(`${relative(repoRoot, manifestPath)} must be named ${rule.packageName}`);
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const allowed = dependency.startsWith("@openbot/")
      ? rule.internal.has(dependency)
      : rule.external.has(dependency);
    if (!allowed) {
      violations.push(`${relative(repoRoot, manifestPath)} declares forbidden dependency ${dependency}`);
    }
  }

  for (const file of sourceFiles(join(absoluteDirectory, "src"))) {
    for (const specifier of moduleSpecifiers(file)) {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
      const imported = specifier.startsWith(".")
        ? internalPackageForRelative(file, specifier)
        : packageSpecifier(specifier);
      if (imported === null || imported === rule.packageName) continue;
      const allowed = imported.startsWith("@openbot/") || imported.startsWith("relative:")
        ? rule.internal.has(imported)
        : rule.external.has(imported);
      if (!allowed) {
        violations.push(`${relative(repoRoot, file)} imports forbidden dependency ${specifier}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("dependency boundaries ok");
