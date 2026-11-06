/**
 * P4 磁盘治理面板状态机纯函数测试：对照交互状态清单 §四全部状态行逐行
 * 断言（ready、scanning、scanCanceled、scanError、partial、zero、
 * unsupported、busy、changed、cleaning、cleanupFailed、cleanupUnknown、
 * refreshError、cleaned；closed 是宿主视图态、由会话缓存投影承载），
 * 外加专项：
 * - 扫描代次守卫与 scanEpoch/cleanBeforeBytes 复测更新语义（数值无陈旧窗口）；
 * - refreshError 三形态（scanError/partial/unavailable 都不经 cleanSettled 结算）；
 * - 清理可用性矩阵各分支、writeLocked 按 kind 分列与「矩阵 ∧ 非占用」合取；
 * - 连续清理条件（cleaned 复测完整且剩余 cacheCount>0 才允许再次清理）；
 * - 字节格式化矩阵；
 * - 恢复字段全集投影（toDiskCache/fromDiskCache，scanCanceled 例外不存部分数值）；
 * - changedReason 两来源（快照比对不一致 / 重检读取失败）；
 * - 空间概览（metrics/spaceBar）与大文件表（TableSpec）的渲染契约。
 */
import { describe, expect, it } from 'vitest';
import { PRISTINE_UNSUPPORTED_REASON, type ScanDiskUsageResult } from '../src/core/diskUsage';
import type { PanelState } from '../src/host/panel/state';
import { render } from '../src/host/panel/view';
import {
  beginClean,
  bindRunningTask,
  buildDiskPanelState,
  buildVacuumAvailability,
  cleanFailed,
  cleanSettled,
  createDiskPanelState,
  createDiskTableFilters,
  DISK_TABLE_PAGE_SIZE,
  DISK_TABLE_SORT_DEFAULT,
  enterCleanupUnknown,
  excludedFromScan,
  formatBytes,
  fromDiskCache,
  pristineFromStats,
  refreshFailed,
  scanCanceled,
  scanCompleted,
  scanError,
  scanProgress,
  scanStarted,
  setChangedFromReadFailure,
  setChangedFromSnapshot,
  setOccupancy,
  toDiskCache,
  updateTableView,
  type BuildDiskPanelOptions,
  type DiskPanelState,
  type DiskPristineState,
} from '../src/host/panel/diskModel';

/* ------------------------------- 构造辅助 ------------------------------- */

function state(): DiskPanelState {
  return createDiskPanelState({ sessionId: 's1', wcRoot: '/wc', subPath: '/wc/sub' });
}

function scanResult(over?: Partial<ScanDiskUsageResult>): ScanDiskUsageResult {
  return {
    phase: 'complete',
    files: [
      { path: 'a.txt', kind: 'file', bytes: 100 },
      { path: 'd/b.md', kind: 'file', bytes: 4096 },
    ],
    totals: { business: 4196, svn: 8192, pristineBytes: 6144, total: 12388 },
    excluded: ['libs', 'ext-def（存在无法解析的 externals 定义，已保守排除）'],
    scanCount: 12,
    ...over,
  };
}

function pristineOk(over?: Partial<DiskPristineState>): DiskPristineState {
  return { state: 'ok', reason: null, cacheCount: 3, unreferencedBytes: 6144, missingCount: 0, ...over };
}

/** 完成一次成功扫描（epoch=1）后的 ready 态。 */
function readyState(): DiskPanelState {
  return scanCompleted(scanStarted(state()), 1, scanResult(), pristineOk());
}

function actionIds(page: PanelState): { primary?: string; secondary: string[] } {
  return {
    primary: page.footer?.primary?.id,
    secondary: (page.footer?.secondary ?? []).map((action) => action.id),
  };
}

/* ------------------------- 清单 §四：ready ------------------------- */

