/**
 * 集成测试共用的本地 SVN 实验仓库：svnadmin create + file:// 检出，
 * 不碰任何远端服务器与生产副本。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SvnLab {
  root: string;
  repoUrl: string;
  /** 执行 svn 命令并返回 stdout。 */
  svn(args: string[], cwd?: string): string;
  /** 检出一份工作副本（目录名原样，可用于含 @ 的转义场景）。 */
  checkout(name: string): string;
  cleanup(): void;
}

export function createSvnLab(prefix: string): SvnLab {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoPath = join(root, 'repo');
  execFileSync('svnadmin', ['create', repoPath]);
  // macOS 的 tmpdir 是符号链接，URL 必须用 realpath 后的路径。
  const repoUrl = `file://${repoPath}`;

  return {
    root,
    repoUrl,
    svn(args, cwd) {
      return execFileSync('svn', args, { cwd, encoding: 'utf8' });
    },
    checkout(name) {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      // 在目录内用 `.` 检出：目录名可能含 @（peg 转义场景），
      // 作为 checkout 目标参数时 svn 不剥离尾部 @，直接传会建出错误目录名。
      this.svn(['checkout', '-q', repoUrl, '.'], path);
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 在副本内写入文件（自动建父目录）并按需 svn add。 */
export function writeFile(wc: string, relative: string, content: string, add = false): void {
  const path = join(wc, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (add) {
    // --parents 自动补建未版本控制的中间目录；目标含 @ 时仍须 peg 转义。
    const escaped = relative.includes('@') ? `${relative}@` : relative;
    execFileSync('svn', ['add', '-q', '--parents', escaped], { cwd: wc, encoding: 'utf8' });
  }
}
