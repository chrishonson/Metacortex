import fs from "node:fs";
import path from "node:path";

export function readArg(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === `--${name}`);

  return index === -1 ? undefined : args[index + 1];
}

export function loadEnvironment(directory: string): void {
  const explicitKeys = new Set(Object.keys(process.env));

  for (const fileName of [".env", ".env.prod"]) {
    const filePath = path.join(directory, fileName);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();

      if (explicitKeys.has(key)) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

export function readFirebaseProject(rootDir: string): string | undefined {
  const firebaseRcPath = path.join(rootDir, ".firebaserc");

  if (!fs.existsSync(firebaseRcPath)) {
    return undefined;
  }

  const firebaseRc = JSON.parse(fs.readFileSync(firebaseRcPath, "utf8"));
  const project = firebaseRc.projects?.prod ?? firebaseRc.projects?.default;

  return typeof project === "string" && project.trim()
    ? project.trim()
    : undefined;
}