describe('清单 §四 ready：完整空间、大文件、缓存快照', () => {
  it('进入 ready：scanComplete、概览四字段与 files 回填、business 恒等于清单合计', () => {
    const next = readyState();
    expect(next.phase).toBe('ready');
    expect(next.scanComplete).toBe(true);
    expect(next.total).toBe(12388);
    expect(next.business).toBe(4196);
    expect(next.svn).toBe(8192);
    expect(next.pristineBytes).toBe(6144);
    expect(next.business).toBe(next.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(next.pristine.cacheCount).toBe(3);
  });

  it('动作集：分析（重新分析）/清理/范围说明/日志/关闭 + 表格只读与行内定位', () => {
    const page = buildDiskPanelState(readyState());
    expect(actionIds(page)).toEqual({
      primary: 'confirmVacuum',
      secondary: ['rescan', 'showScopeHelp', 'viewTaskLog', 'closePanel'],
    });
    expect(page.table).toBeDefined();
    expect(page.metrics).toBeDefined();
    expect(page.spaceBar).toBeDefined();
    const row = page.table?.rows[0];
    expect(row?.actions?.map((action) => action.id)).toEqual(['revealFileInOS']);
    expect(page.footer?.primary?.disabled).toBeFalsy();
  });

  it('partial 扫描结果转 partial 相位（complete→ready / partial→partial）', () => {
    const next = scanCompleted(
      scanStarted(state()),
      1,
      scanResult({ phase: 'partial', partialReason: '3 个路径读取失败（如 x：EACCES）' }),
      pristineOk(),
    );
    expect(next.phase).toBe('partial');
    expect(next.scanComplete).toBe(false);
    expect(next.errors).toEqual(['3 个路径读取失败（如 x：EACCES）']);
  });
});

/* ------------------------- 清单 §四：scanning ------------------------- */

describe('清单 §四 scanning：当前路径、已扫描项、总量未知', () => {
  it('只展示已读取条目与当前路径（无总量数值）、可取消', () => {
    let next = scanStarted(state());
    expect(next.phase).toBe('scanning');
    expect(next.scanEpoch).toBe(1);
    next = scanProgress(next, { count: 7, currentPath: '/wc/src' });
    expect(next.scanCount).toBe(7);
    expect(next.scanCurrentPath).toBe('/wc/src');
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ primary: 'cancelScan', secondary: ['viewTaskLog', 'closePanel'] });
    // 总量未知：概览数值不出现，只报已读取条目。
    expect(page.metrics).toEqual([{ caption: '已读取条目', value: '7' }]);
    expect(page.spaceBar).toBeUndefined();
    expect(page.table).toBeUndefined();
    expect(page.busy).toBe(true);
  });

  it('开始扫描清除 changedReason/cleanupError 与旧数值', () => {
    let next = setChangedFromSnapshot(readyState(), '目录 mtime 变化');
    next = { ...next, cleanupError: '旧失败原因' };
    next = scanStarted(next);
    expect(next.changedReason).toBeNull();
    expect(next.cleanupError).toBeNull();
    expect(next.phase).toBe('scanning');
    expect(next.total).toBeNull();
    expect(next.files).toEqual([]);
    expect(next.scanEpoch).toBe(2);
  });
});

/* --------------------- 清单 §四：canceled / scanCanceled --------------------- */

describe('清单 §四 scanCanceled：扫描已停止、未改动文件', () => {
  it('不展示任何已读数值（数值/清单/统计全清）、动作 = 重新分析 + 日志 + 关闭', () => {
    let next = scanStarted(state());
    next = scanProgress(next, { count: 9, currentPath: '/wc/x' });
    next = scanCanceled(next, 1);
    expect(next.phase).toBe('scanCanceled');
    expect(next.total).toBeNull();
    expect(next.scanCount).toBe(0);
    expect(next.files).toEqual([]);
    expect(next.pristine.cacheCount).toBeNull();
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ primary: 'rescan', secondary: ['viewTaskLog', 'closePanel'] });
    expect(page.metrics).toBeUndefined();
    expect(page.table).toBeUndefined();
  });

  it('部分结果不能清理：矩阵禁用', () => {
    const next = scanCanceled(scanStarted(state()), 1);
    expect(buildVacuumAvailability(next, { busy: false, writeLocked: false }).available).toBe(false);
  });
});

/* ------------------------- 清单 §四：scanError ------------------------- */

describe('清单 §四 scanError：读取失败及原因', () => {
  it('显示失败原因、不把失败伪装成零缓存（矩阵禁用而非 zero）', () => {
    const next = scanError(scanStarted(state()), 1, 'svn 进程启动失败');
    expect(next.phase).toBe('scanError');
    expect(next.errors).toEqual(['svn 进程启动失败']);
    expect(next.total).toBeNull();
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.available).toBe(false);
    expect(availability.cause).toBe('scanError');
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ primary: 'rescan', secondary: ['viewTaskLog', 'closePanel'] });
    expect(page.banners[0]?.detail).toBe('svn 进程启动失败');
  });
});

/* ------------------------- 清单 §四：partial ------------------------- */

describe('清单 §四 partial：部分目录不可读、数值标部分结果', () => {
  function partialState(): DiskPanelState {
    return scanCompleted(
      scanStarted(state()),
      1,
      scanResult({ phase: 'partial', partialReason: '2 个路径读取失败（如 y：EPERM）' }),
      pristineOk(),
    );
  }

  it('可浏览部分数据（表格/概览照常）并给部分结果标注', () => {
    const page = buildDiskPanelState(partialState());
    expect(page.table).toBeDefined();
    expect(page.metrics).toBeDefined();
    expect(page.table?.note).toBe('部分结果');
    expect(page.banners.some((banner) => banner.id === 'diskPartial')).toBe(true);
  });

  it('禁用清理并给原因（修复后重分析）', () => {
    const availability = buildVacuumAvailability(partialState(), { busy: false, writeLocked: false });
    expect(availability.available).toBe(false);
    expect(availability.cause).toBe('partial');
    expect(availability.reason).toContain('部分结果');
    const page = buildDiskPanelState(partialState());
    expect(actionIds(page).primary).toBe('rescan');
    const vacuum = page.footer?.secondary?.find((action) => action.id === 'confirmVacuum');
    expect(vacuum?.disabled).toBe(true);
  });
});

/* ------------------------- 清单 §四：zero（派生态） ------------------------- */

