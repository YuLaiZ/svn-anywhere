/**
 * svn update 的解析与执行测试：解析纯函数覆盖主会话实测样本
 * （普通明细、冲突、自动合并 G、树冲突、externals 段）；runUpdate 走
 * 本地 file:// 副本集成链路，重点验证「冲突时退出码仍为 0，必须靠解析
 * 判断」与含 @ 的检出目录转义。
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseUpdateOutput, runUpdate } from '../src/core/update';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-update-');
afterAll(() => lab.cleanup());

describe('parseUpdateOutput', () => {
  it('解析主会话实测样本：明细行、最终 revision、冲突路径', () => {
    const result = parseUpdateOutput(`Updating '.':
D    src/c.txt
C    src/a.txt
A    src/added-remote.txt
Updated to revision 4.
Summary of conflicts:
  Text conflicts: 1
`);
    expect(result.items).toEqual([
      { status: 'D', path: 'src/c.txt' },
      { status: 'C', path: 'src/a.txt' },
      { status: 'A', path: 'src/added-remote.txt' },
    ]);
    expect(result.finalRevision).toBe(4);
    expect(result.conflicts).toEqual(['src/a.txt']);
  });

  it('干净副本：只有 At revision，无明细与冲突', () => {
    const result = parseUpdateOutput("Updating '.':\nAt revision 4.\n");
    expect(result.items).toEqual([]);
    expect(result.finalRevision).toBe(4);
    expect(result.conflicts).toEqual([]);
  });

  it('自动合并的 G 行与远端删除的 D 行都进明细（实测样本）', () => {
    const result = parseUpdateOutput(`Updating '.':
G    src/g.txt
D    sub
Updated to revision 6.
`);
    expect(result.items).toEqual([
      { status: 'G', path: 'src/g.txt' },
      { status: 'D', path: 'sub' },
    ]);
    expect(result.finalRevision).toBe(6);
    expect(result.conflicts).toEqual([]);
  });

  it('树冲突行（行首空格 + C）识别为冲突；噪音行不影响解析（实测样本）', () => {
    const result = parseUpdateOutput(`Updating '.':
   C sub
U    src/g.txt
svn: warning: W205011: Error handling externals definition for 'src/ext-sub':
Updated to revision 4.
Searching tree conflict details for 'sub' in repository:
Checking r4...Checking r3... done
Summary of conflicts:
  Tree conflicts: 1
`);
    expect(result.items).toEqual([
      { status: 'C', path: 'sub' },
      { status: 'U', path: 'src/g.txt' },
    ]);
    expect(result.finalRevision).toBe(4);
    expect(result.conflicts).toEqual(['sub']);
  });

  it('解析 Summary of conflicts 段计数（Text/Tree）', () => {
    const result = parseUpdateOutput(`Updating '.':
C    src/a.txt
Updated to revision 4.
Summary of conflicts:
  Text conflicts: 1
  Property conflicts: 0
  Tree conflicts: 1
`);
    expect(result.conflicts).toEqual(['src/a.txt']);
    expect(result.conflictSummary).toEqual({ text: 1, tree: 1 });
  });

  it('Summary 段有计数但无 C 行时计数照记（宿主兜底提示依据）', () => {
    const result = parseUpdateOutput(`Updating '.':
At revision 7.
Summary of conflicts:
  Tree conflicts: 1
`);
    expect(result.conflicts).toEqual([]);
    expect(result.conflictSummary).toEqual({ tree: 1 });
  });

  it('externals 段不产生明细，也不误提取为主副本 revision（实测样本）', () => {
    const result = parseUpdateOutput(`Updating '.':

Fetching external item into 'src/ext-sub':
External at revision 3.

At revision 5.
`);
    expect(result.items).toEqual([]);
    expect(result.finalRevision).toBe(5);
    expect(result.conflicts).toEqual([]);
  });

  it('externals 更新段的 Updated external to revision 不覆盖主副本 revision', () => {
    const result = parseUpdateOutput(`Updating '.':
U    src/g.txt

Fetching external item into 'src/ext-sub':
Updated external to revision 3.

At revision 5.
`);
    expect(result.items).toEqual([{ status: 'U', path: 'src/g.txt' }]);
    expect(result.finalRevision).toBe(5);
  });
});

describe('runUpdate 集成（本地 file:// 副本）', () => {
  it('拉取远端提交的新文件，明细与最终 revision 正确', async () => {
    const base = lab.checkout('u-base');
    writeFile(base, 'a.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'init'], base);

    const other = lab.checkout('u-other');
    writeFile(other, 'remote-new.txt', 'new', true);
    lab.svn(['commit', '-q', '-m', 'add remote file'], other);

    const result = await runUpdate('svn', base, { cwd: base });
    expect(result.items).toEqual([{ status: 'A', path: 'remote-new.txt' }]);
    expect(result.finalRevision).toBe(headRevision(lab));
    expect(result.conflicts).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('冲突场景：退出码为 0，必须靠解析发现冲突', async () => {
    const base = lab.checkout('u-conflict-base');
    writeFile(base, 'c.txt', 'line1\n', true);
    lab.svn(['commit', '-q', '-m', 'base'], base);

    const other = lab.checkout('u-conflict-other');
    writeFile(other, 'c.txt', 'line1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'remote edit'], other);

    writeFile(base, 'c.txt', 'line1\nlocal\n');
    const result = await runUpdate('svn', base, { cwd: base });

    expect(result.exitCode).toBe(0);
    expect(result.conflicts).toEqual(['c.txt']);
    expect(result.items.some((i) => i.status === 'C' && i.path === 'c.txt')).toBe(true);
  });

  it('树冲突场景：本地编辑远端已删除的目录，解析出冲突', async () => {
    const base = lab.checkout('u-tree-base');
    writeFile(base, 'dir/nested.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'dir base'], base);

    const other = lab.checkout('u-tree-other');
    lab.svn(['delete', '-q', 'dir'], other);
    lab.svn(['commit', '-q', '-m', 'remote delete dir'], other);

    writeFile(base, 'dir/nested.txt', 'local edit\n');
    const result = await runUpdate('svn', base, { cwd: base });

    expect(result.exitCode).toBe(0);
    expect(result.conflicts).toEqual(['dir']);
  });

  it('检出目录名含 @2（严格 peg 语法）：escapePeg 转义后更新正常', async () => {
    const pegWc = lab.checkout('u-peg@2');
    writeFile(pegWc, 'p.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'peg base'], pegWc);

    const other = lab.checkout('u-peg-other');
    // p.txt 已随 base 提交进入版本控制，这里修改内容即可，不能再 add。
    writeFile(other, 'p.txt', 'v1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'peg remote'], other);

    const result = await runUpdate('svn', pegWc, { cwd: pegWc });
    expect(result.items).toEqual([{ status: 'U', path: 'p.txt' }]);
    expect(result.finalRevision).toBe(headRevision(lab));
  });

  it('目标路径含 @ 的文件更新不误判 peg revision', async () => {
    const wc = lab.checkout('u-file-peg');
    writeFile(wc, 'archive@2.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'at file'], wc);

    const other = lab.checkout('u-file-peg-other');
    // archive@2.txt 已版本化，直接修改内容。
    writeFile(other, 'archive@2.txt', 'v1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'at remote'], other);

    const result = await runUpdate('svn', join(wc, 'archive@2.txt'), { cwd: wc });
    expect(result.items).toEqual([{ status: 'U', path: 'archive@2.txt' }]);
  });
});

/** 取仓库 HEAD revision（共享 repo 下用例间提交数不固定，动态比对；
 * 工作副本是 mixed revision 不可作准）。 */
function headRevision(lab: ReturnType<typeof createSvnLab>): number {
  return Number(lab.svn(['info', '--show-item', 'revision', lab.repoUrl]).trim());
}
