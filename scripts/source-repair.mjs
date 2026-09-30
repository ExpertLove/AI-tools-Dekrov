import { readFile, writeFile, lstat, rename, unlink, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRepair, planRepair, replaceJsonStrings } from "./source-repair-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["data/tools.json", "data/setup-recipes.json"];
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function argsFrom(argv) {
  const [command, ...rest] = argv;
  if (!["prepare", "apply"].includes(command)) throw new Error("Usage: source-repair.mjs prepare --issue ISSUE.json|--report REPORT.json --finding ID --output TASK.json; apply --task TASK.json --proposal PROPOSAL.json [--write] [--output PLAN.json]");
  const args = { command };
  const allowed = command === "prepare" ? ["issue", "report", "finding", "output"] : ["task", "proposal", "write", "output"];
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || !allowed.includes(key) || Object.hasOwn(args, key)) throw new Error(`Unexpected/duplicate argument: ${rest[i]}`);
    if (key === "write") args.write = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing --${key} value.`);
      args[key] = value;
    }
  }
  return args;
}

async function readInputs(root) {
  if ((await lstat(path.join(root, "data"))).isSymbolicLink()) throw new Error("Symlinked data directory is not allowed.");
  const texts = {};
  for (const file of FILES) {
    const stat = await lstat(path.join(root, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular catalog file: ${file}`);
    texts[file] = await readFile(path.join(root, file), "utf8");
  }
  return { texts, tools: JSON.parse(texts[FILES[0]]), setup: JSON.parse(texts[FILES[1]]) };
}

function assertCheckout(root, task) {
  if (git(root, ["branch", "--show-current"]) !== task.branch) throw new Error(`Write requires the dedicated branch ${task.branch}; never main/default/detached HEAD.`);
  if (git(root, ["status", "--porcelain"])) throw new Error("Write requires a clean checkout; put runtime JSON outside the repository.");
}

async function atomicWrite(file, text) {
  const temporary = `${file}.source-repair-${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function applyRepairFiles({ root = ROOT, task, proposal, write = false, now, check }) {
  let lock;
  let lockPath;
  try {
    if (write) {
      assertCheckout(root, task);
      lockPath = path.resolve(root, git(root, ["rev-parse", "--git-path", "source-repair.lock"]));
      lock = await open(lockPath, "wx");
    }
    const input = await readInputs(root);
    const plan = await planRepair({ ...input, task, proposal, now, check });
    const output = {};
    for (const file of FILES) {
      const changes = plan.changes.filter(change => change.file === file);
      if (changes.length) output[file] = replaceJsonStrings(input.texts[file], changes);
    }
    if (write) {
      assertCheckout(root, task);
      const current = await readInputs(root);
      if (FILES.some(file => current.texts[file] !== input.texts[file])) throw new Error("Catalog changed during validation; aborting without writes.");
      const written = [];
      try {
        for (const [file, text] of Object.entries(output)) {
          await atomicWrite(path.join(root, file), text);
          written.push(file);
        }
      } catch (error) {
        for (const file of written) await atomicWrite(path.join(root, file), input.texts[file]);
        throw error;
      }
    }
    return { ...plan, written: write, testsRequired: "npm test", files: Object.keys(output) };
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

async function jsonFile(file) {
  if (!file) throw new Error("Required JSON file argument is missing.");
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 10_000_000) throw new Error("Input JSON is too large.");
  return JSON.parse(text);
}

export async function runRepairCli(argv = process.argv.slice(2)) {
  const args = argsFrom(argv);
  if (args.output) {
    const relative = path.relative(ROOT, path.resolve(args.output));
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("Save runtime output outside the repository.");
  }
  let result;
  if (args.command === "prepare") {
    if (!args.output || !args.finding || Boolean(args.issue) === Boolean(args.report)) throw new Error("Prepare requires --finding, --output and exactly one --issue/--report.");
    const input = await readInputs(ROOT);
    result = prepareRepair({ ...input, findingId: args.finding, issue: args.issue ? await jsonFile(args.issue) : undefined, report: args.report ? await jsonFile(args.report) : undefined });
  } else {
    result = await applyRepairFiles({ task: await jsonFile(args.task), proposal: await jsonFile(args.proposal), write: args.write === true });
  }
  const output = JSON.stringify(result, null, 2) + "\n";
  if (args.output) await writeFile(args.output, output, { flag: "wx" });
  else console.log(output);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRepairCli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
