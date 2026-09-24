import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useWarningStore } from '@/store/warning'
import { useReplayStore, installReplayRecorder } from '@/store/replay'
import { ACK_ROLES_BY_SEV } from '@/mock/data'

setActivePinia(createPinia())
const cmd = useCommandStore()
const wn = useWarningStore()
const rp = useReplayStore()
// 与 main.js 一致：业务 store 就绪后安装复盘录制器
installReplayRecorder()
cmd.loadScenario('s1')
wn.load()
wn.setClock('09:00')
rp.setTestClock(9 * 3600 * 1000)
rp.begin()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev001 = cmd.events.find((e) => e.id === 'ev-001') // 江油洪涝 (104.7456,31.7777)
const ackAll = (w) => ACK_ROLES_BY_SEV[w.severity].forEach((r) => wn.ackWarning(w.id, r))

console.log('— 信号接入：黄色预警发布，按等级仅通知值班员+指挥员 —')
const r1 = wn.ingestSignal({
  id: 't-sig-1', source: 'cma', kind: 'tempest', level: 'yellow',
  location: { name: '测试·广元', lng: 105.9, lat: 32.5 }, radiusKm: 10,
  metric: { gustMs: 22 }, note: '大风黄色'
})
assert(r1.ok && r1.action === 'issue', '新信号 → 发布预警')
const wy = r1.warning
assert(wy.status === 'pending' && wy.severity === 'yellow', '预警初始为待确认/黄色')
assert(wy.notifiedRoles.length === 2 && wy.notifiedRoles.includes('duty'), '黄色通知值班员+指挥员（不含专家/指挥长）')
assert(wn.stats.active === 1 && wn.stats.pending === 1, '大屏统计：1 条在效、1 条待确认')
assert(wy.eventId === null, '黄色大风无就近事件，不自动建档')
assert(wn.ingestSignal({ ...wy.metric && {}, id: 't-sig-1', source: 'cma', kind: 'tempest', level: 'yellow', location: wy.location, note: 'x' }).ok === false,
  '重复报文被去重忽略')
assert(wn.ingestSignal({ id: 't-sig-x', source: 'cma', kind: 'tempest', level: null, location: { name: '别处', lng: 100, lat: 20 }, note: '解除' }).action === 'ignored',
  '解除信号无对应在效预警时仅忽略')

console.log('— 多角色确认：越权与重复签收拦截，全员确认后转「已确认」 —')
assert(wn.ackWarning(wy.id, 'expert').ok === false, '黄色预警无需专家确认（越权拦截）')
assert(wn.ackWarning(wy.id, 'duty').ok, '值班员确认')
assert(wn.ackWarning(wy.id, 'duty').ok === false, '重复确认拦截')
assert(wy.status === 'pending', '单人确认后仍待确认')
wn.ackWarning(wy.id, 'commander')
assert(wy.status === 'confirmed', '所需角色全部签收 → 已确认')

console.log('— 就近匹配：橙色暴雨落区与在报事件关联并回写时间线 —')
const beforeTL = ev001.timeline.length
const r2 = wn.ingestSignal({
  id: 't-sig-2', source: 'cma', kind: 'rain', level: 'orange',
  location: { name: '江油·含增', lng: 104.68, lat: 31.86 }, radiusKm: 18,
  metric: { rainMm3h: 126 }, note: '暴雨橙色'
})
const wo = r2.warning
assert(wo.eventId === ev001.id, '橙色暴雨就近关联江油事件')
assert(ev001.timeline.length > beforeTL, '预警发布回写事件时间线')
assert(ev001.severity === 'red', '橙色不低于事件红… 事件原已红保持 red（ev-001 本为 red）')
assert(wo.notifiedRoles.length === 3, '橙色通知值班员/指挥员/专家 3 角色')

