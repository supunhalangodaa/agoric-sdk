// @ts-check
/* global globalThis, WeakRef, FinalizationRegistry */

import fs from 'fs';
import path from 'path';
import process from 'process';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { spawn as ambientSpawn } from 'child_process';
import { type as osType } from 'os';
import { Worker } from 'worker_threads';
import anylogger from 'anylogger';
import microtime from 'microtime';

import { assert, details as X } from '@agoric/assert';
import { importBundle } from '@endo/import-bundle';
import { xsnap, recordXSnap } from '@agoric/xsnap';

import { QCLASS } from '@endo/marshal';
import { checkBundle } from '@endo/check-bundle/lite.js';
import { createSHA256 } from '../lib-nodejs/hasher.js';
import engineGC from '../lib-nodejs/engine-gc.js';
import { startSubprocessWorker } from '../lib-nodejs/spawnSubprocessWorker.js';
import { waitUntilQuiescent } from '../lib-nodejs/waitUntilQuiescent.js';
import { makeGcAndFinalize } from '../lib-nodejs/gc-and-finalize.js';
import { insistStorageAPI } from '../lib/storageAPI.js';
import { provideHostStorage } from './hostStorage.js';
import {
  buildKernelBundle,
  swingsetIsInitialized,
  initializeSwingset,
} from './initializeSwingset.js';

const NETSTRING_MAX_CHUNK_SIZE = 12_000_000;

/** @param {Uint8Array} bytes */
export function computeSha512(bytes) {
  const hash = crypto.createHash('sha512');
  hash.update(bytes);
  return hash.digest().toString('hex');
}

/** @param {string | ((args: unknown[]) => string)} tagOrTagCreator */
function makeConsole(tagOrTagCreator) {
  /** @type {(level: string) => (args: unknown[]) => void} */
  let makeLoggerForLevel;
  if (typeof tagOrTagCreator === 'function') {
    const tagToLogger = new Map();
    makeLoggerForLevel =
      level =>
      (...args) => {
        // Retrieve the logger from cache.
        const tag = tagOrTagCreator(args);
        let logger = tagToLogger.get(tag);
        if (!logger) {
          logger = anylogger(tag);
          tagToLogger.set(tag, logger);
        }
        // Actually log the message.
        return logger[level](...args);
      };
  } else {
    const logger = anylogger(tagOrTagCreator);
    makeLoggerForLevel = level => logger[level];
  }
  const cons = {};
  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    cons[level] = makeLoggerForLevel(level);
  }
  return harden(cons);
}

/**
 * @param {unknown} e
 * @param {Promise} pr
 */
function unhandledRejectionHandler(e, pr) {
  // Don't trigger sensitive hosts (like AVA).
  pr.catch(() => {});
  console.error('UnhandledPromiseRejectionWarning:', e);
}

/**
 * @param {{ moduleFormat: string, source: string }[]} bundles
 * @param {{
 *   snapStore?: SnapStore,
 *   spawn: typeof import('child_process').spawn
 *   env: Record<string, string | undefined>,
 * }} opts
 */
export function makeStartXSnap(bundles, { snapStore, env, spawn }) {
  /** @type { import('@agoric/xsnap/src/xsnap').XSnapOptions } */
  const xsnapOpts = {
    os: osType(),
    spawn,
    stdout: 'inherit',
    stderr: 'inherit',
    debug: !!env.XSNAP_DEBUG,
    netstringMaxChunkSize: NETSTRING_MAX_CHUNK_SIZE,
  };

  let doXSnap = xsnap;
  const { XSNAP_TEST_RECORD } = env;
  if (XSNAP_TEST_RECORD) {
    console.log('SwingSet xs-worker tracing:', { XSNAP_TEST_RECORD });
    let serial = 0;
    doXSnap = opts => {
      const workerTrace =
        path.resolve(`${XSNAP_TEST_RECORD}/${serial}`) + path.sep;
      serial += 1;
      fs.mkdirSync(workerTrace, { recursive: true });
      return recordXSnap(opts, workerTrace, {
        writeFileSync: fs.writeFileSync,
      });
    };
  }

  /**
   * @param {string} name
   * @param {(request: Uint8Array) => Promise<Uint8Array>} handleCommand
   * @param {boolean} [metered]
   * @param {string} [snapshotHash]
   */
  async function startXSnap(
    name,
    handleCommand,
    metered,
    snapshotHash = undefined,
  ) {
    const meterOpts = metered ? {} : { meteringLimit: 0 };
    if (snapStore && snapshotHash) {
      // console.log('startXSnap from', { snapshotHash });
      return snapStore.load(snapshotHash, async snapshot => {
        const xs = doXSnap({
          snapshot,
          name,
          handleCommand,
          ...meterOpts,
          ...xsnapOpts,
        });
        await xs.isReady();
        return xs;
      });
    }
    // console.log('fresh xsnap', { snapStore: snapStore });
    const worker = doXSnap({ handleCommand, name, ...meterOpts, ...xsnapOpts });

    for (const bundle of bundles) {
      bundle.moduleFormat === 'getExport' ||
        bundle.moduleFormat === 'nestedEvaluate' ||
        assert.fail(X`unexpected: ${bundle.moduleFormat}`);
      // eslint-disable-next-line no-await-in-loop, @jessie.js/no-nested-await
      await worker.evaluate(`(${bundle.source}\n)()`.trim());
    }
    return worker;
  }
  return startXSnap;
}

