import { makeFollower, makeLeader } from '@agoric/casting';
import { observeIterator } from '@agoric/notifier';
import { NO_SMART_WALLET_ERROR } from '@agoric/smart-wallet/src/utils';
import { makeImportContext } from '@agoric/wallet/api/src/marshal-contexts';
import MuiAlert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import React, { useEffect, useState } from 'react';

import {
  ConnectionStatus,
  withApplicationContext,
} from '../contexts/Application';
import { bridgeStorageMessages } from '../util/BridgeStorage';
import { SmartConnectionMethod } from '../util/connections';
import {
  makeBackendFromWalletBridge,
  makeWalletBridgeFromFollower,
} from '../util/WalletBackendAdapter';
import ProvisionDialog from './ProvisionDialog';

const Alert = React.forwardRef(function Alert({ children, ...props }, ref) {
  return (
    <MuiAlert elevation={6} ref={ref} variant="filled" {...props}>
      {children}
    </MuiAlert>
  );
});

const SmartWalletConnection = ({
  connectionConfig,
  setConnectionStatus,
  setBackend,
  setBackendErrorHandler,
  keplrConnection,
}) => {
  const [snackbarMessages, setSnackbarMessages] = useState([]);
  const [provisionDialogOpen, setProvisionDialogOpen] = useState(false);

  const onProvisionDialogClose = () => {
    setProvisionDialogOpen(false);
  };

  const handleSnackbarClose = (_, reason) => {
    if (reason === 'clickaway') {
      return;
    }

    setSnackbarMessages(sm => sm.slice(1));
  };

  const showError = (message, e, severity = 'error') => {
    if (e) {
      console.error(`${message}:`, e);
      message += `: ${e.message}`;
    }
    if (severity === 'error') {
      setConnectionStatus(ConnectionStatus.Error);
    }
    setSnackbarMessages(sm => [...sm, { severity, message }]);
  };

  const { href, smartConnectionMethod } = connectionConfig;

  const publicAddress = (() => {
    if (
      smartConnectionMethod === SmartConnectionMethod.KEPLR &&
      keplrConnection
    ) {
      return keplrConnection.address;
    } else if (smartConnectionMethod === SmartConnectionMethod.READ_ONLY) {
      return connectionConfig.publicAddress;
    }
    return undefined;
  })();

  const backendError = e => {
    if (e.message === NO_SMART_WALLET_ERROR) {
      setProvisionDialogOpen(true);
      setConnectionStatus(ConnectionStatus.Error);
    } else {
      setBackend(null);
      showError('Error in wallet backend', e);
    }
  };

  useEffect(() => {
    if (
      !connectionConfig ||
      (connectionConfig.smartConnectionMethod === SmartConnectionMethod.KEPLR &&
        !keplrConnection)
    ) {
      return undefined;
    }

    let cancelIterator;
    let cleanupStorageBridge;

    const follow = async () => {
      const context = makeImportContext();
      const leader = makeLeader(href);
      const follower = makeFollower(
        `:published.wallet.${publicAddress}`,
        leader,
        { unserializer: context.fromMyWallet },
      );
      // TODO try making a smart-wallet version of this
      const bridge = makeWalletBridgeFromFollower(
        follower,
        leader,
        context.fromBoard,
        publicAddress,
        keplrConnection,
        href,
        backendError,
        () => {
          setConnectionStatus(ConnectionStatus.Connected);
          setProvisionDialogOpen(false);
        },
      );
      const { backendIt, cancel } = makeBackendFromWalletBridge(bridge);
      cleanupStorageBridge = bridgeStorageMessages(bridge);
      cancelIterator = cancel;
      // Need to thunk the error handler, or it gets called immediately.
      setBackendErrorHandler(() => backendError);
      return observeIterator(backendIt, {
        updateState: be => {
          cancelIterator && setBackend(be);
        },
        fail: e => {
          cancelIterator && backendError(e);
        },
        finish: be => {
          cancelIterator && setBackend(be);
        },
      });
    };
    follow().catch(e => showError('Cannot read Smart Wallet casting', e));

    return () => {
      cancelIterator && cancelIterator();
      cancelIterator = undefined;
      cleanupStorageBridge && cleanupStorageBridge();
      cleanupStorageBridge = undefined;
    };
  }, [connectionConfig, keplrConnection]);

  return (
    <div>
      <Snackbar open={snackbarMessages.length > 0}>
        <Alert
          onClose={handleSnackbarClose}
          severity={snackbarMessages[0]?.severity}
          sx={{ width: '100%' }}
        >
          {snackbarMessages[0]?.message}
        </Alert>
      </Snackbar>
      <ProvisionDialog
        open={provisionDialogOpen}
        onClose={onProvisionDialogClose}
        address={publicAddress}
        href={href}
      />
    </div>
  );
};

export default withApplicationContext(SmartWalletConnection, context => ({
  connectionConfig: context.connectionConfig,
  setConnectionStatus: context.setConnectionStatus,
  setBackend: context.setBackend,
  setBackendErrorHandler: context.setBackendErrorHandler,
  keplrConnection: context.keplrConnection,
}));