describe('清单 §四 zero：可回收 0 项 / 0 B（cacheCount=0 的派生态）', () => {
  it('禁用清理并给原因；只读操作与重分析照常', () => {
    const next = scanCompleted(scanStarted(state()), 1, scanResult(), pristineOk({ cacheCount: 0, unreferencedBytes: 0 }));
    expect(next.phase).toBe('ready');
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.available).toBe(false);
    expect(availability.cause).toBe('zero');
    const page = buildDiskPanelState(next);
    expect(page.footer?.primary?.id).toBe('confirmVacuum');
    expect(page.footer?.primary?.disabled).toBe(true);
    expect(page.footer?.primary?.disabledReason).toBe(availability.reason);
    expect(actionIds(page).secondary).toContain('rescan');
  });
});

/* --------------------- 清单 §四：unsupported（派生态） --------------------- */

describe('清单 §四 unsupported：缓存格式不受支持、空间分析可看', () => {
  it('缓存数值显示 —（不冒充 0）、禁用清理', () => {
    const pristine = pristineFromStats({ available: false, reason: PRISTINE_UNSUPPORTED_REASON });
    expect(pristine.state).toBe('unsupported');
    const next = scanCompleted(scanStarted(state()), 1, scanResult(), pristine);
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.cause).toBe('unsupported');
    expect(availability.reason).toContain('不支持缓存检测');
    const page = buildDiskPanelState(next);
    // 空间分析照常（四值与表格在），缓存数值为 —。
    expect(page.metrics).toBeDefined();
    expect(page.table).toBeDefined();
    const cacheCount = page.metrics?.find((metric) => metric.caption === '未引用缓存');
    expect(cacheCount?.value).toBe('—');
    expect(page.footer?.primary?.disabled).toBe(true);
  });

  it('unavailable（打开失败等）与 unsupported 分列、原因透传', () => {
    const pristine = pristineFromStats({ available: false, reason: 'wc.db 打开失败：locked' });
    expect(pristine.state).toBe('unavailable');
    expect(pristine.reason).toBe('wc.db 打开失败：locked');
    const next = scanCompleted(scanStarted(state()), 1, scanResult(), pristine);
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.cause).toBe('unavailable');
    expect(availability.reason).toContain('wc.db 打开失败');
  });

  it('available=true 映射 ok 并保留全字段', () => {
    const pristine = pristineFromStats({ available: true, totalCount: 10, cacheCount: 4, unreferencedBytes: 8192, missingCount: 1 });
    expect(pristine).toEqual({ state: 'ok', reason: null, cacheCount: 4, unreferencedBytes: 8192, missingCount: 1 });
  });

  it('missingCount>0 时概览单独计数', () => {
    const next = scanCompleted(scanStarted(state()), 1, scanResult(), pristineOk({ missingCount: 2 }));
    const page = buildDiskPanelState(next);
    expect(page.metrics?.some((metric) => metric.caption === '缓存文件缺失' && metric.value === '2 项')).toBe(true);
  });
});

/* ------------------------- 清单 §四：busy（派生态） ------------------------- */

describe('清单 §四 busy：同副本任务运行中（跨面板新鲜度）', () => {
  it('查看已有分析（表格只读意图放行）、禁用清理与重新分析', () => {
    const ready = readyState();
    // 另一面板发起占用后，下一次 intent 重算：宿主求值喂入（或渲染 opts 覆盖）。
    const updated = setOccupancy(ready, { busy: true, writeLocked: false });
    const availability = buildVacuumAvailability(updated, { busy: updated.busy, writeLocked: updated.writeLocked });
    expect(availability.cause).toBe('busy');
    const page = buildDiskPanelState(updated);
    expect(page.busy).toBe(true);
    expect(page.table).toBeDefined();
    expect(page.footer?.primary?.disabled).toBe(true);
    const rescan = page.footer?.secondary?.find((action) => action.id === 'rescan');
    expect(rescan?.disabled).toBe(true);
    // 模型不再持有放行表（gate 由 host.renderStateOf 从 createP4Gates
    // 单一来源注入；表格只读意图的放行断言见 panelGates.test.ts）。
    expect(page.gate).toBeUndefined();
  });

  it('渲染 opts 直接覆盖占用（不依赖 state 内旧值）与 state 内值同源', () => {
    const ready = readyState();
    expect(buildDiskPanelState(ready, { busy: true }).footer?.primary?.disabled).toBe(true);
    expect(buildDiskPanelState(ready).footer?.primary?.disabled).toBeFalsy();
  });

  it('busy 与 writeLocked 同时为真时先判 busy（放行表宿主判定顺序）', () => {
    const availability = buildVacuumAvailability(readyState(), { busy: true, writeLocked: true, heldKind: 'commit' });
    expect(availability.cause).toBe('busy');
  });
});

/* ------------------------- 清单 §四：changed ------------------------- */

