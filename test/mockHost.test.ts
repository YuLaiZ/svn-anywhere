/**
 * mock 宿主的编辑器装饰、保存事件与 P5 只读内容 API 语义（M4 阶段 4
 * F107/F108 验收与阶段 2 P5 场景依赖）。fakeVscode 按 VS Code API 契约提供
 * OverviewRulerLane、createTextEditorDecorationType、setDecorations、
 * onDidSaveTextDocument，以及 Uri.from、registerTextDocumentContentProvider、
 * env.clipboard/openExternal；本测试锁定这些替身语义，避免 mock-host 场景
 * 建立在与真实宿主不同的行为上。
 */
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';

interface FakeDecorationType {
  key: string;
  options: Record<string, unknown>;
  disposed: boolean;
  dispose(): void;
}

interface FakeRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface FakeEditor {
  document: { uri: { toString(): string }; lineCount: number; save(): Promise<boolean> };
  active: boolean;
  setDecorations(type: FakeDecorationType, value: unknown[]): void;
  _getDecorations(type: FakeDecorationType): Array<{ range: FakeRange }>;
  dispose(): void;
}

interface FakeRangeConstructor {
  new (start: { line: number; character: number }, end: { line: number; character: number }): FakeRange;
  new (startLine: number, startCharacter: number, endLine: number, endCharacter: number): FakeRange;
}

interface FakeVscode {
  OverviewRulerLane: Record<'Left' | 'Center' | 'Right' | 'Full', number>;
  DecorationRangeBehavior: Record<'OpenOpen' | 'ClosedClosed' | 'OpenClosed' | 'ClosedOpen', number>;
  Position: new (line: number, character: number) => { line: number; character: number };
  Range: FakeRangeConstructor;
  Uri: {
    from(components: {
      scheme: string;
      authority?: string;
      path?: string;
      query?: string;
      fragment?: string;
    }): {
      scheme: string;
      path: string;
      query?: string;
      fragment?: string;
      fsPath?: string;
      toString(): string;
    };
    file(path: string): { scheme: string; path: string; fsPath: string; toString(): string };
  };
  window: {
    activeTextEditor: FakeEditor | undefined;
    createTextEditorDecorationType(options: unknown): FakeDecorationType;
    showTextDocument(document: unknown, options?: unknown): Promise<FakeEditor>;
  };
  workspace: {
    openTextDocument(arg: unknown): Promise<FakeEditor['document']>;
    onDidSaveTextDocument(handler: (document: FakeEditor['document']) => unknown): { dispose(): void };
    registerTextDocumentContentProvider(
      scheme: string,
      provider: { provideTextDocumentContent(uri: unknown): string },
    ): { dispose(): void };
  };
  env: {
    clipboard: { writeText(value: string): Promise<void> };
    openExternal(uri: unknown): Promise<boolean>;
  };
}

interface FakeState {
  decorationTypes: FakeDecorationType[];
  decorationCalls: Array<{ key: string; count: number; cleared: boolean }>;
  saveDocHandlers: unknown[];
  saveDocEvents: unknown[];
  listenerErrors: unknown[];
  textDocuments: Map<string, unknown>;
  editors: FakeEditor[];
  contentProviders: Map<string, { provideTextDocumentContent(uri: unknown): string }>;
  clipboard: string[];
  openedExternal: string[];
}

const requireFromRoot = createRequire(join(process.cwd(), 'package.json'));
const mockHost = requireFromRoot('./scripts/mock-host.cjs') as {
  fakeVscode: FakeVscode;
  state: FakeState;
};
const { fakeVscode, state } = mockHost;

async function openEditor(): Promise<FakeEditor> {
  const document = await fakeVscode.workspace.openTextDocument({ content: 'alpha\nbeta\ngamma' });
  return fakeVscode.window.showTextDocument(document, { preview: false });
}

beforeEach(() => {
  // fakeVscode 是模块级单例：逐用例重置本组新增的宿主状态，避免相互污染。
  state.decorationTypes.length = 0;
  state.decorationCalls.length = 0;
  state.saveDocHandlers.length = 0;
  state.saveDocEvents.length = 0;
  state.listenerErrors.length = 0;
  state.textDocuments.clear();
  state.editors.length = 0;
  state.contentProviders.clear();
  state.clipboard.length = 0;
  state.openedExternal.length = 0;
  fakeVscode.window.activeTextEditor = undefined;
});

