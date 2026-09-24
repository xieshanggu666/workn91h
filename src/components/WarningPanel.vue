<template>
  <div class="warning">
    <!-- 数据源与当前角色 -->
    <div class="wn-top">
      <div class="sources">
        <span v-for="s in WARNING_SOURCES" :key="s.id" class="src-chip" :class="s.group">
          {{ s.icon }} {{ s.name }}
        </span>
      </div>
      <div class="role-switch">
        <label>当前角色</label>
        <select :value="warning.currentRole" @change="onRole($event)">
          <option v-for="r in warning.roles" :key="r.id" :value="r.id">{{ r.icon }} {{ r.name }}</option>
        </select>
      </div>
    </div>

    <!-- 实时接入控制 -->
    <div class="feed-bar">
      <button class="feed-btn" :class="{ on: warning.feedOn }" @click="toggleFeed">
        {{ warning.feedOn ? '⏹ 停止实时接入' : '📡 实时接入气象/地质信号' }}
      </button>
      <button class="feed-btn ghost" @click="onPushNext">⏭ 模拟下一条报文</button>
      <button class="feed-btn ghost" @click="showManual = !showManual">✍️ 人工录入</button>
      <span class="feed-state">
        已接报文 {{ warning.signals.length }} 条 · 信号流 {{ warning.feedOn ? '实时推送中（5s/条）' : '未连接' }}
      </span>
    </div>

    <!-- 人工录入信号 -->
    <div v-if="showManual" class="manual-form">
      <div class="mf-grid">
        <div class="field">
          <label>数据源</label>
          <select v-model="manual.source">
            <option v-for="s in WARNING_SOURCES" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>预警种类</label>
          <select v-model="manual.kind">
            <option v-for="(v, k) in WARNING_KINDS" :key="k" :value="k">{{ v.icon }} {{ v.label }}</option>
          </select>
        </div>
        <div class="field">
          <label>信号等级（解除选空）</label>
          <select v-model="manual.level">
            <option value="blue">蓝色 · Ⅳ级</option>
            <option value="yellow">黄色 · Ⅲ级</option>
            <option value="orange">橙色 · Ⅱ级</option>
            <option value="red">红色 · Ⅰ级</option>
            <option value="">解除信号</option>
          </select>
        </div>
        <div class="field">
          <label>影响半径(km)</label>
          <input type="number" min="1" v-model.number="manual.radiusKm" />
        </div>
      </div>
      <div class="mf-grid">
        <div class="field"><label>地名</label><input v-model="manual.name" placeholder="如 江油·含增镇" /></div>
        <div class="field"><label>经度</label><input type="number" step="0.0001" v-model.number="manual.lng" /></div>
        <div class="field"><label>纬度</label><input type="number" step="0.0001" v-model.number="manual.lat" /></div>
      </div>
      <div class="field"><label>报文摘要 / 监测指标</label><input v-model="manual.note" placeholder="如 3h 降雨 150mm" /></div>
      <div class="mf-btns">
        <button class="ok" @click="onManual">接入该信号</button>
        <button @click="showManual = false">取消</button>
      </div>
      <p v-if="manualFb" class="fb" :class="manualFb.ok ? 'ok' : 'err'">{{ manualFb.msg }}</p>
    </div>

    <!-- 多角色协同总览 -->
    <div class="ack-overview">
      <div class="panel-sub">👥 多角色协同确认（等级越高，告知角色越多）</div>
      <div class="role-row">
        <div v-for="r in warning.roles" :key="r.id" class="role-cell">
          <span class="r-icon">{{ r.icon }}</span>
          <span class="r-name">{{ r.name }}</span>
          <em class="r-state" :class="roleStateClass(r.id)">{{ roleStateText(r.id) }}</em>
        </div>
      </div>
      <p class="role-hint">
        蓝色→值班调度员 ｜ 黄色+现场指挥员 ｜ 橙色+气象地灾专家 ｜ 红色全员（含应急指挥长）；全员签收后预警转为「已确认」
      </p>
    </div>

    <!-- 预警列表 -->
    <div class="wn-list">
      <div class="panel-sub">🚨 协同预警（{{ warning.activeWarnings.length }} 条在效）</div>
      <div v-if="warning.warnings.length === 0" class="tiny-empty">
        暂无预警，点击上方「模拟下一条报文」或开启「实时接入」
      </div>

      <div
        v-for="w in warning.warnings"
        :key="w.id"
        class="wn-card"
        :class="[w.severity, { revoked: w.status === 'revoked', mine: needsMine(w) }]"
      >
        <div class="wc-head">
          <span class="wc-kind">{{ kindMeta(w.kind).icon }} {{ kindMeta(w.kind).label }}</span>
          <span class="wc-sev">{{ sevLabel(w.severity) }}</span>
          <span class="wc-status" :class="w.status">{{ statusLabel(w.status) }}</span>
          <span v-if="needsMine(w)" class="wc-mine">👉 待我确认</span>
          <span class="wc-time">{{ w.issuedAt }}</span>
        </div>
        <p class="wc-loc">
          📍 {{ w.location.name }}（{{ w.location.lng.toFixed(3) }}, {{ w.location.lat.toFixed(3) }}）· 落区半径 {{ w.radiusKm }}km
        </p>
        <p class="wc-note">{{ w.note || '监测指标超阈值' }}</p>
        <p class="wc-src">📡 {{ w.sourceName }} · 关联事件：
          <a v-if="linkedEvent(w)" @click="store.selectEvent(w.eventId)">{{ linkedEvent(w).title }} →</a>
          <em v-else>无</em>
        </p>

        <!-- 角色确认进度 -->
        <div class="wc-acks">
          <span
            v-for="r in requiredRoles(w)"
            :key="r.id"
            class="ack-chip"
            :class="{ done: !!w.acks[r.id], mine: r.id === warning.currentRole }"
          >
            {{ r.icon }} {{ r.name }}
            <i>{{ w.acks[r.id] ? '✓ ' + w.acks[r.id].at : '待确认' }}</i>
          </span>
        </div>

        <!-- 操作区 -->
        <div v-if="w.status !== 'revoked'" class="wc-actions">
          <button
            v-if="needsMine(w)"
            class="act ack"
            @click="onAck(w)"
          >✅ {{ currentRoleName() }}确认签收</button>
          <button class="act" @click="focusMap(w)">📍 地图定位</button>
          <template v-if="!linkedEvent(w) && kindMeta(w.kind).eventType">
            <button class="act link" @click="onLink(w)">🔗 关联事件</button>
            <button class="act link" @click="warning.createEventForWarning(w.id)">🆕 建档灾情</button>
          </template>
          <template v-if="(warning.currentRole === 'expert' || warning.currentRole === 'chief') && canEscalate(w)">
            <button class="act up" @click="onEscalate(w)">⏫ 人工升级</button>
          </template>
          <button class="act revoke" @click="onRevoke(w)">🚫 解除</button>
        </div>

        <!-- 预置调度建议（橙/红已确认） -->
        <div v-if="w.suggestion && w.status !== 'revoked'" class="suggest">
          <div class="sg-head">
            <span>🚚 预置调度建议（按{{ sevLabel(w.severity) }}需求就近分配）</span>
            <button v-if="!w.suggestionApplied" class="act apply" @click="onApply(w)">一键出库 {{ w.suggestion.items.length }} 单</button>
            <em v-else class="sg-done">✅ 已出库 {{ w.applyResult?.count }} 单</em>
          </div>
          <div class="sg-items">
            <span v-for="it in w.suggestion.items" :key="it.id" class="sg-item">
              {{ resLabel(it.type) }} {{ it.qty }}{{ resUnit(it.type) }} 👈{{ it.baseName }}
            </span>
          </div>
          <p v-if="w.applyResult?.unmet?.length" class="sg-unmet">
            ⚠ 库存不足待统筹：{{ w.applyResult.unmet.map((u) => resLabel(u.type) + '缺' + u.qty + resUnit(u.type)).join('、') }}
          </p>
        </div>

        <!-- 协同记录 -->
        <div class="wc-history">
          <p v-for="(h, i) in [...w.history].reverse()" :key="i" class="h-item">
            <span class="h-time">{{ h.at }}</span>{{ h.text }}
          </p>
        </div>
      </div>

      <!-- 已解除归档（折叠） -->
      <details class="revoked-box" v-if="revokedList.length">
        <summary>📂 已解除预警（{{ revokedList.length }}）</summary>
        <div v-for="w in revokedList" :key="w.id" class="wc-card revoked flat">
          <div class="wc-head">
            <span class="wc-kind">{{ kindMeta(w.kind).icon }} {{ kindMeta(w.kind).label }}</span>
            <span class="wc-sev">{{ sevLabel(w.severity) }}</span>
            <span class="wc-status revoked">已解除 · {{ w.revokedAt }}</span>
          </div>
          <p class="wc-note">{{ w.revokeReason || w.note }}</p>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { useWarningStore } from '@/store/warning'
