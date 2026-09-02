import fs from "node:fs/promises";
import path from "node:path";

function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(resolve(dirPath), { recursive: true });
}

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(resolve(filePath), "utf-8");
}

export async function writeTextFile(
  filePath: string,
  content: string,
  opts?: { encoding?: BufferEncoding },
): Promise<void> {
  const resolved = resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, opts?.encoding ?? "utf-8");
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  await writeTextFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

export async function copyFileSafe(
  src: string,
  dest: string,
): Promise<void> {
  const resolvedDest = resolve(dest);
  await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
  await fs.copyFile(resolve(src), resolvedDest);
}

export async function writeIfAbsent(
  filePath: string,
  content: string,
): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }
  await writeTextFile(filePath, content);
  return true;
}

export async function writeWithConfirm(
  filePath: string,
  content: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  if (await pathExists(filePath)) {
    if (!opts?.force) {
      console.log(`Skipping ${filePath} (already exists, use --force to overwrite)`);
      return false;
    }
  }
  await writeTextFile(filePath, content);
  return true;
}
