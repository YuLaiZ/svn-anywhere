/**
 * 输出脱敏与流式行缓冲。core 模块，纯逻辑，不依赖 vscode。
 * 宿主写 OutputChannel 前必须经过这里的脱敏函数。
 */

/** 把 --password 后面的值（含带引号的空格密码）替换为 ***。 */
export function sanitizeText(text: string): string {
  return text.replace(/(--password(?:=|\s+))("[^"]*"|'[^']*'|[^\s]+)/gi, '$1***');
}

/**
 * 命令参数脱敏：用于错误消息、日志回显等拼接 args 的场景。
 * `--password` 的下一个参数与 `--password=<值>` 两种形态都处理。
 */
export function redactArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return '***';
    }
    if (arg === '--password') {
      redactNext = true;
      return arg;
    }
    if (arg.toLowerCase().startsWith('--password=')) {
      return '--password=***';
    }
    return arg;
  });
}

/**
 * 行缓冲写入器：svn 输出按 chunk 到达，`--password` 与其值可能被拆进两个
 * chunk，按 chunk 直接脱敏会失效；攒齐一行（以 \n 分隔）再脱敏输出。
 */
export class LineBuffer {
  private pending = '';

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: string): void {
    this.pending += chunk;
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.emit(sanitizeText(line));
      index = this.pending.indexOf('\n');
    }
  }

  /** 输出流结束时冲出未换行的残余内容。 */
  flush(): void {
    if (this.pending) {
      this.emit(sanitizeText(this.pending));
      this.pending = '';
    }
  }
}
