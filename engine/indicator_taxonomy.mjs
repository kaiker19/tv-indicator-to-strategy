export const INDICATOR_FAMILIES = Object.freeze([
  Object.freeze({ id: 'trend', label: '趋势', description: '方向是否持续、速度是否变化' }),
  Object.freeze({ id: 'momentum', label: '动量', description: '涨跌压力相对历史是否极端' }),
  Object.freeze({ id: 'volatility', label: '波动率', description: '价格分布和波动状态是否扩张' }),
  Object.freeze({ id: 'volume_flow', label: '成交量', description: '价格变化是否得到活动方向支持' }),
  Object.freeze({ id: 'structure', label: '结构', description: '高低点、支撑阻力或 pivot 何时确认' }),
  Object.freeze({ id: 'hybrid', label: '混合', description: '多个特征共同形成状态、评分或分类' }),
]);

const BY_ID = new Map(INDICATOR_FAMILIES.map((family) => [family.id, family]));

export function getIndicatorFamily(id) {
  return BY_ID.get(String(id || '').trim()) || null;
}

export function indicatorFamilyLabel(id) {
  return getIndicatorFamily(id)?.label || '';
}

export function validateIndicatorFamily(id) {
  const normalized = String(id || '').trim();
  return {
    valid: BY_ID.has(normalized),
    value: normalized,
    allowed: INDICATOR_FAMILIES.map((family) => family.id),
  };
}
