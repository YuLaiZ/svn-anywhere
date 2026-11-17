/**
 * 共享 XML 语义测试（M4 阶段 1）：
 * 流式 SAX（saxes）与整段 fast-xml-parser 必须对同一份 svn XML 得到相同的
 * 文本语义——
 * - 文本值不 trim（首尾空格属于名称）；
 * - XML 实体只解码一次（`&amp;`→`&`、`&amp;amp;`→`&amp;`）；
 * - 数字实体（十/十六进制）解码；
 * - CDATA 当作文本；
 * - 属性值不规范化（首尾空格原样）；
 * - UTF-8 中文/emoji 跨任意字节分块（StringDecoder）不产生 U+FFFD。
 *
 * 断言方式：同一内联 XML fixture 分别经 fast-xml-parser（整段）与
 * saxes（跨 chunk 流式）解析，提取的条目名称/kind/list path 必须逐字段
 * 相等，并对期望字面值单独断言（防止两库一起错）。
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import { Utf8StreamDecoder, run, urlWithPeg } from '../src/core/svnCli';
import { createSvnLab, writeFile } from './helpers';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

let hasSvnadmin = false;
try {
  execSync('svnadmin --version', { stdio: 'ignore' });
  hasSvnadmin = true;
} catch {
  hasSvnadmin = false;
}

/** 与项目现有解析器一致的 fast-xml-parser 配置（见 core/status、core/checkout）。 */
const fastXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径与名称中的首尾空格属于名称，不能改变身份。
  trimValues: false,
  // SVN 用数字实体表示路径字符；解码一次，保留 &amp; 编码的字面实体。
  htmlEntities: true,
  // 名称保持字符串原文，不把纯数字名称转成 number（流式 SAX 也保持文本）。
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'entry',
});

interface ListEntry {
  kind: string;
  name: string;
}

interface ListSemantics {
  listPath: string;
  entries: ListEntry[];
}

/** 整段解析路径：fast-xml-parser（既有模块的解析形态）。 */
function viaFastXml(xml: string): ListSemantics {
  const parsed = fastXmlParser.parse(xml) as {
    lists?: {
      list?: {
        path?: string;
        entry?: Array<{ kind?: string; name?: string }>;
      };
    };
  };
  const list = parsed.lists?.list;
  return {
    listPath: String(list?.path ?? ''),
    entries: (list?.entry ?? []).map((entry) => ({
      kind: String(entry.kind ?? ''),
      name: String(entry.name ?? ''),
    })),
  };
}

/**
 * 流式解析路径：runStream 调用侧的形态——
 * StringDecoder('utf8') 跨 chunk 解码 → saxes SAX；文本与 CDATA 事件都
 * 计入当前 <name> 的文本（CDATA 当作文本）。
 */
function viaSaxes(chunks: readonly Buffer[]): ListSemantics {
  const parser = new SaxesParser({ xmlns: false });
  const entries: ListEntry[] = [];
  let listPath = '';
  let current: ListEntry | undefined;
  let nameText: string | undefined;

  parser.on('opentag', (tag) => {
    if (tag.name === 'list') {
      listPath = tag.attributes.path ?? '';
    } else if (tag.name === 'entry') {
      current = { kind: tag.attributes.kind ?? '', name: '' };
    } else if (tag.name === 'name') {
      nameText = '';
    }
  });
  parser.on('text', (text) => {
    if (nameText !== undefined) {
      nameText += text;
    }
  });
  parser.on('cdata', (text) => {
    if (nameText !== undefined) {
      nameText += text;
    }
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 'name' && current) {
      current.name = nameText ?? '';
      nameText = undefined;
    } else if (tag.name === 'entry' && current) {
      entries.push(current);
      current = undefined;
    }
  });

  const decoder = new Utf8StreamDecoder();
  for (const chunk of chunks) {
    parser.write(decoder.write(chunk));
  }
  parser.write(decoder.end());
  parser.close();
  return { listPath, entries };
}

/** 把 Buffer 按给定块长循环切分（模拟管道任意分块边界）。 */
function chunkBuffer(data: Buffer, sizes: readonly number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(data.subarray(offset, Math.min(offset + size, data.length)));
    offset += size;
    index += 1;
  }
  return chunks;
}

