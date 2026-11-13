#!/usr/bin/env node
/**
 * M4 阶段 0 V5-4 性能基准：快速差异（svn diff -U0）与行内追溯（svn blame --xml）
 * 的命令耗时与解析耗时。参数：<工作副本目录>，默认 /tmp/m4-stage0-v5/perf-wc。
 *
 * 复跑前提：工作副本内 small-1mib.txt、large-10mib.txt、lines-10k.txt 已提交，
 * 且各自中部有一处本地修改（脚本会打印状态提示，不修改文件）。
 * 依赖项目 devDependencies 的 fast-xml-parser（blame XML 解析口径与阶段 1 一致）。
 *
 * 用法：node test/fixtures/m4-stage0/m4-v5-bench.mjs [wcPath]
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(scriptDir, '..', '..', '..');
const requireFromProject = createRequire(join(projectDir, 'package.json'));
const { XMLParser } = requireFromProject('fast-xml-parser');

const WC = process.argv[2] || '/tmp/m4-stage0-v5/perf-wc';
const ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
const FILES = ['small-1mib.txt', 'large-10mib.txt', 'lines-10k.txt'];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'entry',
});

function runSvn(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    execFile(
      'svn',
      args,
      { cwd: WC, env: ENV, timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({ stdout, stderr, exitCode: err ? (err.code ?? -1) : 0, killed: Boolean(err && err.killed), ms });
      },
    );
  });
}

function parseHunks(text) {
  const hunks = [];
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('Index: ')) file = line.slice(7);
    else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        hunks.push({
          file,
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }
  }
  return hunks;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.map((v) => Number(v.toFixed(2))),
    minMs: Number(sorted[0].toFixed(2)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

async function benchOne(file, blameRuns) {
  const workBytes = statSync(join(WC, file)).size;
  const workLines = readFileSync(join(WC, file), 'utf8').split('\n').length - 1;

  const diffTimes = [];
  let diffOut = '';
  for (let i = 0; i < 5; i += 1) {
    const r = await runSvn(
      ['diff', '--non-interactive', '--internal-diff', '--ignore-properties', '-r', 'BASE', '-x', '-U0', '--', file],
      120000,
    );
    if (r.exitCode !== 0) throw new Error(`diff ${file} exit=${r.exitCode} stderr=${r.stderr}`);
    diffTimes.push(r.ms);
    diffOut = r.stdout;
  }
  const diffParseTimes = [];
  let hunks = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = process.hrtime.bigint();
    hunks = parseHunks(diffOut);
    diffParseTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  const blameTimes = [];
  let blameXml = '';
  let blameExit = 0;
  let blameKilled = false;
  for (let i = 0; i < blameRuns; i += 1) {
    const r = await runSvn(['blame', '--xml', '--non-interactive', '--', file], 900000);
    blameTimes.push(r.ms);
    blameXml = r.stdout;
    blameExit = r.exitCode;
    blameKilled = r.killed;
    if (r.exitCode !== 0) break;
  }
  const blameParseTimes = [];
  let entryCount = null;
  let entriesWithoutCommit = null;
  let targetPath = null;
  if (!blameKilled && blameXml) {
    for (let i = 0; i < 3; i += 1) {
      const t0 = process.hrtime.bigint();
      const doc = parser.parse(blameXml);
      const entries = doc?.blame?.target?.entry ?? [];
      entryCount = entries.length;
      entriesWithoutCommit = entries.filter((e) => e.commit === undefined).length;
      targetPath = doc?.blame?.target?.['@_path'] ?? null;
      blameParseTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }

  return {
    file,
    workBytes,
    workLines,
    diff: {
      exitCode: 0,
      outputBytes: Buffer.byteLength(diffOut),
      hunkCount: hunks.length,
      hunks,
      ...stats(diffTimes),
      parse: stats(diffParseTimes),
    },
    blame: {
      exitCode: blameExit,
      killed: blameKilled,
      xmlBytes: Buffer.byteLength(blameXml),
      targetPath,
      entryCount,
      entriesWithoutCommit: entriesWithoutCommit ?? undefined,
      ...stats(blameTimes),
      parse: blameParseTimes.length ? stats(blameParseTimes) : null,
    },
  };
}

const results = {};
for (const file of FILES) {
  const blameRuns = file === 'large-10mib.txt' ? 1 : 3;
  results[file] = await benchOne(file, blameRuns);
  console.error(`done ${file}`);
}
console.log(JSON.stringify({ wc: WC, at: new Date().toISOString(), node: process.version, results }, null, 2));
