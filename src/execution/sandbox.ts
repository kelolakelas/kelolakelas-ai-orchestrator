import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import type { SandboxConfig } from '../config/schema.js';
import type { runBoundedProcess } from './bounded-process.js';

export interface SandboxRequest {
  executable: string;
  args: readonly string[];
  /** Working directory; must be one of `writablePaths` or `readOnlyPaths`. */
  cwd: string;
  /** Host paths mounted writable at the same location, such as the worktree. */
  writablePaths: readonly string[];
  /** Host paths mounted read-only at the same location in addition to the configured ones, such as a clone's Git directory. */
  readOnlyPaths: readonly string[];
  network: boolean;
}

export interface SandboxedCommand {
  executable: string;
  args: string[];
  /** Variables overriding the caller's environment inside the sandbox. */
  environment: NodeJS.ProcessEnv;
}

/** Wraps a trusted command so it runs confined. Implementations never interpret the command through a shell. */
export interface CommandSandbox {
  readonly kind: SandboxConfig['kind'];
  wrap(request: SandboxRequest): SandboxedCommand;
}

/** Runs commands directly as the service user. Offers no credential isolation. */
export class NoSandbox implements CommandSandbox {
  readonly kind = 'none' as const;

  wrap(request: SandboxRequest): SandboxedCommand {
    return { executable: request.executable, args: [...request.args], environment: {} };
  }
}

/** Top-level directories that distributions often make symbolic links into `/usr`. */
const mirroredRootEntries = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
export const sandboxHome = '/sandbox/home';

/**
 * Confines a command with unprivileged bubblewrap. The command sees a fresh root containing only configured read-only
 * paths, the requested paths, a private `/tmp`, a minimal `/dev`, and a `/proc` of its own PID namespace, so the
 * orchestrator's processes, environment, and memory are unreachable. Without network access it also gets an empty
 * network namespace. `--die-with-parent` and a signal to bwrap end every process in the namespace.
 */
export class BubblewrapSandbox implements CommandSandbox {
  readonly kind = 'bubblewrap' as const;

  constructor(private readonly config: SandboxConfig, private readonly exists: (path: string) => boolean = existsSync) {}

  wrap(request: SandboxRequest): SandboxedCommand {
    const args = [
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
      ...(request.network ? [] : ['--unshare-net']),
      '--die-with-parent', '--new-session',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', sandboxHome,
    ];
    for (const entry of mirroredRootEntries) {
      const link = this.symbolicLink(entry);
      if (link !== undefined) args.push('--symlink', link, entry);
      else if (this.exists(entry)) args.push('--ro-bind', entry, entry);
    }
    for (const path of [...this.config.readOnlyPaths, ...request.readOnlyPaths]) args.push('--ro-bind-try', path, path);
    for (const path of [...this.config.writablePaths, ...request.writablePaths]) args.push('--bind', path, path);
    // Masks come last so they cover a path inside any mounted parent. Only existing paths can be covered.
    for (const path of this.config.maskedPaths.filter((entry) => this.exists(entry))) args.push('--tmpfs', path);
    args.push('--chdir', request.cwd, '--setenv', 'HOME', sandboxHome, '--setenv', 'TMPDIR', '/tmp', '--', request.executable, ...request.args);
    return { executable: this.config.executable, args, environment: { HOME: sandboxHome, TMPDIR: '/tmp' } };
  }

  private symbolicLink(path: string): string | undefined {
    try {
      return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
    } catch {
      return undefined;
    }
  }
}

export function createSandbox(config: SandboxConfig): CommandSandbox {
  return config.kind === 'bubblewrap' ? new BubblewrapSandbox(config) : new NoSandbox();
}

/**
 * Fails fast when the sandbox cannot start, for example because unprivileged user namespaces are disabled, and proves
 * that the orchestrator's process is not visible inside it.
 */
export async function verifySandbox(sandbox: CommandSandbox, run: typeof runBoundedProcess): Promise<void> {
  if (sandbox.kind === 'none') return;
  const wrapped = sandbox.wrap({
    executable: '/bin/sh',
    args: ['-c', `test ! -e /proc/${process.pid}/environ || ! grep -qa ORCHESTRATOR_SANDBOX_PROBE= /proc/${process.pid}/environ`],
    cwd: '/',
    writablePaths: [],
    readOnlyPaths: [],
    network: false,
  });
  const result = await run({
    executable: wrapped.executable,
    args: wrapped.args,
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', ...wrapped.environment },
    timeoutMs: 15_000,
    tailBytes: 2_000,
    maxOutputBytes: 64_000,
  });
  if (result.outcome !== 'exited' || result.exitCode !== 0) {
    const detail = result.spawnError ?? (result.stderrTail.trim() || `exit ${result.exitCode ?? result.signal ?? result.outcome}`);
    throw new Error(`Command sandbox ${sandbox.kind} failed its startup check: ${detail.slice(0, 500)}`);
  }
}