describe('清单 §四 changed：确认后发现检测快照变化', () => {
  it('保留旧分析结果（数值与表格）、changedReason 可读、提供重新检测入口', () => {
    const next = setChangedFromSnapshot(readyState(), '目录 mtime 变化');
    expect(next.phase).toBe('changed');
    expect(next.changedReason).toBe('检测快照已变化（目录 mtime 变化）');
    expect(next.total).toBe(12388);
    expect(next.files.length).toBe(2);
    const page = buildDiskPanelState(next);
    expect(actionIds(page).primary).toBe('rescan');
    expect(page.footer?.primary?.label).toBe('重新检测');
    expect(page.metrics).toBeDefined();
    expect(page.table).toBeDefined();
    expect(page.banners.some((banner) => banner.id === 'diskChanged' && banner.detail === next.changedReason)).toBe(true);
  });

  it('重检读取失败来源：不冒充「检测到变化」', () => {
    const next = setChangedFromReadFailure(readyState(), 'wc.db 被占用');
    expect(next.phase).toBe('changed');
    expect(next.changedReason).toBe('无法读取磁盘状态（wc.db 被占用），请重新检测');
    expect(next.changedReason).not.toContain('检测快照已变化');
  });

  it('快照不一致无差异描述时给通用文案', () => {
    expect(setChangedFromSnapshot(readyState()).changedReason).toBe('检测快照已变化');
  });

  it('尚未执行清理、禁止沿用旧批准（矩阵禁用并给原因）', () => {
    const availability = buildVacuumAvailability(setChangedFromSnapshot(readyState()), { busy: false, writeLocked: false });
    expect(availability.cause).toBe('changed');
    expect(availability.reason).toContain('重新检测');
    const page = buildDiskPanelState(setChangedFromSnapshot(readyState()));
    const vacuum = page.footer?.secondary?.find((action) => action.id === 'confirmVacuum');
    expect(vacuum?.disabled).toBe(true);
  });
});

/* ------------------------- 清单 §四：cleaning ------------------------- */

describe('清单 §四 cleaning：正在清理、随后复测', () => {
  it('动作只有日志与关闭（禁止重复清理、重新分析和强制取消）', () => {
    const next = beginClean(readyState());
    expect(next.phase).toBe('cleaning');
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ secondary: ['viewTaskLog', 'closePanel'] });
    expect(page.busy).toBe(true);
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.cause).toBe('cleaning');
  });

  it('开始清理定格前值：cleanBeforeBytes=快照预计量、lastBeforeBytes=总占用，后值清空', () => {
    const next = beginClean(readyState());
    expect(next.clean).toEqual({
      cleanBeforeBytes: 6144,
      cleanAfterBytes: null,
      lastBeforeBytes: 12388,
      lastAfterBytes: null,
      releasedBytes: null,
    });
  });
});

/* --------------------- 清单 §四：cleanupFailed --------------------- */

describe('清单 §四 cleanupFailed：命令失败、可能部分完成', () => {
  it('恢复 cleanupError 失败原因、未核实收益显示 —、动作 = 重新检测 + 日志', () => {
    const next = cleanFailed(beginClean(readyState()), 'E155015: wc.db 被锁');
    expect(next.phase).toBe('cleanupFailed');
    expect(next.cleanupError).toBe('E155015: wc.db 被锁');
    expect(next.clean.releasedBytes).toBeNull();
    expect(next.clean.cleanAfterBytes).toBeNull();
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ primary: 'rescan', secondary: ['viewTaskLog', 'closePanel'] });
    expect(page.footer?.primary?.label).toBe('重新检测');
    expect(page.banners[0]?.detail).toBe('E155015: wc.db 被锁');
    // 禁直接重试。
    expect(buildVacuumAvailability(next, { busy: false, writeLocked: false }).cause).toBe('cleanupFailed');
  });
});

/* --------------------- 清单 §四：cleanupUnknown --------------------- */

describe('清单 §四 cleanupUnknown：宿主中断、结果未知', () => {
  it('呈现「先重新检测」页、不经会话缓存承载', () => {
    const next = enterCleanupUnknown(state());
    expect(next.phase).toBe('cleanupUnknown');
    expect(next.recovered).toBe('record');
    expect(toDiskCache(next)).toBeNull();
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ primary: 'rescan', secondary: ['viewTaskLog', 'closePanel'] });
    expect(page.banners[0]?.title).toContain('清理结果未知');
    expect(buildVacuumAvailability(next, { busy: false, writeLocked: false }).cause).toBe('cleanupUnknown');
  });
});

/* --------------------- 清单 §四：refreshError --------------------- */

describe('清单 §四 refreshError：命令已成功、复测失败', () => {
  it('差值显示 —（不拿预计值冒充）、禁再次清理、须重新检测', () => {
    const next = refreshFailed(beginClean(readyState()));
    expect(next.phase).toBe('refreshError');
    expect(next.clean.releasedBytes).toBeNull();
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.cause).toBe('refreshError');
    expect(availability.reason).toContain('重新检测');
    const page = buildDiskPanelState(next);
    expect(actionIds(page)).toEqual({ primary: 'rescan', secondary: ['viewTaskLog', 'closePanel'] });
  });

  it('复测失败三形态都不经 cleanSettled 结算（模型层不可绕过）', () => {
    const cleaning = beginClean(readyState());
    const scanErrorForm = cleanSettled(cleaning, { scan: scanResult(), pristine: pristineOk() });
    // 三形态之一：复测扫描失败（控制器显式调 refreshFailed；误传完整结果才结算）。
    expect(refreshFailed(scanErrorForm).phase).toBe('refreshError');
    // 三形态之二：复测 partial。
    const partialSettle = cleanSettled(cleaning, {
      scan: scanResult({ phase: 'partial', partialReason: 'y：EPERM' }),
      pristine: pristineOk(),
    });
    expect(partialSettle.phase).toBe('cleaning');
    // 三形态之三：pristine 复读落 unavailable。
    const unavailableSettle = cleanSettled(cleaning, {
      scan: scanResult(),
      pristine: { state: 'unavailable', reason: 'wc.db 被占用', cacheCount: null, unreferencedBytes: null },
    });
    expect(unavailableSettle.phase).toBe('cleaning');
    // 三形态正确出口：由 cleaning 直转 refreshError。
    expect(refreshFailed(cleaning).phase).toBe('refreshError');
  });
});

