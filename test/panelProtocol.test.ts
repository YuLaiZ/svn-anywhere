/**
 * 面板消息协议的运行时校验测试：协议版本、消息结构、动作白名单、
 * 字段类型与「视图不能携带路径」的意图边界。
 */
import { describe, expect, it } from 'vitest';
import { parseViewMessage, PROTOCOL_VERSION, type IntentMessage } from '../src/host/panel/protocol';

const intentMessage = (patch: Record<string, unknown>): Record<string, unknown> => ({
  type: 'intent',
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 'session-a',
  requestId: 'req-1',
  intent: { kind: 'refresh' },
  ...patch,
});

describe('parseViewMessage', () => {
  it('接受合法 ready 消息', () => {
    const parsed = parseViewMessage({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    expect(parsed).toEqual({ ok: true, message: { type: 'ready', protocolVersion: PROTOCOL_VERSION } });
  });

  it('接受合法 intent 消息并保留字段', () => {
    const parsed = parseViewMessage(
      intentMessage({ intent: { kind: 'openDiff', itemId: 'src/ report.txt ' } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const message = parsed.message as IntentMessage;
      expect(message.intent).toEqual({ kind: 'openDiff', itemId: 'src/ report.txt ' });
      expect(message.sessionId).toBe('session-a');
    }
  });

  it('拒绝非对象与未知消息类型', () => {
    expect(parseViewMessage('render').ok).toBe(false);
    expect(parseViewMessage({ type: 'evil', protocolVersion: PROTOCOL_VERSION }).ok).toBe(false);
  });

  it('协议版本不兼容按错误处理，不静默降级', () => {
    const parsed = parseViewMessage(intentMessage({ protocolVersion: 99 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('协议版本不兼容');
      expect(parsed.reason).toContain('99');
    }
  });

  it('拒绝未知意图动作（白名单外）', () => {
    const parsed = parseViewMessage(intentMessage({ intent: { kind: 'runCommand', path: '/etc' } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('未知意图动作');
    }
  });

  it('拒绝字段类型错误（itemId 非字符串 / selected 非布尔 / inputRevision 非数字）', () => {
    expect(parseViewMessage(intentMessage({ intent: { kind: 'openDiff', itemId: 42 } })).ok).toBe(false);
    expect(
      parseViewMessage(intentMessage({ intent: { kind: 'toggleRow', rowId: 'a', selected: 'yes' } })).ok,
    ).toBe(false);
    expect(
      parseViewMessage(
        intentMessage({ intent: { kind: 'syncInput', fieldId: 'm', value: 'x', inputRevision: 'n' } }),
      ).ok,
    ).toBe(false);
  });

  it('拒绝缺失 sessionId / requestId 的意图', () => {
    expect(parseViewMessage(intentMessage({ sessionId: undefined })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ requestId: undefined })).ok).toBe(false);
  });

  it('意图载荷里不存在路径类字段（视图不能传任意路径执行）', () => {
    // 白名单动作的已知字段集合；若新增含路径字段会在类型层暴露，这里保护运行时边界。
    const parsed = parseViewMessage(
      intentMessage({ intent: { kind: 'openFile', itemId: 'x', path: '/tmp/evil' } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const intent = (parsed.message as IntentMessage).intent;
      expect(Object.keys(intent)).not.toContain('path');
    }
  });

  it('P2 意图：addRule/fillOriginName/saveIgnore/submitIgnore 无参放行，removeRule 校验 index', () => {
    for (const kind of ['addRule', 'fillOriginName', 'saveIgnore', 'submitIgnore']) {
      const parsed = parseViewMessage(intentMessage({ intent: { kind } }));
      expect(parsed.ok, kind).toBe(true);
    }
    const ok = parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: 2 } }));
    expect(ok.ok).toBe(true);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: -1 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: 1.5 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: '0' } })).ok).toBe(false);
  });
});