import { useCommandStore } from '@/store/command'
import {
  WARNING_KINDS, WARNING_SOURCES, SEVERITY, RESOURCE_TYPES
} from '@/mock/data'

const warning = useWarningStore()
const store = useCommandStore()
const showManual = ref(false)
const manual = reactive({
  source: 'cma', kind: 'rain', level: 'yellow',
  name: '', lng: 104.7, lat: 31.7, radiusKm: 12, note: ''
})
const manualFb = ref(null)

const kindMeta = (k) => WARNING_KINDS[k] || { label: k, icon: '🚨', color: '#999', eventType: null }
const sevMeta = (v) => SEVERITY.find((s) => s.value === v) || { label: v, color: '#999' }
const sevLabel = (v) => sevMeta(v).label
const statusMeta = (v) => ({ pending: { label: '待确认' }, confirmed: { label: '已确认' }, revoked: { label: '已解除' } }[v] || { label: v })
const statusLabel = (v) => statusMeta(v).label
const resLabel = (k) => RESOURCE_TYPES[k]?.label || k
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''
const currentRoleName = () => warning.role.icon + ' ' + warning.role.name

const revokedList = computed(() => warning.warnings.filter((w) => w.status === 'revoked'))
const requiredRoles = (w) => warning.requiredRoleIds(w).map((id) => warning.roles.find((r) => r.id === id))
const linkedEvent = (w) => store.events.find((e) => e.id === w.eventId) || null
const needsMine = (w) => warning.pendingAckForRole(warning.currentRole).some((x) => x.id === w.id)

