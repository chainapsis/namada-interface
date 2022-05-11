import { createAsyncThunk, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { Config } from "config";
import { FAUCET_ADDRESS, Tokens, TokenType, TxResponse } from "constants/";
import { RpcClient, SocketClient, Transfer } from "lib";
import { NewBlockEvents } from "lib/rpc/types";
import { amountFromMicro, promiseWithTimeout } from "utils/helpers";
import { DerivedAccount, fetchBalanceByAccount } from "./accounts";

enum TransferType {
  IBC = "IBC",
  Shielded = "Shielded",
  NonShielded = "Non-Shielded",
}

export type TransferTransaction = {
  source: string;
  target: string;
  type: TransferType;
  amount: number;
  height: number;
  tokenType: TokenType;
  gas: number;
  appliedHash: string;
  memo: string;
  timestamp: number;
};

type TransferEvents = {
  gas: number;
  appliedHash: string;
};

export type TransfersState = {
  transactions: TransferTransaction[];
  isTransferSubmitting: boolean;
  transferError?: string;
  events?: TransferEvents;
};

const TRANSFERS_ACTIONS_BASE = "transfers";

enum TransfersThunkActions {
  SubmitTransferTransaction = "submitTransferTransaction",
}

const { network, wsNetwork } = new Config();
const rpcClient = new RpcClient(network);
const socketClient = new SocketClient(wsNetwork);

type TxTransferArgs = {
  account: DerivedAccount;
  target: string;
  amount: number;
  memo: string;
  shielded: boolean;
  useFaucet?: boolean;
};

const LEDGER_TRANSFER_TIMEOUT = 10000;

export const submitTransferTransaction = createAsyncThunk(
  `${TRANSFERS_ACTIONS_BASE}/${TransfersThunkActions.SubmitTransferTransaction}`,
  async (
    { account, target, amount, memo, shielded, useFaucet }: TxTransferArgs,
    { dispatch, rejectWithValue }
  ) => {
    const {
      id,
      establishedAddress = "",
      tokenType,
      signingKey: privateKey,
    } = account;

    const source = useFaucet ? FAUCET_ADDRESS : establishedAddress;

    const epoch = await rpcClient.queryEpoch();
    const transfer = await new Transfer().init();
    const token = Tokens[tokenType];

    const { hash, bytes } = await transfer.makeTransfer({
      source,
      target,
      token: token.address || "",
      amount,
      epoch,
      privateKey,
    });

    const { promise, timeoutId } = promiseWithTimeout<NewBlockEvents>(
      new Promise(async (resolve) => {
        await socketClient.broadcastTx(bytes);
        const events = await socketClient.subscribeNewBlock(hash);
        resolve(events);
      }),
      LEDGER_TRANSFER_TIMEOUT,
      `Async actions timed out when communicating with ledger after ${
        LEDGER_TRANSFER_TIMEOUT / 1000
      } seconds`
    );

    promise.catch((e) => {
      socketClient.disconnect();
      rejectWithValue(e);
    });

    const events = await promise;
    socketClient.disconnect();
    clearTimeout(timeoutId);

    const gas = amountFromMicro(parseInt(events[TxResponse.GasUsed][0]));
    const appliedHash = events[TxResponse.Hash][0];
    const height = parseInt(events[TxResponse.Height][0]);

    dispatch(fetchBalanceByAccount(account));

    return {
      id,
      useFaucet,
      transaction: {
        source,
        target,
        appliedHash,
        tokenType,
        amount,
        memo,
        gas,
        height,
        timestamp: new Date().getTime(),
        type: shielded ? TransferType.Shielded : TransferType.NonShielded,
      },
    };
  }
);

const initialState: TransfersState = {
  transactions: [],
  isTransferSubmitting: false,
};

const transfersSlice = createSlice({
  name: TRANSFERS_ACTIONS_BASE,
  initialState,
  reducers: {
    clearEvents: (state) => {
      state.events = undefined;
      state.isTransferSubmitting = false;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(submitTransferTransaction.pending, (state) => {
      state.isTransferSubmitting = true;
      state.transferError = undefined;
      state.events = undefined;
    });

    builder.addCase(submitTransferTransaction.rejected, (state, action) => {
      const { error } = action;
      state.isTransferSubmitting = false;
      state.transferError = error.message;
      state.events = undefined;
    });

    builder.addCase(
      submitTransferTransaction.fulfilled,
      (
        state,
        action: PayloadAction<{
          id: string;
          useFaucet: boolean | undefined;
          transaction: TransferTransaction;
        }>
      ) => {
        const { useFaucet, transaction } = action.payload;
        const { gas, appliedHash } = transaction;

        state.isTransferSubmitting = false;
        state.transferError = undefined;

        state.events = !useFaucet
          ? {
              gas,
              appliedHash,
            }
          : undefined;

        state.transactions.push(transaction);
      }
    );
  },
});

const { actions, reducer } = transfersSlice;
export const { clearEvents } = actions;
export default reducer;
