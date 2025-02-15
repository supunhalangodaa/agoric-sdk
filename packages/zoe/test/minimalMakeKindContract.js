/* global VatData */

const start = _zcf => {
  VatData.defineKind('x', () => {}, {});
  VatData.defineKindMulti('x', () => {}, { x: {}, y: {} });
  const kh = VatData.makeKindHandle();
  VatData.defineDurableKind(kh, () => {}, {});
  const kh2 = VatData.makeKindHandle();
  VatData.defineDurableKindMulti(kh2, () => {}, { x: {}, y: {} });
  VatData.makeScalarBigMapStore();
  VatData.makeScalarBigWeakMapStore();
  VatData.makeScalarBigSetStore();
  VatData.makeScalarBigWeakSetStore();

  return harden({});
};
harden(start);
export { start };
