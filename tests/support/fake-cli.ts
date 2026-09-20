import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeCliScenario =
  /** Writes `result` to the declared result file and exits 0. */
  | { mode: 'file-result'; result: unknown; usage?: unknown }
  /** Prints `result` as one JSON document on stdout and exits 0. */
  | { mode: 'stdout-result'; result: unknown; usage?: unknown }
  /** Prints arbitrary text on stdout, for a client whose output is not JSON. */
  | { mode: 'text'; text: string }
  /** Prints the envelope as one JSON document while failing inside it; the exit code still says success. */
  | { mode: 'silent-failure'; result: unknown }
  | { mode: 'no-result' }
  | { mode: 'fail'; exitCode: number; stderr?: string }
  | { mode: 'hang'; childPidFile?: string }
  | { mode: 'flood' };

export interface FakeCliInvocation {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  prompt: string;
  /** Contents of the schema file named by `{schemaFile}`, when the template used that placeholder. */
  schemaFile: unknown;
  /** True when the run was wrapped in a sandbox, proven by the sandbox's own environment overrides. */
  sandboxed: boolean;
}

export interface FakeCli {
  executable: string;
  scratch: string;
  set(scenario: FakeCliScenario): void;
  queue(scenarios: readonly FakeCliScenario[]): void;
  remaining(): number;
  invocation(): FakeCliInvocation;
  invocations(): FakeCliInvocation[];
  cleanup(): void;
}

/**
 * A stand-in for any command-line model client driven by a `cli` transport. It reads its command line rather than
 * assuming one: the result file comes from `{resultFile}` and the prompt from stdin or from an argument, so the same
 * fake serves every template a test writes. This is what makes the declarative adapter testable without a provider.
 */
export function createFakeCli(): FakeCli {
  const base = mkdtempSync(join(tmpdir(), 'fake-cli-'));
  const scenarioPath = join(base, 'scenario.json');
  const queuePath = join(base, 'queue.json');
  const invocationPath = join(base, 'invocation.json');
  const invocationsPath = join(base, 'invocations.jsonl');
  const executable = join(base, 'model-client');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const queuePath = ${JSON.stringify(queuePath)};
const queued = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
const scenario = queued.length > 0 ? queued.shift() : JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
if (fs.existsSync(queuePath)) fs.writeFileSync(queuePath, JSON.stringify(queued));
// The template says where the result goes; the fake never guesses a flag of its own.
const resultPath = args.includes('{resultFile}') ? '{resultFile}' : args[args.indexOf('--result') + 1];
const schemaPath = args.includes('{schemaFile}') ? '{schemaFile}' : args[args.indexOf('--schema-file') + 1];
const prompt = fs.readFileSync(0, 'utf8');
const invocation = {
  args,
  env: process.env,
  cwd: process.cwd(),
  prompt,
  // Read before the run deletes it, so a test can prove the schema reached the client.
  schemaFile: schemaPath === undefined ? null : JSON.parse(fs.readFileSync(schemaPath, 'utf8')),
  // A wrapped run carries the sandbox's HOME override, which no other path sets.
  sandboxed: process.env.HOME === '/sandbox/home',
};
fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify(invocation));
fs.appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify(invocation) + '\\n');
// A client that reports usage emits an envelope, with the result beside its accounting rather than inside it.
const document = (result, usage) => (usage === undefined ? result : { result, usage });
switch (scenario.mode) {
  case 'file-result':
    fs.writeFileSync(resultPath, JSON.stringify(document(scenario.result, scenario.usage)));
    break;
  case 'stdout-result':
    process.stdout.write(JSON.stringify(document(scenario.result, scenario.usage)));
    break;
  case 'text':
    process.stdout.write(scenario.text);
    break;
  case 'silent-failure':
    // Exits 0 while reporting failure inside the document, which is the trap this transport must survive.
    process.stdout.write(JSON.stringify(scenario.result));
    break;
  case 'no-result':
    break;
  case 'fail':
    if (scenario.stderr) process.stderr.write(scenario.stderr);
    process.exit(scenario.exitCode);
    break;
  case 'hang': {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    if (scenario.childPidFile) fs.writeFileSync(scenario.childPidFile, String(child.pid));
    setInterval(() => undefined, 1000);
    break;
  }
  case 'flood':
    setInterval(() => process.stdout.write('x'.repeat(4096) + '\\n'), 1);
    break;
}
`);
  chmodSync(executable, 0o755);
  const readInvocations = (): FakeCliInvocation[] =>
    existsSync(invocationsPath)
      ? readFileSync(invocationsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeCliInvocation)
      : [];
  return {
    executable,
    scratch: join(base, 'scratch'),
    set: (scenario) => writeFileSync(scenarioPath, JSON.stringify(scenario)),
    queue: (scenarios) => writeFileSync(queuePath, JSON.stringify(scenarios)),
    remaining: () => (existsSync(queuePath) ? (JSON.parse(readFileSync(queuePath, 'utf8')) as unknown[]).length : 0),
    invocation: () => JSON.parse(readFileSync(invocationPath, 'utf8')) as FakeCliInvocation,
    invocations: readInvocations,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
