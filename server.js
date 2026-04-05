import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const COMPILER_BINARY = path.join(__dirname, "a.out");
const MAX_BODY_SIZE = 1024 * 1024;

const sendJson = (res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
};

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const runCompiler = (sourceCode, workingDir) =>
  new Promise((resolve, reject) => {
    const child = spawn(COMPILER_BINARY, ["--export-ast"], {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);

    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin.end(sourceCode);
  });

const compileSource = async (sourceCode) => {
  const workDir = await mkdtemp(path.join(tmpdir(), "compiler-api-"));

  try {
    const runResult = await runCompiler(sourceCode, workDir);
    const stepsPath = path.join(workDir, "Logs", "compiler_logs.json");
    const astPath = path.join(workDir, "AST_Vis", "ast.json");

    let stepsData;
    let astData;

    try {
      stepsData = JSON.parse(await readFile(stepsPath, "utf8"));
      astData = JSON.parse(await readFile(astPath, "utf8"));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not read compiler output JSON files.";

      return {
        ok: false,
        statusCode: 400,
        payload: {
          error: "Compiler did not produce valid AST/log output.",
          details: message,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
        },
      };
    }

    return {
      ok: true,
      statusCode: 200,
      payload: {
        stepsData,
        astData,
        stdout: runResult.stdout,
        stderr: runResult.stderr,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method !== "POST" || req.url !== "/api/compile") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const parsedBody = body ? JSON.parse(body) : {};

    if (typeof parsedBody.sourceCode !== "string") {
      sendJson(res, 400, {
        error: "Request body must be JSON with a string `sourceCode` field.",
      });
      return;
    }

    const result = await compileSource(parsedBody.sourceCode);
    sendJson(res, result.statusCode, result.payload);
  } catch (error) {
    sendJson(res, 500, {
      error: "Compilation request failed.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, () => {
  console.log(`Compiler backend listening on http://localhost:${PORT}`);
});
