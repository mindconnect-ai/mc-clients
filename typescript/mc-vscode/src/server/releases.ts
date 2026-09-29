import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Where the server comes from: the Spring Boot executable jar of the Admin UI
 * app on Maven Central — the same artifact the JavaFX launcher
 * (mc-clients/javafx/mc-server-control) installs. It serves the REST API the
 * chat uses and the Admin UI for LLM configs and agents.
 */
const APP = "mc-agent-admin-ui-app";
const CENTRAL = `https://repo1.maven.org/maven2/ai/mindconnect/${APP}`;

export const MIN_JAVA = 21;

/** Newest release listed in the Central metadata. */
export async function latestVersion(): Promise<string> {
  const res = await fetch(`${CENTRAL}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`Maven Central metadata: HTTP ${res.status}`);
  const xml = await res.text();
  const version = /<release>([^<]+)<\/release>/.exec(xml)?.[1] ?? /<latest>([^<]+)<\/latest>/.exec(xml)?.[1];
  if (!version) throw new Error("No release found in the Maven Central metadata.");
  return version;
}

/** Every release on Maven Central, newest first. */
export async function listVersions(): Promise<string[]> {
  const res = await fetch(`${CENTRAL}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`Maven Central metadata: HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).sort(newestFirst);
}

/** The releases already downloaded, newest first. */
export async function installedVersions(serverDir: string): Promise<string[]> {
  const dirs = await fs.readdir(path.join(serverDir, "releases")).catch(() => [] as string[]);
  return dirs.sort(newestFirst);
}

function newestFirst(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

export function jarUrl(version: string): string {
  return `${CENTRAL}/${version}/${APP}-${version}-exec.jar`;
}

export function jarPath(serverDir: string, version: string): string {
  return path.join(serverDir, "releases", version, `${APP}-${version}-exec.jar`);
}

/** Content length of the release jar in bytes, or undefined when the server does not say. */
export async function downloadSize(version: string): Promise<number | undefined> {
  const res = await fetch(jarUrl(version), { method: "HEAD" });
  if (!res.ok) throw new Error(`Release ${version} not found on Maven Central (HTTP ${res.status}).`);
  const length = Number(res.headers.get("content-length"));
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

/**
 * Downloads the jar to a temporary name and renames it when complete, so an
 * interrupted download never looks installed. The SHA-512 Maven Central
 * publishes beside it is checked before the rename — a jar that does not
 * match is never run — and kept next to the jar as the proof it was checked.
 */
export async function download(
  version: string,
  target: string,
  onProgress: (received: number, total?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const expected = await publishedSha512(version);
  const res = await fetch(jarUrl(version), { signal });
  if (!res.ok || !res.body) throw new Error(`Download of ${version}: HTTP ${res.status}`);
  const hash = createHash("sha512");
  const total = Number(res.headers.get("content-length")) || undefined;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  let received = 0;
  const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    onProgress(received, total);
  });
  try {
    await pipeline(body, createWriteStream(partial));
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new Error(`The downloaded ${version} does not match the SHA-512 Maven Central publishes — not installed.`);
    }
    await fs.writeFile(checksumFile(target), `${actual}\n`);
    await fs.rename(partial, target);
  } catch (e) {
    await fs.rm(partial, { force: true });
    throw e;
  }
}

/**
 * The java binary to run the server with: the configured home, then
 * JAVA_HOME, then the PATH — whichever first reports version 21 or newer.
 */
export async function resolveJava(configuredHome: string): Promise<string> {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [
    configuredHome && path.join(configuredHome, "bin", exe),
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", exe),
    exe,
  ].filter((c): c is string => !!c);
  const found: string[] = [];
  for (const candidate of candidates) {
    const major = await javaMajor(candidate);
    if (major === undefined) continue;
    if (major >= MIN_JAVA) return candidate;
    found.push(`${candidate} (Java ${major})`);
  }
  throw new Error(
    `The MindConnect server needs Java ${MIN_JAVA} or newer`
      + (found.length ? `; found only ${found.join(", ")}` : "; none found")
      + ". Install one (e.g. Temurin 21) or set mindconnect.server.javaHome.",
  );
}

function javaMajor(binary: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    // java -version writes to stderr: `openjdk version "21.0.4" …` / `java version "1.8.0_…"`
    execFile(binary, ["-version"], { timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) return resolve(undefined);
      const match = /version "(\d+)(?:\.(\d+))?/.exec(stderr);
      if (!match) return resolve(undefined);
      const first = Number(match[1]);
      resolve(first === 1 ? Number(match[2]) : first);
    });
  });
}

/**
 * Checks a jar that was downloaded before checksums were verified (it has no
 * checksum file yet) against Maven Central. Returns false on a mismatch;
 * throws when Central cannot be reached, so the caller decides.
 */
export async function verifyInstalled(version: string, jar: string): Promise<boolean> {
  if (await fs.access(checksumFile(jar)).then(() => true, () => false)) return true;
  const expected = await publishedSha512(version);
  const hash = createHash("sha512");
  await pipeline(createReadStream(jar), hash);
  const actual = hash.digest("hex");
  if (actual !== expected) return false;
  await fs.writeFile(checksumFile(jar), `${actual}\n`);
  return true;
}

function checksumFile(jar: string): string {
  return `${jar}.sha512`;
}

/** The hex digest from Central's .sha512 file (which may carry a file name after it). */
async function publishedSha512(version: string): Promise<string> {
  const res = await fetch(`${jarUrl(version)}.sha512`);
  if (!res.ok) throw new Error(`No SHA-512 for ${version} on Maven Central (HTTP ${res.status}) — not installed.`);
  const digest = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(digest)) throw new Error(`Maven Central's SHA-512 for ${version} is unreadable.`);
  return digest;
}