describe('fakeVscode 装饰枚举', () => {
  it('OverviewRulerLane 与 DecorationRangeBehavior 值符合 VS Code API', () => {
    expect(fakeVscode.OverviewRulerLane).toEqual({ Left: 1, Center: 2, Right: 4, Full: 7 });
    expect(fakeVscode.DecorationRangeBehavior).toEqual({ OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 });
  });

  it('Position/Range 按真实契约校验参数', () => {
    expect(() => new fakeVscode.Position(-1, 0)).toThrow(/line/);
    expect(() => new fakeVscode.Position(0, 1.5)).toThrow(/character/);
    expect(() => new fakeVscode.Range(2, 0, 1, 0)).toThrow(/start/);
    expect(new fakeVscode.Range(0, 0, 0, 3)).toBeTruthy();
  });
});

describe('createTextEditorDecorationType', () => {
  it('返回唯一 key，并接受 F107/F108 用到的完整选项形态', () => {
    const first = fakeVscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 200, 0, 0.20)',
      overviewRulerColor: 'rgba(255, 200, 0, 0.80)',
      overviewRulerLane: fakeVscode.OverviewRulerLane.Right,
      after: { contentText: ' r12 · alice', color: 'rgba(128, 128, 128, 0.90)' },
      rangeBehavior: fakeVscode.DecorationRangeBehavior.ClosedClosed,
    });
    const second = fakeVscode.window.createTextEditorDecorationType({ isWholeLine: true });
    expect(typeof first.key).toBe('string');
    expect(first.key).not.toBe(second.key);
    expect(state.decorationTypes).toHaveLength(2);
  });

  it('DecorationRenderOptions 非法值时抛错', () => {
    expect(() => fakeVscode.window.createTextEditorDecorationType(undefined)).toThrow(/object/);
    expect(() => fakeVscode.window.createTextEditorDecorationType({ overviewRulerLane: 3 })).toThrow(/overviewRulerLane/);
    expect(() => fakeVscode.window.createTextEditorDecorationType({ rangeBehavior: 9 })).toThrow(/rangeBehavior/);
    expect(() => fakeVscode.window.createTextEditorDecorationType({ isWholeLine: 'yes' })).toThrow(/isWholeLine/);
    expect(() => fakeVscode.window.createTextEditorDecorationType({ after: { contentText: 1 } })).toThrow(/contentText/);
    expect(() => fakeVscode.window.createTextEditorDecorationType({ backgroundColor: 42 })).toThrow(/backgroundColor/);
  });
});

describe('TextEditor.setDecorations', () => {
  it('同类型覆盖更新，空数组清空集合', async () => {
    const editor = await openEditor();
    const type = fakeVscode.window.createTextEditorDecorationType({ backgroundColor: '#ffff00' });

    editor.setDecorations(type, [new fakeVscode.Range(0, 0, 0, 3)]);
    expect(editor._getDecorations(type)).toHaveLength(1);

    // DecorationOptions 形态（带 range 与附加字段）同样接受；再次调用覆盖旧集合。
    editor.setDecorations(type, [
      new fakeVscode.Range(0, 0, 0, 1),
      { range: new fakeVscode.Range(1, 0, 1, 2), hoverMessage: 'base' },
    ]);
    expect(editor._getDecorations(type).map((item) => item.range.start.line)).toEqual([0, 1]);

    editor.setDecorations(type, []);
    expect(editor._getDecorations(type)).toHaveLength(0);
    expect(state.decorationCalls.map((call) => call.count)).toEqual([1, 2, 0]);
    expect(state.decorationCalls.at(-1)?.cleared).toBe(true);
  });

  it('拒绝非装饰类型、已释放类型与非 Range 项', async () => {
    const editor = await openEditor();
    const type = fakeVscode.window.createTextEditorDecorationType({});
    expect(() => editor.setDecorations({ key: 'fake' } as unknown as FakeDecorationType, [])).toThrow(/decorationType/);
    expect(() => editor.setDecorations(type, 'not-an-array' as unknown as unknown[])).toThrow(/array/);
    expect(() => editor.setDecorations(type, [{ start: { line: 0, character: 0 } }])).toThrow(/decorations\[0\]/);
    type.dispose();
    expect(() => editor.setDecorations(type, [])).toThrow(/disposed/);
  });

  it('装饰类型 dispose 幂等，并撤下所有编辑器上的该类型装饰', async () => {
    const editor = await openEditor();
    const other = await fakeVscode.window.showTextDocument(editor.document);
    const type = fakeVscode.window.createTextEditorDecorationType({ isWholeLine: true });
    editor.setDecorations(type, [new fakeVscode.Range(0, 0, 0, 0)]);
    other.setDecorations(type, [new fakeVscode.Range(1, 0, 1, 0)]);
    expect(editor._getDecorations(type)).toHaveLength(1);

    type.dispose();
    type.dispose();
    expect(type.disposed).toBe(true);
    expect(editor._getDecorations(type)).toHaveLength(0);
    expect(other._getDecorations(type)).toHaveLength(0);
  });
});

