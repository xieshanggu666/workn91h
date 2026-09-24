import { defineStore } from 'pinia'
import { useCommandStore, roughPath } from '@/store/command'
import {
  WARNING_KINDS, WARNING_SOURCES, WARNING_ROLES, ACK_ROLES_BY_SEV,
  SEVERITY, warningDemand, warningAffected
} from '@/mock/data'
import { signalTrackKey, WARNING_FEED } from '@/mock/warningFeed'
import { haversineKm } from '@/utils/geo'

/* =========================================================================
 * 实时预警协同模块
 *
 * 数据接入：气象 / 水文 / 地质 / 地震台网信号（sig）经 ingestSignal 接入，
 *           同一灾害过程（kind + 位置归并键 trackKey）的后续信号自动做
 *           新发 / 升级 / 降级 / 解除，报文级去重。
 * 多角色告警：按灾情等级触发不同协同角色（蓝→值班员，黄→+指挥员，
 *           橙→+专家，红→+指挥长），各角色逐一确认签收，全员确认后
 *           预警转为「已确认」；升级后按新等级重新确认。
 * 联动回写：关联灾情事件（就近匹配 / 自动建档）、事件等级与处置状态、
 *           事件时间线、预置调度建议（一键出库）、地图落区与指挥大屏。
 * 撤销解除：解除信号或人工解除后通知全部已告知角色，自动建档且尚未处置
 *           的事件联动结案；预置调度建议失效。
 * ========================================================================= */

let wnSeq = 0
let evSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const SEV_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 }
const kindMeta = (k) => WARNING_KINDS[k] || { label: k, icon: '🚨', color: '#9e9e9e', eventType: null }
const sevMeta = (v) => SEVERITY.find((s) => s.value === v) || { label: v, color: '#9e9e9e' }
const roleMeta = (id) => WARNING_ROLES.find((r) => r.id === id) || { name: id, icon: '👤' }
const sourceMeta = (id) => WARNING_SOURCES.find((s) => s.id === id) || { name: id, icon: '📡' }

// 按影响半径生成六边形落区（经纬度近似，演示用；与受灾 Polygon 同构供地图叠加）
function impactPolygon(lng, lat, radiusKm) {
  const poly = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6
    const dLat = (radiusKm * Math.cos(a)) / 111.32
    const dLng = (radiusKm * Math.sin(a)) / (111.32 * Math.cos((lat * Math.PI) / 180))
    poly.push([+(lng + dLng).toFixed(4), +(lat + dLat).toFixed(4)])
  }
  return poly
}

const FEED_INTERVAL = 5000

