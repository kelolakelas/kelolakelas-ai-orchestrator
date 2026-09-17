import { execFile } from 'node:child_process';

/** Environment variables passed to Git. Everything else, including provider credentials, is withheld. */
const inheritedEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'TMPDIR'] as const;
const maxOutputBytes = 8 * 1024 * 1024;
const maxErrorDetail = 2_000;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunOptions {
  cwd: string;
  /** Only pass for operations that are safe to kill midway, such as fetch or ls-remote. */
  signal?: AbortSignal;
  /** Return non-zero exits instead of throwing. */
  allowFailure?: boolean;
}

export class GitCommandError extends Error {
  constructor(public readonly args: readonly string[], public readonly exitCode: number | null, stderr: string) {
    super(`git ${args[0] ?? ''} failed (${exitCode ?? 'signal'}): ${stderr.trim().slice(0, maxErrorDetail)}`);
    this.name = 'GitCommandError';
  }
}

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env, githubToken?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of inheritedEnvironment) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  if (githubToken === undefined) return environment;
  delete environment.SSH_AUTH_SOCK;
  return { ...environment, ...githubTokenGitEnvironment(githubToken) };
}

/**
 * Authenticates HTTPS requests to github.com with a token supplied through Git's environment-only configuration, never
 * through arguments, files, or the remote URL. Credential helpers from system and user configuration are cleared so
 * no credential file is consulted, and SSH is refused so an SSH key cannot be used instead.
 */
export function githubTokenGitEnvironment(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const entries: Array<[string, string]> = [
    ['credential.helper', ''],
    ['http.https://github.com/.extraHeader', `Authorization: Basic ${basic}`],
    ['protocol.ssh.allow', 'never'],
  ];
  const environment: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length), GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false' };
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

/**
 * Runs the fixed `git` executable with an argument array (never a shell). Repository hooks are disabled so a checkout
 * cannot execute repository-controlled code.
 */
export class GitRunner {
  constructor(private readonly timeoutMs: number, private readonly environment: NodeJS.ProcessEnv = gitEnvironment()) {}

  async run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    const fullArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
    return new Promise((resolve, reject) => {
      execFile('git', fullArgs, {
        cwd: options.cwd,
        env: this.environment,
        timeout: this.timeoutMs,
        maxBuffer: maxOutputBytes,
        encoding: 'utf8',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const exitCode = typeof error.code === 'number' ? error.code : null;
        if (options.allowFailure && exitCode !== null) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(new GitCommandError(args, exitCode, stderr || error.message));
      });
    });
  }

  async output(args: readonly string[], options: GitRunOptions): Promise<string> {
    return (await this.run(args, options)).stdout.trim();
  }
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  lockReason: string | null;
}

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { path: value, head: null, branch: null, locked: false, lockReason: null };
    } else if (current && key === 'HEAD') {
      current.head = value;
    } else if (current && key === 'branch') {
      current.branch = value;
    } else if (current && key === 'locked') {
      current.locked = true;
      current.lockReason = value === '' ? null : value;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Normalizes GitHub HTTPS and SSH remote URLs to lowercase `owner/name`. */
export function githubRepositoryFromUrl(url: string): string | undefined {
  const match = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return match?.[1]?.toLowerCase();
}