// 顶部角色总览（聚合全部在效预警）
function roleStateClass(roleId) {
  const mine = warning.activeWarnings.filter((w) => (w.notifiedRoles || []).includes(roleId))
  if (!mine.length) return 'idle'
  if (mine.some((w) => !w.acks[roleId])) return 'pending'
  return 'done'
}
function roleStateText(roleId) {
  const c = roleStateClass(roleId)
  if (c === 'idle') return '本轮无需确认'
  if (c === 'pending') return `${warning.activeWarnings.filter((w) => (w.notifiedRoles || []).includes(roleId) && !w.acks[roleId]).length} 条待签`
  return '本轮已全部签收'
}

function onRole(e) {
  warning.setRole(e.target.value)
  warning.markRead(e.target.value)
}
function toggleFeed() {
  warning.markRead()
  if (warning.feedOn) warning.stopFeed()
  else { warning.startFeed(); warning.markRead() }
}
function onPushNext() {
  const r = warning.pushNextSignal()
  warning.markRead()
  if (r && !r.ok && r.msg) manualFb.value = { ok: false, msg: r.msg }
}
function onManual() {
  const r = warning.manualSignal({ ...manual })
  manualFb.value = r.ok
    ? { ok: true, msg: { issue: '预警已发布', escalate: '预警已升级', downgrade: '预警已下调', renew: '同等级续报', ignored: '信号已忽略' }[r.action] || '已接入' }
    : { ok: false, msg: r.msg }
  if (r.ok) showManual.value = false
  warning.markRead()
}
function onAck(w) {
  const r = warning.ackWarning(w.id)
  if (!r.ok) window.alert(r.msg)
  warning.markRead()
}
function canEscalate(w) {
  return w.severity !== 'red'
}
function onEscalate(w) {
  const order = ['blue', 'yellow', 'orange', 'red']
  const next = order[order.indexOf(w.severity) + 1]
  if (!next) return
  const r = warning.escalateWarning(w.id, next)
  if (!r.ok) window.alert(r.msg)
}
function onRevoke(w) {
  const reason = window.prompt('解除原因（监测信号解除 / 人工研判解除）', '灾害过程结束')
  if (reason === null) return
  warning.revokeWarning(w.id, reason || '灾害过程结束')
}
function focusMap(w) {
  warning.focusWarning(w.id)
  if (w.eventId) store.selectEvent(w.eventId)
}
function onLink(w) {
  const candidates = store.events.filter((e) => e.status !== 'closed')
  if (!candidates.length) { window.alert('当前无可关联的在报事件，可点击「建档灾情」'); return }
  const names = candidates.map((e, i) => `${i + 1}. ${e.title}`).join('\n')
  const pick = window.prompt('输入要关联的事件序号：\n' + names, '1')
  const idx = parseInt(pick, 10) - 1
  const ev = candidates[idx]
  if (ev) warning.linkEvent(w.id, ev.id)
}
function onApply(w) {
  const r = warning.applySuggestion(w.id)
  if (!r.ok) window.alert(r.msg)
}
</script>