/**
 *
 * @param {HostStore} hostStorage
 * @param {Record<string, unknown>} deviceEndowments
 * @param {{
 *   verbose?: boolean,
 *   debugPrefix?: string,
 *   slogCallbacks?: unknown,
 *   slogSender?: import('@agoric/telemetry').SlogSender,
 *   testTrackDecref?: unknown,
 *   warehousePolicy?: { maxVatsOnline?: number },
 *   overrideVatManagerOptions?: unknown,
 *   spawn?: typeof import('child_process').spawn,
 *   env?: Record<string, string | undefined>,
 *   kernelBundle?: Bundle
 * }} runtimeOptions
 */
export async function makeSwingsetController(
  hostStorage = provideHostStorage(),
  deviceEndowments = {},
  runtimeOptions = {},
) {
  const kvStore = hostStorage.kvStore;
  insistStorageAPI(kvStore);

  // Use ambient process.env only if caller did not specify.
  const { env = process.env } = runtimeOptions;

  // build console early so we can add console.log to diagnose early problems
  const {
    verbose,
    debugPrefix = '',
    slogCallbacks,
    slogSender,
    spawn = ambientSpawn,
    warehousePolicy = {},
    overrideVatManagerOptions = {},
  } = runtimeOptions;
  if (typeof Compartment === 'undefined') {
    throw Error('SES must be installed before calling makeSwingsetController');
  }

  function writeSlogObject(obj) {
    if (!slogSender) {
      // Fast path; nothing to do.
      return;
    }

    // microtime gives POSIX gettimeofday() with microsecond resolution
    const time = microtime.nowDouble();
    // this is CLOCK_MONOTONIC, seconds since process start
    const monotime = performance.now() / 1000;

    // rearrange the fields a bit to make it more legible to humans
    const timedObj = { type: undefined, ...obj, time, monotime };

    // Allow the SwingSet host to do anything they want with slog messages.
    slogSender(timedObj);
  }

  // eslint-disable-next-line no-shadow
  const console = makeConsole(`${debugPrefix}SwingSet:controller`);
  // We can harden this 'console' because it's new, but if we were using the
  // original 'console' object (which has a unique prototype), we'd have to
  // harden(Object.getPrototypeOf(console));
  // see https://github.com/Agoric/SES-shim/issues/292 for details
  harden(console);

  writeSlogObject({ type: 'bundle-kernel-start' });
  // eslint-disable-next-line @jessie.js/no-nested-await
  const { kernelBundle = await buildKernelBundle() } = runtimeOptions;
  writeSlogObject({ type: 'bundle-kernel-finish' });

  // FIXME: Put this somewhere better.
  const handlers = process.listeners('unhandledRejection');
  let haveUnhandledRejectionHandler = false;
  for (const handler of handlers) {
    if (handler === unhandledRejectionHandler) {
      haveUnhandledRejectionHandler = true;
      break;
    }
  }
  if (!haveUnhandledRejectionHandler) {
    process.on('unhandledRejection', unhandledRejectionHandler);
  }

  function kernelRequire(what) {
    assert.fail(X`kernelRequire unprepared to satisfy require(${what})`);
  }
  writeSlogObject({ type: 'import-kernel-start' });
  const kernelNS = await importBundle(kernelBundle, {
    filePrefix: 'kernel/...',
    endowments: {
      console: makeConsole(`${debugPrefix}SwingSet:kernel`),
      assert,
      require: kernelRequire,
      URL: globalThis.Base64, // Unavailable only on XSnap
      Base64: globalThis.Base64, // Available only on XSnap
    },
  });
  const buildKernel = kernelNS.default;
  writeSlogObject({ type: 'import-kernel-finish' });

  // all vats get these in their global scope, plus a vat-specific 'console'
  const vatEndowments = harden({});

  // this launches a worker in a Node.js thread (aka "Worker")
  function makeNodeWorker() {
    const supercode = new URL(
      '../supervisors/nodeworker/supervisor-nodeworker.js',
      import.meta.url,
    ).pathname;
    return new Worker(supercode);
  }

  // launch a worker in a subprocess (which runs Node.js)
  function startSubprocessWorkerNode() {
    const supercode = new URL(
      '../supervisors/subprocess-node/supervisor-subprocess-node.js',
      import.meta.url,
    ).pathname;
    const args = [supercode];
    return startSubprocessWorker(process.execPath, args, {
      netsringMaxChunkSize: NETSTRING_MAX_CHUNK_SIZE,
    });
  }

  const bundles = [
    // @ts-expect-error assume lockdownBundle is set
    JSON.parse(kvStore.get('lockdownBundle')),
    // @ts-expect-error assume supervisorBundle is set
    JSON.parse(kvStore.get('supervisorBundle')),
  ];
  const startXSnap = makeStartXSnap(bundles, {
    snapStore: hostStorage.snapStore,
    env,
    spawn,
  });

  const kernelEndowments = {
    waitUntilQuiescent,
    hostStorage,
    debugPrefix,
    vatEndowments,
    makeConsole,
    makeNodeWorker,
    startSubprocessWorkerNode,
    startXSnap,
    slogCallbacks,
    writeSlogObject,
    WeakRef,
    FinalizationRegistry,
    gcAndFinalize: makeGcAndFinalize(engineGC),
    createSHA256,
  };

  const kernelRuntimeOptions = {
    verbose,
    warehousePolicy,
    overrideVatManagerOptions,
  };
  /** @type { ReturnType<typeof import('../kernel').default> } */
  const kernel = buildKernel(
    kernelEndowments,
    deviceEndowments,
    kernelRuntimeOptions,
  );

  if (runtimeOptions.verbose) {
    kernel.kdebugEnable(true);
  }

  await kernel.start();

  /**
   * @param {T} x
   * @returns {T}
   * @template T
   */
  const defensiveCopy = x => JSON.parse(JSON.stringify(x));

  /**
   * Validate and install a code bundle.
   *
   * @param {EndoZipBase64Bundle} bundle
   * @param {BundleID} [allegedBundleID]
   * @returns {Promise<BundleID>}
   */
  async function validateAndInstallBundle(bundle, allegedBundleID) {
    // TODO The following assertion may be removed when checkBundle subsumes
    // the responsibility to verify the permanence of a bundle's properties.
    // https://github.com/endojs/endo/issues/1106
    assert(
      Object.values(Object.getOwnPropertyDescriptors(bundle)).every(
        descriptor =>
          descriptor.get === undefined &&
          descriptor.writable === false &&
          descriptor.configurable === false &&
          typeof descriptor.value === 'string',
      ),
      `Bundle with alleged ID ${allegedBundleID} must be a frozen object with only string value properties, no accessors`,
    );
    await checkBundle(bundle, computeSha512, allegedBundleID);
    const { endoZipBase64Sha512 } = bundle;
    assert.typeof(endoZipBase64Sha512, 'string');
    const bundleID = `b1-${endoZipBase64Sha512}`;
    if (allegedBundleID !== undefined) {
      assert.equal(
        bundleID,
        allegedBundleID,
        `alleged bundleID ${allegedBundleID} does not match actual ${bundleID}`,
      );
    }
    await kernel.installBundle(bundleID, bundle);
    return bundleID;
  }

  // the kernel won't leak our objects into the Vats, we must do
  // the same in this wrapper
  const controller = harden({
    log(str) {
      kernel.log(str);
    },

    writeSlogObject,

    dump() {
      return defensiveCopy(kernel.dump());
    },

    verboseDebugMode(flag) {
      kernel.kdebugEnable(flag);
    },

    validateAndInstallBundle,

    async run(policy) {
      return kernel.run(policy);
    },

    async step() {
      return kernel.step();
    },

    async shutdown() {
      return kernel.shutdown();
    },

    changeKernelOptions(options) {
      kernel.changeKernelOptions(options);
    },

    getStats() {
      return defensiveCopy(kernel.getStats());
    },

    getStatus() {
      return defensiveCopy(kernel.getStatus());
    },

    getActivityhash() {
      return kernel.getActivityhash();
    },

    // everything beyond here is for tests, and everything should be migrated
    // to be on this 'debug' object to make that clear

    debug: {
      addDeviceHook: kernel.addDeviceHook,
    },

    pinVatRoot(vatName) {
      const vatID = kernel.vatNameToID(vatName);
      const kref = kernel.getRootObject(vatID);
      kernel.pinObject(kref);
      return kref;
    },

    kpStatus(kpid) {
      return kernel.kpStatus(kpid);
    },

    kpResolution(kpid) {
      return kernel.kpResolution(kpid);
    },
    vatNameToID(vatName) {
      return kernel.vatNameToID(vatName);
    },
    deviceNameToID(deviceName) {
      return kernel.deviceNameToID(deviceName);
    },

    /**
     * @param {string} vatName
     * @param {string} method
     * @param {unknown[]} args
     * @param {ResolutionPolicy} resultPolicy
     * @param {string[]} [slots]
     */
    queueToVatRoot(
      vatName,
      method,
      args = [],
      resultPolicy = 'ignore',
      slots = [],
    ) {
      function replacer(_, arg) {
        if (typeof arg === 'bigint') {
          return { [QCLASS]: 'bigint', digits: String(arg) };
        }
        if (arg === undefined) {
          return { [QCLASS]: 'undefined' };
        }
        return arg;
      }

      const vatID = kernel.vatNameToID(vatName);
      assert.typeof(method, 'string');
      const kref = kernel.getRootObject(vatID);
      const methargs = {
        body: JSON.stringify([method, args], replacer),
        slots,
      };
      const kpid = kernel.queueToKref(kref, methargs, resultPolicy);
      if (kpid) {
        kernel.kpRegisterInterest(kpid);
      }
      return kpid;
    },

    upgradeStaticVat(vatName, shouldPauseFirst, bundleID, options = {}) {
      const vatID = kernel.vatNameToID(vatName);
      let pauseTargetBody = null;
      let pauseTargetSlots = [];
      if (shouldPauseFirst) {
        pauseTargetBody = { [QCLASS]: 'slot', index: 0 };
        pauseTargetSlots = [kernel.getRootObject(vatID)];
      }
      if (!options.upgradeMessage) {
        options.upgradeMessage = `vat ${vatName} upgraded`;
      }
      return controller.queueToVatRoot(
        'vatAdmin',
        'upgradeStaticVat',
        [vatID, pauseTargetBody, bundleID, options],
        'ignore',
        pauseTargetSlots,
      );
    },
  });

  return controller;
}

