/**
 * 流式进度的字节层解析三件套（检出/导入执行器共用，形态对齐
 * test/svnCliStream.test.ts 的行缓冲口径）：
 *
 * - ByteLineBuffer：按 0x0A 分行的跨块行缓冲；
 * - lenientUtf8：流式阶段的显示解码（UTF-8 宽松，非法字节替换 U+FFFD）；
 * - startsWithBytes：前缀为 ASCII 字节的原始字节比对（不依赖行内容解码）。
 *
 * 单一来源导出：执行器不得各自复制实现（复制漂移的先例即 W 码兜底
 * 笔误，见评审第 1 轮 P2-1）。
 */

/**
 * 字节层行缓冲：按 0x0A 分行（GBK 双字节的尾字节不会产生 0x0A，UTF-8
 * 多字节字符也不含 0x0A，按字节拆行不会截断多字节字符），跨块拼接完整
 * 行；进程结束后用 flush 取回无换行结尾的残留尾段。
 */
export class ByteLineBuffer {
  private pending: Buffer = Buffer.alloc(0);

  /** 喂入一块，返回由这块完成的完整行（不含换行符）。 */
  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const lines: Buffer[] = [];
    for (;;) {
      const idx = this.pending.indexOf(0x0a);
      if (idx < 0) {
        return lines;
      }
      lines.push(this.pending.subarray(0, idx));
      this.pending = this.pending.subarray(idx + 1);
    }
  }

  /** 取回不完整的尾段（进程结束后的残留），无残留返回 null。 */
  flush(): Buffer | null {
    if (this.pending.length === 0) {
      return null;
    }
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

/** 流式阶段的显示解码：UTF-8 宽松（非法字节替换为 U+FFFD），不做编码回退链。 */
export function lenientUtf8(line: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(line);
}

/** 字节层前缀匹配：前缀为 ASCII 字节，直接比对原始字节，不依赖行内容解码。 */
export function startsWithBytes(line: Buffer, prefix: string): boolean {
  const prefixBuf = Buffer.from(prefix, 'utf8');
  return line.subarray(0, prefixBuf.length).equals(prefixBuf);
}
