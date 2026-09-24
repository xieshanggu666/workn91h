// 气象与地质监测信号流（模拟实时数据接入：实际部署可替换为 WebSocket / SSE 推送）
//
// 每条信号 = 监测站网原始报文：
//   id        报文编号
//   source    数据源（cma 气象 / hydro 水文 / geo 地灾 / seis 地震速报）
//   kind      预警种类（WARNING_KINDS 的 key）
//   level     信号建议等级 blue/yellow/orange/red（null 表示解除信号）
//   location  信号中心坐标与地名
//   radiusKm  影响半径（落区多边形按此生成）
//   metric    关键监测指标（雨量/水位/位移/震级…）
//   note      报文摘要
//
// 信号经 warning store 去抖定级后转为协同预警；同一 trackKey 的后续信号触发升级/降级/解除。

export const WARNING_FEED = [
  {
    id: 'sig-2001', source: 'cma', kind: 'rain', level: 'orange',
    location: { name: '江油·含增镇', lng: 104.68, lat: 31.86 }, radiusKm: 18,
    metric: { rainMm3h: 126 }, note: '3 小时降雨量已达 126mm，强回波持续东移'
  },
  {
    id: 'sig-2002', source: 'hydro', kind: 'flood', level: 'yellow',
    location: { name: '涪江·平武段', lng: 104.55, lat: 32.42 }, radiusKm: 14,
    metric: { waterLevel: 6.8, warnLine: 7.0, riseMph: 0.42 }, note: '水位 6.8m 逼近警戒线 7.0m，上涨速率 0.42m/h'
  },
  {
    id: 'sig-2003', source: 'cma', kind: 'rain', level: 'red',
    location: { name: '江油·含增镇', lng: 104.68, lat: 31.86 }, radiusKm: 22,
    metric: { rainMm3h: 198 }, note: '3 小时降雨量 198mm，升级暴雨红色预警'
  },
  {
    id: 'sig-2004', source: 'geo', kind: 'landslide', level: 'orange',
    location: { name: '北川·陈家坝', lng: 104.52, lat: 31.70 }, radiusKm: 9,
    metric: { displacementMm24h: 86, tiltDeg: 2.1 }, note: '坡体 24h 位移 86mm，裂缝持续扩张，滑坡风险高'
  },
  {
    id: 'sig-2005', source: 'hydro', kind: 'flood', level: 'orange',
    location: { name: '涪江·平武段', lng: 104.55, lat: 32.42 }, radiusKm: 16,
    metric: { waterLevel: 7.12, warnLine: 7.0, riseMph: 0.31 }, note: '水位 7.12m 超警，升级洪水橙色预警'
  },
  {
    id: 'sig-2006', source: 'cma', kind: 'tempest', level: 'yellow',
    location: { name: '广元·利州', lng: 105.86, lat: 32.45 }, radiusKm: 20,
    metric: { gustMs: 24.6 }, note: '监测到 24.6m/s 阵性大风并伴冰雹'
  },
  {
    id: 'sig-2007', source: 'seis', kind: 'quake', level: 'yellow',
    location: { name: '青川·板桥', lng: 105.18, lat: 32.60 }, radiusKm: 12,
    metric: { magnitude: 4.6, depthKm: 11 }, note: '发生 4.6 级地震，震源深度 11km'
  },
  {
    id: 'sig-2008', source: 'cma', kind: 'tempest', level: null,
    location: { name: '广元·利州', lng: 105.86, lat: 32.45 }, radiusKm: 20,
    metric: { gustMs: 12.1 }, note: '大风过程结束，阵风减弱至 12.1m/s，解除预警'
  },
  {
    id: 'sig-2009', source: 'seis', kind: 'quake', level: null,
    location: { name: '青川·板桥', lng: 105.18, lat: 32.60 }, radiusKm: 12,
    metric: { magnitude: 4.6 }, note: '余震活动趋于平静，未发现新增灾情，解除地震应急预警'
  },
  {
    id: 'sig-2010', source: 'cma', kind: 'rain', level: null,
    location: { name: '江油·含增镇', lng: 104.68, lat: 31.86 }, radiusKm: 22,
    metric: { rainMm3h: 6 }, note: '强降雨结束，雨强降至 6mm/3h，解除暴雨预警'
  }
]

// 同一灾害过程的归并键：数据源位置 + 种类（后续信号据此升级/解除同一预警）
export function signalTrackKey(sig) {
  return `${sig.kind}@${sig.location.lng.toFixed(2)},${sig.location.lat.toFixed(2)}`
}