/**
 * NB: To be used only in tests. An app with this may not survive a reboot.
 *
 * This helper makes Swingset controllers and automatically initializes the
 * SwingSet if it isn't already. It will not work for use cases that need to
 * configure devices.
 *
 * The official API does these as two separate steps because the two sometimes
 * need to happen at different times.  In particular, sometimes you need the
 * host to be able to control whether or not to initialize independent of the
 * SwingSet's history.  Also sometimes you want different runtime options for
 * the two stages; this can happen, for example, in some debugging cases.
 *
 * @param {SwingSetConfig} config
 * @param {string[]} argv
 * @param {{
 *   hostStorage?: HostStore;
 *   env?: Record<string, string>;
 *   verbose?: boolean;
 *   kernelBundles?: Record<string, Bundle>;
 *   debugPrefix?: string;
 *   slogCallbacks?: unknown;
 *   slogSender?: import('@agoric/telemetry').SlogSender;
 *   testTrackDecref?: unknown;
 *    warehousePolicy?: { maxVatsOnline?: number };
 * }} runtimeOptions
 * @typedef { import('@agoric/swing-store').KVStore } KVStore
 */
export async function buildVatController(
  config,
  argv = [],
  runtimeOptions = {},
) {
  const {
    hostStorage = provideHostStorage(),
    env,
    verbose,
    kernelBundles: kernelAndOtherBundles = {},
    debugPrefix,
    slogCallbacks,
    warehousePolicy,
    slogSender,
  } = runtimeOptions;
  const { kernel: kernelBundle, ...otherBundles } = kernelAndOtherBundles;
  const kernelBundles = runtimeOptions.kernelBundles ? otherBundles : undefined;

  const actualRuntimeOptions = {
    env,
    verbose,
    debugPrefix,
    slogCallbacks,
    warehousePolicy,
    slogSender,
    kernelBundle,
  };
  const initializationOptions = { verbose, kernelBundles };
  let bootstrapResult;
  if (!swingsetIsInitialized(hostStorage)) {
    // eslint-disable-next-line @jessie.js/no-nested-await
    bootstrapResult = await initializeSwingset(
      config,
      argv,
      hostStorage,
      initializationOptions,
      runtimeOptions,
    );
  }
  const controller = await makeSwingsetController(
    hostStorage,
    {},
    actualRuntimeOptions,
  );
  return harden({ bootstrapResult, ...controller });
}