/** 覆盖全部语义点的内联 fixture（模拟 svn list --xml 的 lists/list/entry）。 */
const SEMANTIC_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<lists>
<list path=" https://example.com/repo/ trunk ">
<entry kind="file">
<name> leading and trailing </name>
<size>12</size>
</entry>
<entry kind="file">
<name>a&amp;b &lt;tag&gt; &#20013;&#25991; &#x4E2D;</name>
</entry>
<entry kind="file">
<name><![CDATA[raw <tag> & text]]></name>
</entry>
<entry kind="file">
<name>&amp;amp;</name>
</entry>
<entry kind="dir">
<name>中文 目录/at@file#1.txt</name>
</entry>
<entry kind="file">
<name>emoji 🚀 名称.txt</name>
</entry>
</list>
</lists>
`;

/** 期望的语义结果（对两库共同断言，防止实现一起漂移）。 */
const EXPECTED: ListSemantics = {
  listPath: ' https://example.com/repo/ trunk ',
  entries: [
    { kind: 'file', name: ' leading and trailing ' },
    { kind: 'file', name: 'a&b <tag> 中文 中' },
    { kind: 'file', name: 'raw <tag> & text' },
    { kind: 'file', name: '&amp;' },
    { kind: 'dir', name: '中文 目录/at@file#1.txt' },
    { kind: 'file', name: 'emoji 🚀 名称.txt' },
  ],
};

describe('XML 语义基线（saxes 流式 vs fast-xml-parser 整段）', () => {
  it('内联 fixture：不 trim、实体一次解码、CDATA、数字实体、中文/emoji、属性首尾空格全部一致', () => {
    const fast = viaFastXml(SEMANTIC_FIXTURE);
    const saxes = viaSaxes([Buffer.from(SEMANTIC_FIXTURE, 'utf8')]);
    expect(fast).toEqual(EXPECTED);
    expect(saxes).toEqual(EXPECTED);
    expect(saxes).toEqual(fast);
  });

  it('任意字节分块（含切在多字节字符中间）：StringDecoder 跨 chunk 解码与整段结果一致且无 U+FFFD', () => {
    const data = Buffer.from(SEMANTIC_FIXTURE, 'utf8');
    // 1/2/3/5/7/11 字节循环切分：中文 3 字节、emoji 4 字节的边界必被切断。
    for (const sizes of [[1], [2], [3], [1, 2, 3, 5, 7, 11], [64 * 1024]]) {
      const decodedChunks = viaSaxes(chunkBuffer(data, sizes));
      expect(decodedChunks).toEqual(EXPECTED);
      for (const entry of decodedChunks.entries) {
        expect(entry.name).not.toContain('�');
      }
    }
  });

  it('对照组：逐块 Buffer.toString 在分块边界产生 U+FFFD（说明必须用 StringDecoder）', () => {
    // 「中文」UTF-8 为 E4 B8 AD E6 96 87；在 3 字节处切块会把「中」的尾字节
    // 与「文」割裂，逐块 toString 各自产生替换符。
    const data = Buffer.from('<name>中文</name>', 'utf8');
    const naive = chunkBuffer(data, [4])
      .map((chunk) => chunk.toString('utf8'))
      .join('');
    expect(naive).toContain('�');

    // 同一字节流的 StringDecoder 解码结果无损。
    const decoder = new Utf8StreamDecoder();
    const decoded = chunkBuffer(data, [4])
      .map((chunk) => decoder.write(chunk))
      .join('') + decoder.end();
    expect(decoded).toBe('<name>中文</name>');
  });

  it('CDATA 与文本混排：CDATA 当作文本拼接（不在两库间产生差异）', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<lists>
<list path="r">
<entry kind="file"><name>pre <![CDATA[<middle> & raw]]> post</name></entry>
</list>
</lists>`;
    const fast = viaFastXml(xml);
    const saxes = viaSaxes([Buffer.from(xml, 'utf8')]);
    expect(fast.entries).toEqual([{ kind: 'file', name: 'pre <middle> & raw post' }]);
    expect(saxes).toEqual(fast);
  });
});

describe('真实 svn list --xml 的语义对齐（svnadmin + file://）', () => {
  it.runIf(hasSvn && hasSvnadmin)('首尾空格/中文/&/@/# 文件名：流式 SAX 与整段 fast-xml-parser 一致', async () => {
    const lab = createSvnLab('svn-anywhere-xmlsemantics-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, ' leading and trailing .txt', 'a\n');
      writeFile(src, '中文&特殊.txt', 'b\n');
      writeFile(src, 'at@file#1.txt', 'c\n');
      writeFile(src, 'emoji 🚀.txt', 'd\n');
      const imported = await run('svn', ['import', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      expect(imported.exitCode).toBe(0);

      const listed = await run('svn', [
        'list', '--xml', '--non-interactive', '--depth', 'immediates', '-r', 'HEAD',
        '--', urlWithPeg(`${lab.repoUrl}/trunk`),
      ]);
      expect(listed.exitCode).toBe(0);

      const fast = viaFastXml(listed.stdout);
      const whole = viaSaxes([Buffer.from(listed.stdout, 'utf8')]);
      const chunked = viaSaxes(chunkBuffer(Buffer.from(listed.stdout, 'utf8'), [1, 2, 3, 5, 7]));
      expect(whole).toEqual(fast);
      expect(chunked).toEqual(fast);

      const names = fast.entries.map((entry) => entry.name);
      expect(names).toContain(' leading and trailing .txt');
      expect(names).toContain('中文&特殊.txt');
      expect(names).toContain('at@file#1.txt');
      expect(names).toContain('emoji 🚀.txt');
      for (const name of names) {
        expect(name).not.toContain('�');
      }
      // 真实 XML 中 & 以 &amp; 编码出现，解析后只解码一次。
      expect(listed.stdout).toContain('中文&amp;特殊.txt');
    } finally {
      lab.cleanup();
    }
  });
});
