import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeCodexScenario =
  | { mode: 'result'; result: unknown; usage?: Record<string, number> }
  | { mode: 'raw-result'; text: string }
  | { mode: 'no-result' }
  | { mode: 'fail'; exitCode: number; stderr?: string; event?: Record<string, unknown> }
  | { mode: 'hang'; childPidFile?: string }
  | { mode: 'flood' };

export interface FakeCodexInvocation {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  prompt: string;
  schema: unknown;
}

export interface FakeCodex {
  executable: string;
  scratch: string;
  set(scenario: FakeCodexScenario): void;
  invocation(): FakeCodexInvocation;
  cleanup(): void;
}

/**
 * A stand-in for the Codex CLI. It records how it was invoked and behaves according to a scenario file, so runner
 * tests exercise real process spawning, stdin, JSONL parsing, timeouts, and group kills without a model.
 */
export function createFakeCodex(): FakeCodex {
  const base = mkdtempSync(join(tmpdir(), 'fake-codex-'));
  const scenarioPath = join(base, 'scenario.json');
  const invocationPath = join(base, 'invocation.json');
  const executable = join(base, 'codex');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
const prompt = fs.readFileSync(0, 'utf8');
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args, env: process.env, cwd: process.cwd(), prompt, schema }));
const resultPath = args[args.indexOf('--output-last-message') + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'thread.started', thread_id: 'fake' });
switch (scenario.mode) {
  case 'result':
    fs.writeFileSync(resultPath, JSON.stringify(scenario.result));
    emit({ type: 'turn.completed', usage: scenario.usage ?? { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
    break;
  case 'raw-result':
    fs.writeFileSync(resultPath, scenario.text);
    break;
  case 'no-result':
    break;
  case 'fail':
    if (scenario.event) emit(scenario.event);
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
    setInterval(() => emit({ type: 'item.completed', text: 'x'.repeat(4096) }), 1);
    break;
}
`);
  chmodSync(executable, 0o755);
  return {
    executable,
    scratch: join(base, 'scratch'),
    set: (scenario) => writeFileSync(scenarioPath, JSON.stringify(scenario)),
    invocation: () => JSON.parse(readFileSync(invocationPath, 'utf8')) as FakeCodexInvocation,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