/* ------------------------- 清单 §四：cleaned ------------------------- */

describe('清单 §四 cleaned：清理前/后/差值、剩余缓存', () => {
  function cleanedState(): DiskPanelState {
    return cleanSettled(beginClean(readyState()), {
      scan: scanResult({
        totals: { business: 4196, svn: 2048, pristineBytes: 1024, total: 6244 },
      }),
      pristine: pristineOk({ cacheCount: 1, unreferencedBytes: 1024 }),
    });
  }

  it('前后差值与剩余缓存全部来自复测实测（数值无陈旧窗口）', () => {
    const next = cleanedState();
    expect(next.phase).toBe('cleaned');
    expect(next.total).toBe(6244);
    expect(next.clean.lastAfterBytes).toBe(6244);
    expect(next.clean.releasedBytes).toBe(12388 - 6244);
    expect(next.clean.cleanAfterBytes).toBe(1024);
  });

  it('cleanBeforeBytes 与 scanEpoch 更新为复测剩余值/新代次（第二次确认按复测值预计）', () => {
    const next = cleanedState();
    expect(next.clean.cleanBeforeBytes).toBe(1024);
    expect(next.scanEpoch).toBe(2);
  });

  it('对比卡用同一 metrics 组件（前/后/实际释放/剩余可清理）', () => {
    const page = buildDiskPanelState(cleanedState());
    const captions = page.metrics?.map((metric) => metric.caption);
    for (const caption of ['清理前占用', '清理后占用', '实际释放', '剩余可清理']) {
      expect(captions).toContain(caption);
    }
    const released = page.metrics?.find((metric) => metric.caption === '实际释放');
    expect(released?.value).toBe(formatBytes(12388 - 6244));
  });

  it('动作集：查看结果（本页）/重分析/日志/关闭；连续清理按复测代次直接再次清理', () => {
    const next = cleanedState();
    expect(actionIds(buildDiskPanelState(next))).toEqual({
      primary: 'confirmVacuum',
      secondary: ['rescan', 'showScopeHelp', 'viewTaskLog', 'closePanel'],
    });
    // 复测完整且剩余 cacheCount>0：允许按复测代次直接再次清理。
    expect(buildVacuumAvailability(next, { busy: false, writeLocked: false }).available).toBe(true);
  });

  it('复测剩余为 0 时同样禁用（zero 语义、连续清理不虚报收益）', () => {
    const next = cleanSettled(beginClean(readyState()), {
      scan: scanResult({ totals: { business: 4196, svn: 2048, pristineBytes: 0, total: 6244 } }),
      pristine: pristineOk({ cacheCount: 0, unreferencedBytes: 0 }),
    });
    expect(next.phase).toBe('cleaned');
    const availability = buildVacuumAvailability(next, { busy: false, writeLocked: false });
    expect(availability.available).toBe(false);
    expect(availability.cause).toBe('zero');
  });
});

/* ------------------------- 代次守卫与迟到回包 ------------------------- */

describe('扫描代次守卫：迟到回包丢弃', () => {
  it('代次不一致的完成/取消/失败回包原样丢弃', () => {
    const scanning = scanStarted(state());
    expect(scanCompleted(scanning, 2, scanResult(), pristineOk())).toBe(scanning);
    expect(scanCanceled(scanning, 2)).toBe(scanning);
    expect(scanError(scanning, 2, 'x')).toBe(scanning);
  });

  it('非 scanning 相位不接收扫描结算', () => {
    const ready = readyState();
    expect(scanCompleted(ready, 1, scanResult(), pristineOk())).toBe(ready);
    expect(scanCanceled(ready, 1)).toBe(ready);
  });

  it('cleanSettled 仅 cleaning 相位生效', () => {
    const ready = readyState();
    expect(cleanSettled(ready, { scan: scanResult(), pristine: pristineOk() })).toBe(ready);
  });

  it('scanProgress 仅 scanning 相位生效', () => {
    const ready = readyState();
    expect(scanProgress(ready, { count: 5, currentPath: 'x' })).toBe(ready);
  });
});

/* --------------------- 清理可用性矩阵专项 --------------------- */

