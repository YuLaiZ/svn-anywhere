/**
 * svn 输出解码回退链。core 模块，纯逻辑，不依赖 vscode。
 *
 * 解码顺序（配置驱动，宿主在 svnCli 调用点注入）：
 * 1. 主编码（默认 UTF-8）严格解码：fatal 模式，出现非法字节即失败；
 * 2. 失败后按回退链逐个严格重试（默认 gbk → gb2312 → big5；Node 18
 *    起 full-icu 的 TextDecoder 原生支持这些编码，不需要 iconv 子进程）；
 * 3. 全部候选失败时按 UTF-8 宽松解码（非法字节替换为 U+FFFD），并标记
 *    lenient，由宿主在输出频道标注「编码回退失败」。
 * BOM（UTF-8 的 EF BB BF、UTF-16 的 FF FE / FE FF）在解码前统一剥离。
 */

/** 输出解码主编码的默认值。 */
export const DEFAULT_OUTPUT_ENCODING = 'UTF-8';

/** 主编码严格解码失败后的默认回退链。 */
export const DEFAULT_ENCODING_FALLBACK: readonly string[] = ['gbk', 'gb2312', 'big5'];

export interface DecodeOutcome {
  text: string;
  /** 实际解码成功的编码 label；宽松兜底时为 'utf-8'。 */
  encoding: string;
  /** 全部候选严格解码失败，已按 UTF-8 宽松解码（文本含替换符）。 */
  lenient: boolean;
  /** 成功解码发生在回退链中（或宽松兜底），不是主编码。 */
  fellBack: boolean;
}

/** 解码回退链全部失败（宽松兜底）时通知宿主写频道标注。 */
export interface DecodingFallbackNotice {
  source: 'stdout' | 'stderr';
  primary: string;
  fallback: readonly string[];
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/** 严格解码器缓存；不支持的编码 label 缓存为 null，避免重复抛异常。 */
const strictDecoders = new Map<string, TextDecoder | null>();

function strictDecoder(label: string): TextDecoder | null {
  if (strictDecoders.has(label)) {
    return strictDecoders.get(label) ?? null;
  }
  let decoder: TextDecoder | null = null;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    // RangeError：宿主 ICU 不支持的编码 label，跳过该候选。
    decoder = null;
  }
  strictDecoders.set(label, decoder);
  return decoder;
}

/** 剥离字节序列开头的 BOM（UTF-8 / UTF-16 LE / BE）。 */
export function stripBom(buf: Buffer): Buffer {
  if (buf.length >= 3 && UTF8_BOM.equals(buf.subarray(0, 3))) {
    return buf.subarray(3);
  }
  if (buf.length >= 2
    && (UTF16LE_BOM.equals(buf.subarray(0, 2)) || UTF16BE_BOM.equals(buf.subarray(0, 2)))) {
    return buf.subarray(2);
  }
  return buf;
}

/** 解码结果开头残留的 U+FEFF 再剥一次（覆盖个别编码不解码 BOM 的差异）。 */
function stripDecodedBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * 按回退链解码一段 svn 输出字节。候选编码去重（label 大小写不敏感）、
 * 忽略空值与不支持的 label；空字节序列按主编码解码为空文本。
 * 缺省与产品默认配置一致：UTF-8 主编码 + gbk/gb2312/big5 回退链。
 */
export function decodeBuffer(
  buf: Buffer,
  primary: string = DEFAULT_OUTPUT_ENCODING,
  fallback: readonly string[] = DEFAULT_ENCODING_FALLBACK,
): DecodeOutcome {
  const data = stripBom(buf);
  const primaryLabel = primary.trim();
  const seen = new Set<string>();
  const candidates = [primaryLabel, ...fallback].map((label) => label.trim()).filter(Boolean);
  for (const label of candidates) {
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const decoder = strictDecoder(label);
    if (!decoder) {
      continue;
    }
    try {
      const text = decoder.decode(data);
      return {
        text: stripDecodedBom(text),
        encoding: label,
        lenient: false,
        fellBack: label.toLowerCase() !== primaryLabel.toLowerCase(),
      };
    } catch {
      // 严格解码失败：尝试下一个候选编码。
    }
  }
  const lenient = new TextDecoder('utf-8', { fatal: false });
  return {
    text: stripDecodedBom(lenient.decode(data)),
    encoding: 'utf-8',
    lenient: true,
    fellBack: true,
  };
}