describe('workspace 文档与保存事件', () => {
  it('showTextDocument 返回编辑器并设为 activeTextEditor', async () => {
    const editor = await openEditor();
    expect(fakeVscode.window.activeTextEditor).toBe(editor);
    expect(editor.document.lineCount).toBe(3);
    expect(editor.active).toBe(true);
  });

  it('onDidSaveTextDocument 在 document.save() 时收到文档，dispose 后不再触发', async () => {
    const editor = await openEditor();
    const received: Array<FakeEditor['document']> = [];
    const subscription = fakeVscode.workspace.onDidSaveTextDocument((document) => {
      received.push(document);
    });

    await editor.document.save();
    expect(received).toEqual([editor.document]);
    expect(state.saveDocEvents).toHaveLength(1);

    subscription.dispose();
    subscription.dispose();
    await editor.document.save();
    expect(received).toHaveLength(1);
    expect(state.saveDocEvents).toHaveLength(2);
  });

  it('保存事件 handler 抛错不会中断其他 handler（宿主捕获 listener 异常）', async () => {
    const document = await fakeVscode.workspace.openTextDocument('/tmp/mock-host-save-error.txt');
    const order: string[] = [];
    fakeVscode.workspace.onDidSaveTextDocument(() => {
      order.push('first');
      throw new Error('listener boom');
    });
    fakeVscode.workspace.onDidSaveTextDocument(() => {
      order.push('second');
    });

    await document.save();
    expect(order).toEqual(['first', 'second']);
    expect(state.listenerErrors).toHaveLength(1);
  });

  it('同一 URI 重复打开返回同一文档实例', async () => {
    const first = await fakeVscode.workspace.openTextDocument('/tmp/mock-host-same-doc.txt');
    const second = await fakeVscode.workspace.openTextDocument('/tmp/mock-host-same-doc.txt');
    expect(second).toBe(first);
  });
});

describe('Uri.from / 内容 provider / env（P5 远端只读内容依赖）', () => {
  it('Uri.from 组装自定义 scheme 的 path/query/fragment 与 toString', () => {
    const uri = fakeVscode.Uri.from({
      scheme: 'svn-anywhere-remote',
      path: '/uuid-1/7/key-1/a.txt',
      query: 'url=https%3A%2F%2Fh',
    });
    expect(uri.scheme).toBe('svn-anywhere-remote');
    expect(uri.path).toBe('/uuid-1/7/key-1/a.txt');
    expect(uri.query).toBe('url=https%3A%2F%2Fh');
    expect(uri.toString()).toBe('svn-anywhere-remote:/uuid-1/7/key-1/a.txt?url=https%3A%2F%2Fh');
    expect(fakeVscode.Uri.from({ scheme: 'file', path: '/tmp/a.txt' }).fsPath).toBe('/tmp/a.txt');
    expect(() => fakeVscode.Uri.from({ scheme: '' })).toThrow(/scheme/);
  });

  it('registerTextDocumentContentProvider 按 scheme 登记，dispose 撤下，非法参数抛错', () => {
    const provider = { provideTextDocumentContent: () => 'content' };
    const registration = fakeVscode.workspace.registerTextDocumentContentProvider(
      'svn-anywhere-remote',
      provider,
    );
    expect(state.contentProviders.get('svn-anywhere-remote')).toBe(provider);
    registration.dispose();
    registration.dispose();
    expect(state.contentProviders.has('svn-anywhere-remote')).toBe(false);
    expect(() => fakeVscode.workspace.registerTextDocumentContentProvider('', provider)).toThrow(/scheme/);
    expect(() => fakeVscode.workspace.registerTextDocumentContentProvider(
      'x',
      {} as { provideTextDocumentContent(uri: unknown): string },
    )).toThrow(/provideTextDocumentContent/);
  });

  it('env.clipboard 记录复制内容，env.openExternal 记录打开目标并返回成功', async () => {
    await fakeVscode.env.clipboard.writeText('https://example.com/repo');
    expect(state.clipboard).toEqual(['https://example.com/repo']);
    const opened = await fakeVscode.env.openExternal(fakeVscode.Uri.file('/tmp/mock-open.txt'));
    expect(opened).toBe(true);
    expect(state.openedExternal).toEqual(['file:///tmp/mock-open.txt']);
  });
});
