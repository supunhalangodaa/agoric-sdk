// @ts-check

import { makeIssuerKit, AmountMath } from '@agoric/ertp';
import { makeStore } from '@agoric/store';
import { makeZoeKit } from '../../src/zoeService/zoe.js';
import { makeFakeVatAdmin } from '../../tools/fakeVatAdmin.js';

export const setup = () => {
  const moolaKit = makeIssuerKit('moola');
  const simoleanKit = makeIssuerKit('simoleans');
  const bucksKit = makeIssuerKit('bucks');
  const allIssuerKits = {
    moola: moolaKit,
    simoleans: simoleanKit,
    bucks: bucksKit,
  };
  /** @type {Store<string, Brand>} */
  const brands = makeStore('brandName');

  for (const k of Object.getOwnPropertyNames(allIssuerKits)) {
    brands.init(k, allIssuerKits[k].brand);
  }

  const { admin: fakeVatAdmin, vatAdminState } = makeFakeVatAdmin();
  const { zoeService: zoe } = makeZoeKit(fakeVatAdmin);

  /** @type {(brand: Brand) => (value: AmountValue) => Amount} */
  const makeSimpleMake = brand => value => AmountMath.make(brand, value);

  /**
   * @typedef {object} BasicMints
   * @property {Issuer} moolaIssuer
   * @property {Mint} moolaMint
   * @property {IssuerKit} moolaKit
   * @property {Issuer} simoleanIssuer
   * @property {Mint} simoleanMint
   * @property {IssuerKit} simoleanKit
   * @property {Issuer} bucksIssuer
   * @property {Mint} bucksMint
   * @property {IssuerKit} bucksKit
   * @property {Store<string, Brand>} brands
   * @property {(value: AmountValue) => Amount} moola
   * @property {(value: AmountValue) => Amount} simoleans
   * @property {(value: AmountValue) => Amount} bucks
   * @property {ZoeService} zoe
   * @property {*} vatAdminState
   */

  /** @type {BasicMints} */
  const result = {
    moolaIssuer: moolaKit.issuer,
    moolaMint: moolaKit.mint,
    moolaKit,
    simoleanIssuer: simoleanKit.issuer,
    simoleanMint: simoleanKit.mint,
    simoleanKit,
    bucksIssuer: bucksKit.issuer,
    bucksMint: bucksKit.mint,
    bucksKit,
    brands,
    moola: makeSimpleMake(moolaKit.brand),
    simoleans: makeSimpleMake(simoleanKit.brand),
    bucks: makeSimpleMake(bucksKit.brand),
    zoe,
    vatAdminState,
  };
  harden(result);
  return result;
};
harden(setup);