describe('清理可用性矩阵：各分支与「矩阵 ∧ 非占用」合取', () => {
  const free = { busy: false, writeLocked: false };

  it('业务条件齐备才可用；矩阵 ok 但 busy/writeLocked 任一占用即禁（同一合取）', () => {
    expect(buildVacuumAvailability(readyState(), free).available).toBe(true);
    expect(buildVacuumAvailability(readyState(), { busy: true, writeLocked: false }).available).toBe(false);
    expect(buildVacuumAvailability(readyState(), { busy: false, writeLocked: true, heldKind: 'commit' }).available).toBe(false);
  });

  it('writeLocked 命中原因按 kind 分列（不得把 ignore 记录指到提交面板）', () => {
    const ready = readyState();
    const cases: Array<[Parameters<typeof buildVacuumAvailability>[1]['heldKind'], string]> = [
      ['commit', '提交面板'],
      [undefined, '提交面板'],
      ['ignore', '忽略面板'],
      ['vacuum', '重新检测'],
      ['checkout', '等待完成'],
      ['import', '导入面板'],
    ];
    for (const [kind, keyword] of cases) {
      const availability = buildVacuumAvailability(ready, { busy: false, writeLocked: true, heldKind: kind });
      expect(availability.cause).toBe('writeLocked');
      expect(availability.reason).toContain(keyword);
    }
  });

  it('idle/scanning 等未完成相位的禁用原因分列', () => {
    expect(buildVacuumAvailability(state(), free).cause).toBe('idle');
    expect(buildVacuumAvailability(scanStarted(state()), free).cause).toBe('scanning');
  });

  it('pristine 数值未就绪的防御分支（undetected）', () => {
    const ready = { ...readyState(), pristine: pristineOk({ cacheCount: null, unreferencedBytes: null }) };
    expect(buildVacuumAvailability(ready, free).cause).toBe('undetected');
  });
});

/* ------------------------- 字节格式化矩阵 ------------------------- */

