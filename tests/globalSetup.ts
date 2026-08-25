import { spawn, spawnSync, type ChildProcess } from "child_process";
import http from "http";

export const TEST_PORT = 3100;
export const BASE_URL = `http://localhost:${TEST_PORT}`;

// A separate build output dir means the test server can build/start without
// colliding with a developer's already-running `next dev` (which owns .next).
const TEST_DIST_DIR = ".next-test";

let serverProcess: ChildProcess | undefined;

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

export async function setup() {
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const env = { ...process.env, NEXT_DIST_DIR: TEST_DIST_DIR };

  const build = spawnSync(npxCmd, ["next", "build"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    throw new Error(`next build (test) failed with exit code ${build.status}`);
  }

  serverProcess = spawn(npxCmd, ["next", "start", "-p", String(TEST_PORT)], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[next-test-server] ${d}`));

  await waitForServer(`${BASE_URL}/login`, 30000);
}

export async function teardown() {
  if (!serverProcess || serverProcess.killed || serverProcess.pid === undefined) return;
  if (process.platform === "win32") {
    // `next start` can spawn child workers; a plain kill() on Windows leaves
    // them orphaned holding the port. Kill the whole process tree instead.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(serverProcess!.pid), "/t", "/f"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  } else {
    serverProcess.kill();
  }
}