<style scoped>
.warning { display: flex; flex-direction: column; gap: 10px; padding: 12px; height: 100%; overflow-y: auto; }
.warning::-webkit-scrollbar { width: 6px; }
.warning::-webkit-scrollbar-thumb { background: #1c2b4a; border-radius: 4px; }
.panel-sub { font-size: 12px; color: #6f8cb8; font-weight: 600; border-left: 3px solid #26c6da; padding-left: 8px; margin: 4px 0; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 10px; border: 1px dashed rgba(120,160,220,0.2); border-radius: 8px; }

.wn-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.sources { display: flex; flex-wrap: wrap; gap: 4px; }
.src-chip {
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.18); color: #8ba2c8;
}
.src-chip.weather { border-color: rgba(47,156,245,0.4); color: #7db9f0; }
.src-chip.hydrology { border-color: rgba(38,198,218,0.4); color: #6fd6e8; }
.src-chip.geo { border-color: rgba(156,107,47,0.5); color: #d3a26b; }
.role-switch { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.role-switch label { font-size: 10px; color: #6f8cb8; }
.role-switch select {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25); color: #dbe4f3;
  border-radius: 6px; padding: 4px 6px; font-size: 11px;
}

.feed-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.feed-btn {
  background: #0c1730; border: 1px solid rgba(38,198,218,0.45); color: #6fd6e8;
  font-size: 11px; border-radius: 6px; padding: 6px 10px; cursor: pointer;
}
.feed-btn.on { background: rgba(38,198,218,0.18); color: #a7f0fa; box-shadow: 0 0 10px rgba(38,198,218,0.3); }
.feed-btn.ghost { border-color: rgba(120,160,220,0.3); color: #8ba2c8; }
.feed-state { font-size: 10px; color: #5b6f94; margin-left: auto; }

.manual-form {
  background: #101d39; border: 1px solid rgba(120,160,220,0.18); border-radius: 9px; padding: 10px;
}
.mf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.field { margin-bottom: 6px; }
.field label { display: block; font-size: 10px; color: #8ba2c8; margin-bottom: 3px; }
.field select, .field input {
  width: 100%; box-sizing: border-box;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 6px; font-size: 11px;
}
.mf-btns { display: flex; gap: 6px; }
.mf-btns button {
  padding: 5px 12px; font-size: 11px; border-radius: 6px; cursor: pointer;
  background: transparent; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.mf-btns button.ok { border-color: #26c6da; color: #6fd6e8; }
.fb { font-size: 10px; margin: 6px 0 0; }
.fb.ok { color: #7ef0c9; }
.fb.err { color: #ef9a9a; }

.ack-overview {
  background: #101d39; border: 1px solid rgba(38,198,218,0.22); border-radius: 9px; padding: 9px 10px;
}
.role-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.role-cell {
  display: flex; align-items: center; gap: 5px; font-size: 11px; color: #aebadd;
  background: rgba(12,23,48,0.7); border-radius: 6px; padding: 5px 7px;
}
.r-icon { font-size: 13px; }
.r-name { flex: 1; }
.r-state { font-style: normal; font-size: 9px; padding: 1px 6px; border-radius: 4px; }
.r-state.idle { color: #5b6f94; background: rgba(120,160,220,0.08); }
.r-state.pending { color: #ffcc80; background: rgba(255,152,0,0.16); }
.r-state.done { color: #7ef0c9; background: rgba(38,166,154,0.15); }
.role-hint { font-size: 9px; color: #5b6f94; margin: 7px 0 0; line-height: 1.6; }

.wn-list { display: flex; flex-direction: column; gap: 8px; }
.wn-card {
  background: rgba(16,29,57,0.7); border: 1px solid rgba(120,160,220,0.14);
  border-left-width: 3px; border-radius: 9px; padding: 9px 10px;
}
.wn-card.blue { border-left-color: #4caf50; }
.wn-card.yellow { border-left-color: #ffc107; }
.wn-card.orange { border-left-color: #ff9800; }
.wn-card.red { border-left-color: #ef5350; box-shadow: inset 0 0 20px rgba(239,83,80,0.06); }
.wn-card.mine { box-shadow: 0 0 0 1px rgba(38,198,218,0.5), 0 0 14px rgba(38,198,218,0.18); }
.wn-card.revoked { opacity: 0.62; border-left-color: #4caf50; }
.wn-card.flat { box-shadow: none; }
.wc-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.wc-kind { color: #dbe4f3; font-size: 12px; font-weight: 700; }
.wc-sev { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 4px; color: #fff; }
.wc-sev.red { background: #ef5350; }
.wc-sev.orange { background: #ff9800; }
.wc-sev.yellow { background: #c9a400; }
.wc-sev.blue { background: #4caf50; }
.wc-status { font-size: 10px; padding: 1px 7px; border-radius: 4px; }
.wc-status.pending { background: rgba(255,152,0,0.18); color: #ffcc80; }
.wc-status.confirmed { background: rgba(47,156,245,0.18); color: #7db9f0; }
.wc-status.revoked { background: rgba(76,175,80,0.16); color: #a5d6a7; }
.wc-mine { font-size: 9px; color: #0a1224; background: #26c6da; padding: 1px 6px; border-radius: 4px; font-weight: 700; }
.wc-time { margin-left: auto; font-size: 9px; color: #5b6f94; font-family: monospace; }
.wc-loc { font-size: 10px; color: #8ba2c8; margin: 5px 0 2px; }
.wc-note { font-size: 11px; color: #aebadd; margin: 0 0 4px; line-height: 1.5; }
.wc-src { font-size: 10px; color: #5b6f94; margin: 0; }
.wc-src a { color: #6fd6e8; cursor: pointer; }
.wc-src em { font-style: normal; }

.wc-acks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.ack-chip {
  font-size: 9px; padding: 2px 7px; border-radius: 4px;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #5b6f94;
}
.ack-chip i { font-style: normal; margin-left: 4px; }
.ack-chip.done { border-color: rgba(38,166,154,0.5); color: #7ef0c9; }
.ack-chip.mine:not(.done) { border-color: rgba(38,198,218,0.7); color: #a7f0fa; }

.wc-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.act {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.act:hover { color: #fff; border-color: #26c6da; }
.act.ack { border-color: rgba(38,198,218,0.7); color: #a7f0fa; font-weight: 700; }
.act.up { border-color: rgba(255,152,0,0.55); color: #ffcc80; }
.act.revoke { border-color: rgba(239,83,80,0.4); color: #ef9a9a; margin-left: auto; }
.act.apply { border-color: #26a69a; color: #7ef0c9; font-weight: 700; }

.suggest {
  margin-top: 8px; background: rgba(12,23,48,0.8);
  border: 1px solid rgba(38,166,154,0.35); border-radius: 7px; padding: 8px;
}
.sg-head { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #7ef0c9; }
.sg-done { font-style: normal; font-size: 10px; color: #a5d6a7; }
.sg-items { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.sg-item {
  font-size: 9px; background: rgba(38,166,154,0.1); border: 1px solid rgba(38,166,154,0.25);
  color: #a7f3d0; padding: 2px 6px; border-radius: 4px;
}
.sg-unmet { font-size: 9px; color: #ffab91; margin: 6px 0 0; }

.wc-history { margin-top: 7px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 6px; }
.h-item { font-size: 9px; color: #5b6f94; margin: 2px 0; line-height: 1.5; }
.h-time { color: #8d7a3f; margin-right: 6px; font-family: monospace; }

.revoked-box { font-size: 11px; color: #6f8cb8; }
.revoked-box summary { cursor: pointer; padding: 4px; }
</style>