describe('formatBytes：MiB/GiB 格式化矩阵', () => {
  it('边界与单位进位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GiB');
    expect(formatBytes(200 * 1024 * 1024 * 1024)).toBe('200 GiB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TiB');
    expect(formatBytes(1024 ** 5)).toBe('1024 TiB');
  });

  it('null/负数/非有限值显示 —（不冒充 0）', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

/* --------------------- 会话结果缓存投影专项 --------------------- */

describe('toDiskCache/fromDiskCache：恢复字段全集投影', () => {
  it('运行态/idle/cleanupUnknown 不产出缓存项', () => {
    expect(toDiskCache(state())).toBeNull();
    expect(toDiskCache(scanStarted(state()))).toBeNull();
    expect(toDiskCache(beginClean(readyState()))).toBeNull();
    expect(toDiskCache(enterCleanupUnknown(state()))).toBeNull();
  });

  it('cleaned 态全字段往返（含空间概览四字段、scanCount、pristine 全字段、clean 五字段、scanEpoch/scanComplete）', () => {
    const cleaned = cleanSettled(beginClean(readyState()), {
      scan: scanResult({ totals: { business: 4196, svn: 2048, pristineBytes: 1024, total: 6244 } }),
      pristine: pristineOk({ cacheCount: 1, unreferencedBytes: 1024, missingCount: 1 }),
    });
    const cache = toDiskCache(cleaned);
    expect(cache).not.toBeNull();
    expect(cache?.phase).toBe('cleaned');
    expect(cache?.scanEpoch).toBe(2);
    expect(cache?.scanComplete).toBe(true);
    expect(cache?.total).toBe(6244);
    expect(cache?.business).toBe(4196);
    expect(cache?.svn).toBe(2048);
    expect(cache?.pristineBytes).toBe(1024);
    expect(cache?.scanCount).toBe(12);
    expect(cache?.pristine).toEqual(cleaned.pristine);
    expect(cache?.clean).toEqual(cleaned.clean);
    expect(cache?.files).toEqual(cleaned.files);
    expect(cache?.excluded).toEqual(cleaned.excluded);
    // 恢复：重开后矩阵判定输入随缓存恢复（cleaned 页清理按钮不被误禁）。
    const restored = fromDiskCache(state(), cache!, '/wc/other-sub');
    expect(restored.phase).toBe('cleaned');
    expect(restored.scanEpoch).toBe(2);
    expect(restored.pristine).toEqual(cleaned.pristine);
    expect(restored.clean).toEqual(cleaned.clean);
    expect(restored.total).toBe(6244);
    expect(restored.files).toEqual(cleaned.files);
    expect(restored.recovered).toBe('cache');
    expect(buildVacuumAvailability(restored, { busy: false, writeLocked: false }).available).toBe(true);
  });

  it('subPath 刷新为本次打开路径、tableView 不随缓存恢复（重置默认）', () => {
    const cache = toDiskCache(readyState());
    const base = {
      ...state(),
      subPath: '/wc/other',
      tableView: { sortKey: 'path' as const, sortDesc: false, filter: 'x', type: '.txt', page: 3 },
    };
    const restored = fromDiskCache(base, cache!, '/wc/other');
    expect(restored.subPath).toBe('/wc/other');
    expect(restored.tableView).toEqual({ sortKey: 'size', sortDesc: true, filter: '', type: 'all', page: 1 });
    expect(restored.scanCurrentPath).toBeNull();
    expect(restored.busy).toBe(false);
  });

  it('scanCanceled 例外：缓存只存状态与页面文本、不存被取消扫描的部分数值', () => {
    let next = scanStarted(state());
    next = scanProgress(next, { count: 42, currentPath: '/wc/deep' });
    next = scanCanceled(next, 1);
    const cache = toDiskCache(next);
    expect(cache?.phase).toBe('scanCanceled');
    expect(cache?.total).toBeNull();
    expect(cache?.files).toEqual([]);
    expect(cache?.scanCount).toBe(0);
    expect(cache?.scanComplete).toBe(false);
    expect(cache?.pristine.cacheCount).toBeNull();
    // 防御：取消前已有部分数值的态被取消后投影同样无数值。
    const restored = fromDiskCache(state(), cache!, '/wc');
    expect(restored.total).toBeNull();
    expect(restored.files).toEqual([]);
  });

  it('changed 恢复 changedReason、cleanupFailed 恢复 cleanupError（验收 29 断言载体）', () => {
    const changed = setChangedFromReadFailure(readyState(), '目录不可读');
    const restoredChanged = fromDiskCache(state(), toDiskCache(changed)!, '/wc');
    expect(restoredChanged.phase).toBe('changed');
    expect(restoredChanged.changedReason).toBe('无法读取磁盘状态（目录不可读），请重新检测');
    const failed = cleanFailed(beginClean(readyState()), 'E155015');
    const restoredFailed = fromDiskCache(state(), toDiskCache(failed)!, '/wc');
    expect(restoredFailed.phase).toBe('cleanupFailed');
    expect(restoredFailed.cleanupError).toBe('E155015');
  });

  it('scanError 恢复失败原因', () => {
    const failed = scanError(scanStarted(state()), 1, '读取失败原因原文');
    const restored = fromDiskCache(state(), toDiskCache(failed)!, '/wc');
    expect(restored.errors).toEqual(['读取失败原因原文']);
  });
});

/* ------------------------- 绑定与页头基准 ------------------------- */

describe('运行中任务绑定与占用重算', () => {
  it('绑定扫描任务：页头 wcRoot/subPath 取任务固定参数（不显示本次打开的另一子目录）', () => {
    const bound = bindRunningTask(state(), { kind: 'scan', wcRoot: '/a', subPath: '/a/x' });
    expect(bound.phase).toBe('scanning');
    expect(bound.binding).toEqual({ resultScope: { wcRoot: '/a' }, subPath: '/a/x' });
    expect(bound.recovered).toBe('task');
    const page = buildDiskPanelState(bound);
    expect(page.targetLabel).toContain('/a/x');
    expect(page.targetLabel).toContain('/a');
  });

  it('绑定清理任务：相位 cleaning、页头按任务呈现', () => {
    const bound = bindRunningTask(state(), { kind: 'clean', wcRoot: '/b', subPath: '/b' });
    expect(bound.phase).toBe('cleaning');
    expect(buildDiskPanelState(bound).targetLabel).toContain('/b');
  });

  it('setOccupancy 更新占用两维度并清 heldKind（未锁定时）', () => {
    const locked = setOccupancy(state(), { busy: false, writeLocked: true, heldKind: 'vacuum' });
    expect(locked.writeLocked).toBe(true);
    expect(locked.heldKind).toBe('vacuum');
    const unlocked = setOccupancy(locked, { busy: false, writeLocked: false, heldKind: 'vacuum' });
    expect(unlocked.writeLocked).toBe(false);
    expect(unlocked.heldKind).toBeNull();
  });

  it('updateTableView 只回写镜像（不参与判定）', () => {
    const next = updateTableView(readyState(), { sortKey: 'path', sortDesc: false, filter: 'a', type: 'all', page: 2 });
    expect(next.tableView).toEqual({ sortKey: 'path', sortDesc: false, filter: 'a', type: 'all', page: 2 });
    expect(next.phase).toBe('ready');
  });
});

/* ------------------------- 渲染契约专项 ------------------------- */

describe('渲染契约：空间概览与占比条（metrics/spaceBar）', () => {
  it('空间概览四值格式化后进 MetricSpec、占比条三段按 bytes 比例', () => {
    const page = buildDiskPanelState(readyState());
    const values = Object.fromEntries((page.metrics ?? []).map((metric) => [metric.caption, metric.value]));
    expect(values['总占用']).toBe(formatBytes(12388));
    expect(values['业务文件']).toBe(formatBytes(4196));
    expect(values['SVN 元数据']).toBe(formatBytes(8192));
    expect(values['其中 pristine 缓存']).toBe(formatBytes(6144));
    expect(page.spaceBar).toEqual({
      segments: [
        { key: 'business', label: '业务文件', bytes: 4196 },
        { key: 'svnOther', label: 'SVN 其他', bytes: 8192 - 6144 },
        { key: 'pristine', label: 'pristine 缓存', bytes: 6144 },
      ],
      totalBytes: 12388,
    });
  });

  it('数值缺失的结果态不产出占比条', () => {
    const missing = { ...readyState(), total: null };
    expect(buildDiskPanelState(missing).spaceBar).toBeUndefined();
  });

  it('view 渲染：数值卡与占比条 HTML、窄段隐藏段内文字只保留 title', () => {
    const page = buildDiskPanelState(readyState());
    const html = render(page);
    expect(html).toContain('class="metrics"');
    expect(html).toContain('class="metric-caption"');
    expect(html).toContain('class="space-bar"');
    // 6144/12388≈49.6% >= 12% 展示段内文字；SVN 其他 2048/12388≈16.5% 展示；
    // 构造一个窄段形态：pristine 占比 < 12% 时只保留 title。
    const narrow = {
      ...readyState(),
      total: 100000,
      business: 99000,
      svn: 1000,
      pristineBytes: 60,
    };
    const narrowHtml = render(buildDiskPanelState(narrow));
    const seg = narrowHtml.match(/<span class="space-seg seg-2"[^>]*>(.*?)<\/span>/);
    expect(seg).not.toBeNull();
    expect(seg?.[1]).toBe('');
    expect(seg?.[0]).toContain('title="pristine 缓存 0%"');
  });
});

describe('渲染契约：大文件表（TableSpec）', () => {
  function tableOf(view?: BuildDiskPanelOptions['tableView']) {
    return buildDiskPanelState(readyState(), { tableView: view })?.table;
  }

  it('列契约：size 列 sortType=number 按字节排序（默认大小降序）、cellKey 绑定列筛选', () => {
    const table = tableOf();
    expect(table?.columns.map((column) => column.key)).toEqual(['path', 'size', 'ext']);
    const sizeColumn = table?.columns.find((column) => column.key === 'size');
    expect(sizeColumn?.sortType).toBe('number');
    expect(sizeColumn?.align).toBe('right');
    expect(table?.sort).toEqual(DISK_TABLE_SORT_DEFAULT);
    expect(table?.filters?.map((filter) => filter.id)).toEqual(['path', 'ext']);
    expect(table?.filters?.[0].cellKey).toBe('path');
    expect(table?.filters?.[1].cellKey).toBe('ext');
  });

  it('行内动作 revealFileInOS、行 ID 绑定路径', () => {
    const table = tableOf();
    const row = table?.rows.find((candidate) => candidate.id === 'file:d/b.md');
    expect(row).toBeDefined();
    expect(row?.actions?.[0].id).toBe('revealFileInOS');
  });

  it('分页：pageSize=50、消息只发当前页（60 行 → 2 页、第 2 页 10 行）', () => {
    const files = Array.from({ length: 60 }, (_, index) => ({
      path: `f${index}.txt`,
      kind: 'file' as const,
      bytes: index,
    }));
    const many = { ...readyState(), files };
    const page1 = buildDiskPanelState(many).table;
    expect(page1?.pagination).toEqual({ page: 1, pageSize: DISK_TABLE_PAGE_SIZE, total: 60, pageCount: 2 });
    expect(page1?.rows.length).toBe(50);
    const page2 = buildDiskPanelState(many, { tableView: { page: 2 } }).table;
    expect(page2?.pagination.page).toBe(2);
    expect(page2?.rows.length).toBe(10);
  });

  it('类型筛选 options 由清单派生（含无后缀选项）、路径筛选为文本子串匹配', () => {
    const files = [
      { path: 'a.txt', kind: 'file' as const, bytes: 1 },
      { path: 'noext', kind: 'file' as const, bytes: 2 },
      { path: 'b.md', kind: 'file' as const, bytes: 3 },
    ];
    const withFiles = { ...readyState(), files };
    const filters = buildDiskPanelState(withFiles).table?.filters;
    const extFilter = filters?.find((filter) => filter.id === 'ext');
    expect(extFilter?.kind).toBe('select');
    expect(extFilter?.options?.map((option) => option.value)).toEqual(['all', '.md', '.txt', '']);
    expect(extFilter?.options?.find((option) => option.value === '')?.label).toBe('无后缀');
    const pathFilter = filters?.find((filter) => filter.id === 'path');
    expect(pathFilter?.kind).toBe('text');
  });

  it('createDiskTableFilters 骨架默认无筛选', () => {
    expect(createDiskTableFilters()).toEqual([
      { id: 'path', kind: 'text', cellKey: 'path', value: '' },
      { id: 'ext', kind: 'select', cellKey: 'ext', value: 'all', options: [{ value: 'all', label: '全部' }] },
    ]);
  });
});

/* ------------------------- 放行表与 excluded ------------------------- */

describe('P4 放行表（gate）与排除清单映射', () => {
  // 放行表逐行断言（busy 不含 rescan/startScan/confirmVacuum、
  // writeLocked 放行重新检测）由 test/panelGates.test.ts 的
  // createP4Gates 用例承载——模型内不再持第二份表（DISK_PANEL_GATE
  // 已删除，gate 由 host.renderStateOf 注入）。

  it('excludedFromScan：带「（标注）」的条目拆出可读理由、其余给默认理由', () => {
    const entries = excludedFromScan([
      'libs',
      'ext-def（存在无法解析的 externals 定义，已保守排除）',
    ]);
    expect(entries[0]).toEqual({ path: 'libs', reason: '已排除子树' });
    expect(entries[1]).toEqual({ path: 'ext-def', reason: '存在无法解析的 externals 定义，已保守排除' });
  });

  it('扫描完成后 excluded 清单进模型（范围说明数据源）', () => {
    expect(readyState().excluded).toEqual([
      { path: 'libs', reason: '已排除子树' },
      { path: 'ext-def', reason: '存在无法解析的 externals 定义，已保守排除' },
    ]);
  });
});