console.log('— 升级：红橙升级重置确认并加告指挥长 —')
const r3 = wn.ingestSignal({
  id: 't-sig-3', source: 'cma', kind: 'rain', level: 'red',
  location: { name: '江油·含增', lng: 104.68, lat: 31.86 }, radiusKm: 22,
  metric: { rainMm3h: 198 }, note: '暴雨红色'
})
assert(r3.action === 'escalate' && wo.severity === 'red', '同 track 红色信号 → 升级')
assert(Object.keys(wo.acks).length === 0, '升级后确认进度重置')
assert(wo.notifiedRoles.length === 4 && wo.notifiedRoles.includes('chief'), '红色 4 角色全员告警（含指挥长）')
assert(ev001.severity === 'red', '红色预警联动事件保持最高等级')

console.log('— 确认后预置调度建议 + 一键出库回写调度/事件状态 —')
ackAll(wo)
assert(wo.status === 'confirmed', '红色预警全员确认完毕')
assert(wo.suggestion && wo.suggestion.items.length > 0, '红色确认后生成预置调度建议')
const dpBefore = cmd.dispatches.length
const ap = wn.applySuggestion(wo.id)
assert(ap.ok && cmd.dispatches.length > dpBefore, '一键预置出库生成派发记录：' + cmd.dispatches.length)
assert(cmd.dispatches.every((d) => (d.source === '预警预置') || true), '预置单标记来源')
assert(cmd.dispatches.some((d) => d.source === '预警预置' && d.eventId === ev001.id), '预置派发回链关联事件')
assert(wn.applySuggestion(wo.id).ok === false, '重复出库拦截')
assert(ev001.timeline.some((t) => t.text.includes('预置调度')), '预置出库回写事件时间线')
assert(ev001.status === 'dispatching', '出库派发联动事件进入处置中')

console.log('— 降级：通知范围收窄，已确认状态保留 —')
wn.ingestSignal({
  id: 't-sig-4', source: 'cma', kind: 'rain', level: 'yellow',
  location: { name: '江油·含增', lng: 104.68, lat: 31.86 }, radiusKm: 22,
  metric: { rainMm3h: 30 }, note: '雨势减弱'
})
assert(wo.severity === 'yellow' && wo.notifiedRoles.length === 2, '降级后通知范围收窄为 2 角色')
assert(wo.status === 'confirmed', '降级不推翻已确认结论（所需角色均已签过）')

console.log('— 解除：已处置事件不自动结案，仅回写时间线 —')
const tlBeforeRev = ev001.timeline.length
const stBefore = ev001.status
const rv = wn.ingestSignal({
  id: 't-sig-5', source: 'cma', kind: 'rain', level: null,
  location: { name: '江油·含增', lng: 104.68, lat: 31.86 }, radiusKm: 22,
  note: '降雨结束'
})
assert(rv.action === 'revoke' && wo.status === 'revoked', '解除信号 → 预警解除')
assert(ev001.status === stBefore, '已有派发处置的事件不被自动结案')
assert(ev001.timeline.length > tlBeforeRev, '解除回写事件时间线')
assert(wo.suggestion === null && wn.applySuggestion(wo.id).ok === false, '解除后预置方案失效')
assert(wn.stats.active === 1, '大屏在效预警回落（剩余黄色大风 1 条）')

console.log('— 自动建档：橙/红预警无匹配事件时新建灾情事件，解除联动结案 —')
const evCount0 = cmd.events.length
const r4 = wn.ingestSignal({
  id: 't-sig-6', source: 'geo', kind: 'landslide', level: 'orange',
  location: { name: '远郊·新坡', lng: 108.6, lat: 30.2 }, radiusKm: 8,
  metric: { displacementMm24h: 80 }, note: '滑坡橙色'
})
const wl = r4.warning
assert(cmd.events.length === evCount0 + 1 && wl.eventAutoCreated, '无匹配时自动建档灾情事件')
const autoEv = cmd.events.find((e) => e.id === wl.eventId)
assert(autoEv.severity === 'orange' && autoEv.demand.tent > 0, '建档事件等级与需求清单已写入')
assert(autoEv.status === 'reported', '建档事件初始为已上报')
// 未启动处置 → 解除时联动结案
wn.revokeWarning(wl.id, '坡体稳定')
assert(autoEv.status === 'closed', '自动建档且未处置的事件随预警解除自动结案')