export const useWarningStore = defineStore('warning', {
  state: () => ({
    warnings: [],        // 协同预警记录
    signals: [],         // 已接收的监测报文流水
    feedOn: false,       // 实时信号流开关（模拟 WebSocket/SSE 接入）
    feedCursor: 0,       // 信号流推送位置（循环回放）
    currentRole: 'duty', // 当前登录操作的协同角色
    focusWarningId: null,
    readAt: {},          // 各角色最近查看告警的时间戳（未读角标用）
    clock: null,         // 演示/测试用时钟覆盖（'HH:MM'）
    _timer: null
  }),

  getters: {
    activeWarnings: (s) => s.warnings.filter((w) => w.status !== 'revoked'),
    pendingWarnings(s) { return s.warnings.filter((w) => w.status === 'pending') },
    // 当前角色待确认的预警（已告知本角色且本轮尚未签收）
    pendingAckForRole(s) {
      return (roleId) => s.warnings.filter((w) =>
        w.status === 'pending' && (w.notifiedRoles || []).includes(roleId) && !w.acks[roleId])
    },
    warningById: (s) => (id) => s.warnings.find((w) => w.id === id) || null,
    roles: () => WARNING_ROLES,
    role: (s) => WARNING_ROLES.find((r) => r.id === s.currentRole) || WARNING_ROLES[0],
    // 大屏统计
    stats(s) {
      const active = s.warnings.filter((w) => w.status !== 'revoked')
      return {
        active: active.length,
        pending: active.filter((w) => w.status === 'pending').length,
        red: active.filter((w) => w.severity === 'red').length,
        orange: active.filter((w) => w.severity === 'orange').length,
        revokedToday: s.warnings.filter((w) => w.status === 'revoked').length,
        unreadMine: active.filter((w) =>
          (w.notifiedAt?.[s.currentRole] || 0) > (s.readAt[s.currentRole] || 0)).length
      }
    },
    // 某预警当前等级要求确认的角色清单
    requiredRoleIds: () => (w) => ACK_ROLES_BY_SEV[w.severity] || ACK_ROLES_BY_SEV.blue
  },

  actions: {
    _cmd() { return useCommandStore() },
    _now() { return this.clock || nowStr() },
    setRole(roleId) { if (WARNING_ROLES.some((r) => r.id === roleId)) this.currentRole = roleId },
    focusWarning(id) { this.focusWarningId = id },
    markRead(roleId = this.currentRole) { this.readAt[roleId] = Date.now() },
    setClock(t) { this.clock = t || null },

    load() {
      this._stopFeedTimer()
      this.warnings = []
      this.signals = []
      this.feedOn = false
      this.feedCursor = 0
      this.focusWarningId = null
      this.readAt = {}
      this.clock = null
    },

    /* ---------- 实时信号流（模拟接入；可替换为 WebSocket/SSE 订阅） ---------- */

    startFeed() {
      if (this.feedOn) return
      this.feedOn = true
      this._timer = setInterval(() => {
        // 复盘回放只读：暂停推送（面板操作本身也会被录制器拦截）
        const sig = this._nextFeedSignal()
        if (sig) this.ingestSignal(sig)
      }, FEED_INTERVAL)
    },
    stopFeed() {
      this.feedOn = false
      this._stopFeedTimer()
    },
    _stopFeedTimer() {
      if (this._timer) { clearInterval(this._timer); this._timer = null }
    },
    // 手动模拟下一条报文（信号流循环回放，便于演示）
    pushNextSignal() {
      const sig = this._nextFeedSignal()
      return sig ? this.ingestSignal(sig) : null
    },
    _nextFeedSignal() {
      // 延迟导入避免循环依赖；信号流来自 mock，实际部署替换为数据源客户端
      const list = this._feedList()
      if (!list.length) return null
      const sig = list[this.feedCursor % list.length]
      this.feedCursor++
      // 一轮结束后停止（避免演示中无限循环刷告警）
      if (this.feedCursor >= list.length) this.stopFeed()
      return { ...sig, id: sig.id + '-' + Math.ceil(this.feedCursor / list.length) + '-' + this.feedCursor }
    },
    // 信号流来自 mock 报文序列；实际部署替换为 WebSocket/SSE 数据源客户端
    _feedList() {
      return WARNING_FEED
    },

    /* ---------- 信号接入：去重 → 归并 → 新发/升级/降级/解除 ---------- */

    // 监测报文接入入口（数据源客户端 / 模拟推送 / 手工录入都走这里）
    ingestSignal(sig) {
      if (!sig || !sig.kind) return { ok: false, msg: '信号缺少预警种类' }
      if (this.signals.some((x) => x.id === sig.id)) return { ok: false, msg: '重复报文，已忽略' }
      this.signals.unshift({ ...sig, receivedAt: this._now() })
      const track = signalTrackKey(sig)
      const existing = this.warnings.find((w) => w.trackKey === track && w.status !== 'revoked')
      if (!sig.level) {
        // 解除信号：无在效预警时仅记报文
        if (!existing) return { ok: true, action: 'ignored', msg: '解除信号：无在效预警' }
        return this.revokeWarning(existing.id, sig.note || '监测信号解除', true)
      }
      if (!existing) return this._issue(sig, track)
      const cmp = SEV_RANK[sig.level] - SEV_RANK[existing.severity]
      if (cmp > 0) return this._escalate(existing, sig)
      if (cmp < 0) return this._downgrade(existing, sig)
      // 同等级续报：更新监测指标，不重置确认进度
      existing.metric = sig.metric
      existing.updatedAt = this._now()
      existing.lastSigId = sig.id
      this._history(existing, 'renew', `📡 ${sourceMeta(sig.source).name}续报：${sig.note}`)
      this._eventLog(existing, `📡 ${kindMeta(sig.kind).label}续报（${sevMeta(sig.level).label}）：${sig.note}`)
      return { ok: true, action: 'renew', warning: existing }
    },

    // 人工录入信号（面板表单）
    manualSignal({ source, kind, level, name, lng, lat, radiusKm, note, metric }) {
      const seq = ++wnSeq
      const sig = {
        id: 'sig-manual-' + Date.now() + '-' + seq,
        source: source || 'cma', kind, level: level || 'blue',
        location: { name: name || '人工录入位置', lng: +lng, lat: +lat },
        radiusKm: +radiusKm || 10,
        metric: metric || {}, note: note || '人工录入监测信号'
      }
      if (!isFinite(sig.location.lng) || !isFinite(sig.location.lat)) {
        return { ok: false, msg: '请填写有效的经纬度' }
      }
      return this.ingestSignal(sig)
    },

    _issue(sig, track) {
      const meta = kindMeta(sig.kind)
      const roles = ACK_ROLES_BY_SEV[sig.level] || ACK_ROLES_BY_SEV.blue
      const w = {
        id: 'wn-' + Date.now() + '-' + ++wnSeq,
        trackKey: track,
        kind: sig.kind,
        severity: sig.level,
        status: 'pending',
        source: sig.source,
        sourceName: sourceMeta(sig.source).name,
        location: { ...sig.location },
        radiusKm: sig.radiusKm || 10,
        polygon: impactPolygon(sig.location.lng, sig.location.lat, sig.radiusKm || 10),
        metric: sig.metric || {},
        note: sig.note || '',
        firstSigId: sig.id,
        lastSigId: sig.id,
        issuedAt: this._now(),
        updatedAt: this._now(),
        revokedAt: null,
        revokeReason: '',
        acks: {},                 // roleId -> { at }
        notifiedRoles: roles,
        notifiedAt: Object.fromEntries(roles.map((r) => [r, Date.now()])),
        history: [],
        eventId: null,
        eventAutoCreated: false,
        suggestion: null,
        suggestionApplied: false,
        applyResult: null
      }
      this.warnings.unshift(w)
      this._history(w, 'issue', `🚨 ${w.sourceName}发布${meta.label}（${sevMeta(w.severity).label}）：${w.note}`)
      // 关联灾情事件：就近匹配在报事件；橙/红预警且无匹配时自动建档
      const matched = this._matchEvent(w)
      if (matched) {
        w.eventId = matched.id
        this._eventLog(w, `🚨 ${meta.label}（${sevMeta(w.severity).label}）生效，监测落区与本事件相关，已纳入协同告警`)
      } else if ((w.severity === 'red' || w.severity === 'orange') && meta.eventType) {
        this._createEvent(w)
      }
      // 橙/红等级即时抬升关联事件等级
      if (w.eventId) this._syncEventSeverity(w)
      return { ok: true, action: 'issue', warning: w }
    },

    _escalate(w, sig) {
      const from = sevMeta(w.severity).label
      w.severity = sig.level
      w.metric = sig.metric
      w.note = sig.note || w.note
      w.source = sig.source
      w.sourceName = sourceMeta(sig.source).name
      w.radiusKm = sig.radiusKm || w.radiusKm
      w.polygon = impactPolygon(w.location.lng, w.location.lat, w.radiusKm)
      w.lastSigId = sig.id
      w.updatedAt = this._now()
      w.suggestionApplied = false
      // 升级后按新等级重新组织确认：旧签收看板保留在 history，确认进度重置
      const hadAcks = Object.keys(w.acks).length
      w.acks = {}
      w.status = 'pending'
      const roles = ACK_ROLES_BY_SEV[w.severity] || ACK_ROLES_BY_SEV.blue
      w.notifiedRoles = roles
      roles.forEach((r) => { w.notifiedAt[r] = Date.now() })
      this._history(w, 'escalate',
        `⏫ ${w.sourceName}升级预警：${from} → ${sevMeta(w.severity).label}，重新通知 ${roles.map((r) => roleMeta(r).name).join('、')} 确认`
        + (hadAcks ? `（原 ${hadAcks} 个角色确认已重置）` : ''))
      this._eventLog(w, `⏫ ${kindMeta(w.kind).label}升级为${sevMeta(w.severity).label}：${w.note}`)
      if (w.eventId) this._syncEventSeverity(w)
      return { ok: true, action: 'escalate', warning: w }
    },

    _downgrade(w, sig) {
      const from = sevMeta(w.severity).label
      w.severity = sig.level
      w.metric = sig.metric
      w.note = sig.note || w.note
      w.lastSigId = sig.id
      w.updatedAt = this._now()
      // 降级：缩窄告知范围，已确认状态保留；尚未确认的按新等级继续签收
      const roles = ACK_ROLES_BY_SEV[w.severity] || ACK_ROLES_BY_SEV.blue
      Object.keys(w.acks).forEach((r) => { if (!roles.includes(r)) delete w.acks[r] })
      w.notifiedRoles = roles
      roles.forEach((r) => { w.notifiedAt[r] = Date.now() })
      if (w.status === 'pending' && roles.every((r) => w.acks[r])) w.status = 'confirmed'
      this._history(w, 'downgrade', `⏬ ${sourceMeta(sig.source).name}下调预警：${from} → ${sevMeta(w.severity).label}`)
      this._eventLog(w, `⏬ ${kindMeta(w.kind).label}下调为${sevMeta(w.severity).label}：${w.note}`)
      return { ok: true, action: 'downgrade', warning: w }
    },

    /* ---------- 多角色确认签收 ---------- */

    // 角色确认（默认当前登录角色）；全员确认后预警转为已确认并生成预置调度建议
    ackWarning(id, roleId = this.currentRole) {
      const w = this._find(id)
      if (!w) return { ok: false, msg: '预警不存在' }
      if (w.status === 'revoked') return { ok: false, msg: '预警已解除，无需确认' }
      const required = ACK_ROLES_BY_SEV[w.severity] || ACK_ROLES_BY_SEV.blue
      if (!required.includes(roleId)) return { ok: false, msg: `${sevMeta(w.severity).label}预警无需「${roleMeta(roleId).name}」确认` }
      if (w.acks[roleId]) return { ok: false, msg: '该角色已确认，请勿重复签收' }
      w.acks[roleId] = { at: this._now() }
      this._history(w, 'ack', `✅ ${roleMeta(roleId).icon}${roleMeta(roleId).name}确认签收（${Object.keys(w.acks).length}/${required.length}）`)
      this._eventLog(w, `✅ ${roleMeta(roleId).name}确认${kindMeta(w.kind).label}（${Object.keys(w.acks).length}/${required.length}）`)
      if (required.every((r) => w.acks[r])) {
        w.status = 'confirmed'
        w.updatedAt = this._now()
        this._history(w, 'confirm', '🟢 各角色确认完毕，预警转为「已确认」')
        this._eventLog(w, `🟢 ${kindMeta(w.kind).label}多角色确认完毕，进入预置调度`)
        const cmd = this._cmd()
        if (w.eventId) {
          const ev = cmd.events.find((e) => e.id === w.eventId)
          if (ev && (ev.status === 'reported')) ev.status = 'assessing'
        }
        // 已确认即生成预置调度建议（红/橙可一键出库）
        if (w.eventId && (w.severity === 'red' || w.severity === 'orange')) {
          w.suggestion = this._buildSuggestion(w)
        }
      }
      return { ok: true, warning: w }
    },

    // 人工升级（专家/指挥长研判上调等级，重置确认）
    escalateWarning(id, level) {
      const w = this._find(id)
      if (!w) return { ok: false, msg: '预警不存在' }
      if (w.status === 'revoked') return { ok: false, msg: '预警已解除，不能升级' }
      if (!SEV_RANK[level]) return { ok: false, msg: '未知预警等级' }
      if (SEV_RANK[level] <= SEV_RANK[w.severity]) return { ok: false, msg: '升级目标等级须高于当前等级' }
      return this._escalate(w, {
        level, source: w.source, kind: w.kind,
        location: w.location, radiusKm: w.radiusKm,
        metric: w.metric, note: '人工研判升级', id: 'sig-up-' + Date.now()
      })
    },

    /* ---------- 解除撤销 ---------- */

    revokeWarning(id, reason = '', fromSignal = false) {
      const w = this._find(id)
      if (!w || w.status === 'revoked') return { ok: false, msg: '预警不存在或已解除' }
      w.status = 'revoked'
      w.revokedAt = this._now()
      w.revokeReason = reason
      w.updatedAt = w.revokedAt
      w.suggestion = null
      w.suggestionApplied = false
      this._history(w, 'revoke',
        `${fromSignal ? '📡 监测信号解除' : '🚫 人工解除预警'}：${reason || '灾害过程结束'}`
        + `，已通知 ${(w.notifiedRoles || []).map((r) => roleMeta(r).name).join('、')}`)
      this._eventLog(w, `🚫 ${kindMeta(w.kind).label}解除：${reason || '灾害过程结束'}`)
      // 自动建档且尚无任何派发处置的事件联动结案；既有事件仅回写时间线，不擅自结案
      if (w.eventId && w.eventAutoCreated) {
        const cmd = this._cmd()
        const ev = cmd.events.find((e) => e.id === w.eventId)
        const busy = cmd.dispatches.some((d) => d.eventId === w.eventId && d.status !== 'withdrawn')
        if (ev && !busy && (ev.status === 'reported' || ev.status === 'assessing')) {
          ev.status = 'closed'
          ev.timeline.push({ at: this._now(), text: `🚫 预警解除联动：${kindMeta(w.kind).label}已解除且事件未启动处置，自动结案` })
        }
      }
      return { ok: true, action: 'revoke', warning: w }
    },

    /* ---------- 事件关联与建档 ---------- */

    // 就近匹配：预警中心到在报事件中心距离 ≤ 预警半径 + 事件热区半径折算
    _matchEvent(w) {
      const cmd = this._cmd()
      let best = null, bestD = Infinity
      cmd.events.filter((e) => e.status !== 'closed').forEach((ev) => {
        const d = haversineKm([w.location.lng, w.location.lat], [ev.location.lng, ev.location.lat])
        const reach = w.radiusKm + (ev.heatRadius || 0) / 1000
        if (d <= reach && d < bestD) { best = ev; bestD = d }
      })
      return best
    },
    // 手工关联事件
    linkEvent(id, eventId) {
      const w = this._find(id)
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === eventId)
      if (!w || !ev) return { ok: false, msg: '预警或事件不存在' }
      w.eventId = ev.id
      w.eventAutoCreated = false
      this._history(w, 'link', `🔗 人工关联灾情事件：${ev.title}`)
      this._eventLog(w, `🔗 已与本事件建立预警协同关联（${kindMeta(w.kind).label}·${sevMeta(w.severity).label}）`)
      this._syncEventSeverity(w)
      if (w.status === 'confirmed' && (w.severity === 'red' || w.severity === 'orange')) {
        w.suggestion = this._buildSuggestion(w)
      }
      return { ok: true, warning: w }
    },
    // 蓝/黄预警确认后可手工建档（橙/红在发布时自动建档）
    createEventForWarning(id) {
      const w = this._find(id)
      if (!w || !kindMeta(w.kind).eventType) return { ok: false, msg: '该预警类型无对应灾情事件' }
      if (w.eventId) return { ok: false, msg: '预警已关联灾情事件' }
      this._createEvent(w)
      if (w.status === 'confirmed' && (w.severity === 'red' || w.severity === 'orange')) {
        w.suggestion = this._buildSuggestion(w)
      }
      return { ok: true, warning: w }
    },
    _createEvent(w) {
      const cmd = this._cmd()
      const meta = kindMeta(w.kind)
      const affected = warningAffected(w.severity)
      const ev = {
        id: 'ev-wn-' + Date.now() + '-' + ++evSeq,
        type: meta.eventType,
        title: `${w.location.name}·${meta.label}衍生灾情`,
        severity: w.severity,
        status: 'reported',
        location: { name: w.location.name, lng: w.location.lng, lat: w.location.lat },
        affectedPolygon: w.polygon.map((p) => [...p]),
        heatRadius: Math.round(w.radiusKm * 1000),
        desc: w.note || `${w.sourceName}发布${meta.label}，监测落区可能衍生灾情。`,
        reportedAt: this._now(),
        affected,
        evacuate: Math.round(affected * 0.35),
        demand: warningDemand(w.kind, w.severity),
        timeline: [],
        warningCreated: true
      }
      ev.timeline.push({ at: this._now(), text: `🚨 预警建档：${w.sourceName}${meta.label}（${sevMeta(w.severity).label}）自动建立灾情事件` })
      cmd.events.unshift(ev)
      w.eventId = ev.id
      w.eventAutoCreated = true
      cmd.selectedEventId = ev.id
      this._history(w, 'link', `🆕 自动建立灾情事件：${ev.title}`)
      return ev
    },
    // 预警等级不低于事件等级时抬升事件等级（红橙预警联动）
    _syncEventSeverity(w) {
      if (!w.eventId) return
      const ev = this._cmd().events.find((e) => e.id === w.eventId)
      if (ev && SEV_RANK[w.severity] > SEV_RANK[ev.severity]) {
        const from = sevMeta(ev.severity).label
        ev.severity = w.severity
        ev.timeline.push({ at: this._now(), text: `⏫ 预警联动提级：事件等级 ${from} → ${sevMeta(w.severity).label}` })
      }
    },

    /* ---------- 预置调度建议（回写调度） ---------- */

    // 按预警等级需求清单就近生成预置方案（预占不扣库存；红/橙确认后自动生成）
    _buildSuggestion(w) {
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === w.eventId)
      if (!ev) return null
      const need = warningDemand(w.kind, w.severity)
      const avail = {}
      cmd.bases.forEach((b) => { avail[b.id] = { ...b.stock } })
      const items = []
      let seq = 0
      Object.entries(need).forEach(([type, qty]) => {
        let remain = qty
        const cands = cmd.bases
          .filter((b) => (avail[b.id][type] || 0) > 0)
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (remain <= 0) break
          const take = Math.min(remain, avail[c.b.id][type])
          avail[c.b.id][type] -= take
          remain -= take
          items.push({
            id: 'wpi-' + ++seq, baseId: c.b.id, baseName: c.b.name,
            type, qty: take, distance: c.path.distance, minutes: c.path.minutes
          })
        }
      })
      return { at: this._now(), items, demand: need }
    },
    // 一键预置出库：按建议单实际派发（库存不足项如实反馈），回写调度/地图/大屏
    applySuggestion(id) {
      const w = this._find(id)
      if (!w) return { ok: false, msg: '预警不存在' }
      if (w.status === 'revoked') return { ok: false, msg: '预警已解除，预置方案失效' }
      if (!w.suggestion) return { ok: false, msg: '暂无预置调度建议' }
      if (w.suggestionApplied) return { ok: false, msg: '预置方案已出库，请勿重复执行' }
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === w.eventId)
      if (!ev) return { ok: false, msg: '预警未关联灾情事件' }
      const sent = [], unmet = []
      w.suggestion.items.forEach((it) => {
        const base = cmd.bases.find((b) => b.id === it.baseId)
        const qty = Math.min(it.qty, base?.stock[it.type] || 0)
        if (qty > 0) {
          const rec = cmd._pushDispatch(it.baseId, w.eventId, it.type, qty, '预警预置')
          if (rec) sent.push(rec)
        }
        if (qty < it.qty) unmet.push({ type: it.type, qty: it.qty - qty })
      })
      // 需求中各基地全无库存的类型
      const typesSent = {}
      sent.forEach((r) => { typesSent[r.type] = (typesSent[r.type] || 0) + r.qty })
      Object.entries(w.suggestion.demand).forEach(([type, qty]) => {
        const got = typesSent[type] || 0
        if (got < qty && !unmet.some((u) => u.type === type)) unmet.push({ type, qty: qty - got })
      })
      w.suggestionApplied = true
      w.applyResult = { at: this._now(), count: sent.length, unmet }
      this._history(w, 'dispatch', `🚚 预置调度出库 ${sent.length} 单`
        + (unmet.length ? `，${unmet.length} 类物资库存不足待统筹` : ''))
      this._eventLog(w, `🚚 预警预置调度已出库 ${sent.length} 单（${sent.map((r) => `${r.typeLabel}${r.qty}${r.unit}`).join('、') || '无'}）`)
      return { ok: sent.length > 0, sent, unmet }
    },

    /* ---------- 内部工具 ---------- */

    _find(id) { return this.warnings.find((x) => x.id === id) },
    _history(w, type, text) { w.history.push({ at: this._now(), type, text }) },
    _eventLog(w, text) {
      if (!w.eventId) return
      const ev = this._cmd().events.find((e) => e.id === w.eventId)
      if (ev) ev.timeline.push({ at: this._now(), text })
    }
  }
})
