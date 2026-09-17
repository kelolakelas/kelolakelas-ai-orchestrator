import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnvironment } from '../src/workspaces/git.js';

describe('GitHub token Git authentication', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'git-auth-'));
    // A host credential helper that would leak a stored credential if Git consulted it.
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = store\n');
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const git = (args: string[], environment: NodeJS.ProcessEnv) => spawnSync('git', args, { cwd: home, env: environment, encoding: 'utf8' });

  it('sends the token only as a github.com header and clears host credential helpers', () => {
    const environment = gitEnvironment({ PATH: process.env.PATH, HOME: home, SSH_AUTH_SOCK: '/run/agent.sock' }, 'ghs_example-token');

    expect(environment.SSH_AUTH_SOCK).toBeUndefined();
    expect(Object.values(environment).join('\n')).not.toContain('ghs_example-token');
    const header = execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/kelolakelas/kelolakelas-web.git'], { env: environment, encoding: 'utf8' }).trim();
    expect(header).toBe(`Authorization: Basic ${Buffer.from('x-access-token:ghs_example-token').toString('base64')}`);
    expect(git(['config', '--get-urlmatch', 'http.extraHeader', 'https://example.com/repo.git'], environment).stdout).toBe('');
  });

  it('never reads stored host credentials', () => {
    writeFileSync(join(home, '.git-credentials'), 'https://user:stored-host-password@github.com\n');
    const fill = (environment: NodeJS.ProcessEnv) => spawnSync('git', ['credential', 'fill'], { cwd: home, env: environment, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });

    expect(fill(gitEnvironment({ PATH: process.env.PATH, HOME: home })).stdout).toContain('stored-host-password');
    const withToken = fill(gitEnvironment({ PATH: process.env.PATH, HOME: home }, 'ghs_example-token'));
    expect(withToken.status).not.toBe(0);
    expect(withToken.stdout).not.toContain('stored-host-password');
  });

  it('refuses SSH remotes so a readable SSH key cannot replace the token', () => {
    const result = git(['ls-remote', 'git@github.com:kelolakelas/kelolakelas-web.git'], gitEnvironment({ PATH: process.env.PATH, HOME: home }, 'ghs_example-token'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/transport 'ssh' not allowed/);
  });

  it('keeps host authentication unchanged without a token', () => {
    const environment = gitEnvironment({ PATH: process.env.PATH, HOME: home, SSH_AUTH_SOCK: '/run/agent.sock' });
    expect(environment.SSH_AUTH_SOCK).toBe('/run/agent.sock');
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined();
  });
});