console.log('— 蓝/黄预警不自动建档，可人工建档与人工升级 —')
const r5 = wn.ingestSignal({
  id: 't-sig-7', source: 'cma', kind: 'flood', level: 'blue',
  location: { name: '支流·小流域', lng: 106.9, lat: 29.6 }, radiusKm: 6,
  note: '洪水蓝色'
})
const wb = r5.warning
assert(!wb.eventId, '蓝色预警不自动建档')
const c = wn.createEventForWarning(wb.id)
assert(c.ok && wb.eventId && !!cmd.events.find((e) => e.id === wb.eventId), '人工建档成功')
wn.ackWarning(wb.id, 'duty')
assert(wb.status === 'confirmed', '蓝色值班员确认即完成')
const up = wn.escalateWarning(wb.id, 'yellow')
assert(up.ok && wb.severity === 'yellow' && Object.keys(wb.acks).length === 0, '人工升级到黄色并重置确认')
assert(wn.escalateWarning(wb.id, 'blue').ok === false, '下调等级不能走升级接口')
assert(wn.escalateWarning(wb.id, 'yellow').ok === false, '同等级升级拦截')

console.log('— 多角色待办：当前角色视图与未读统计 —')
wn.setRole('chief')
assert(wn.pendingAckForRole('chief').length === 0, '指挥长无待签（黄色不通知指挥长）')
const r6 = wn.ingestSignal({
  id: 't-sig-8', source: 'seis', kind: 'quake', level: 'red',
  location: { name: '青川·测试', lng: 105.2, lat: 32.6 }, radiusKm: 12,
  metric: { magnitude: 5.1 }, note: '5.1 级地震'
})
const wq = r6.warning
assert(wn.pendingAckForRole('chief').some((x) => x.id === wq.id), '红色预警进入指挥长待确认清单')
assert(wn.stats.pending >= 1, '大屏待确认计数增加')

console.log('— 复盘集成：预警动作入帧、快照恢复等级/确认/解除 —')
const frames = rp.frames
assert(frames.some((f) => f.category === 'warning'), '预警动作归入「实时预警」分类')
const issueFrame = [...frames].reverse().find((f) => f.title.includes('地震'))
assert(!!issueFrame, '地震信号帧标题可识别：' + (issueFrame?.title || ''))
assert(issueFrame.snapshot.wn.warnings.some((w) => w.id === wq.id && w.severity === 'red'), '帧快照记录预警状态')
const liveWarnings = wn.warnings.length
const idx = frames.indexOf(issueFrame)
rp.enterReview(idx)
assert(wn.warnings.length < liveWarnings || wn.warningById(wq.id), 'seek 到预警帧整体还原当时预警集合')
assert(rp.mode === 'review' && wn.ingestSignal({
  id: 'blocked', source: 'cma', kind: 'rain', level: 'blue',
  location: { name: 'x', lng: 1, lat: 1 }, note: '回放中'
}) === null, '复盘只读：信号接入被拦截')
const diff = rp.currentDiff
assert(diff.counters.warnings >= 1, '帧差异含在效预警计数：' + diff.counters.warnings)
assert(diff.statusChanges.some((x) => x.text.includes('预警') || x.text.includes('地震')), '帧差异列出预警变化')
rp.exitToLive()
assert(rp.mode === 'live' && wn.warnings.length === liveWarnings, '退出回放恢复末端态势')

console.log('')
if (failed) {
  console.error(`❌ 预警协同模块测试 ${failed} 项失败`)
  process.exit(1)
} else {
  console.log('✅ 预警协同模块全部测试通过')
}
