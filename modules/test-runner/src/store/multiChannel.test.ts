import {
  Address,
  Bytes32,
  ConditionalTransferTypes,
  CONVENTION_FOR_ETH_ASSET_ID,
  EventNames,
  GraphReceipt,
  IConnextClient,
  PublicParams,
} from "@connext/types";
import { getFileStore } from "@connext/store";
import { ConnextClient } from "@connext/client";
import {
  abrv,
  ChannelSigner,
  getRandomBytes32,
  getRandomPrivateKey,
  getTestGraphReceiptToSign,
  getTestVerifyingContract,
  signGraphReceiptMessage,
  toBN,
} from "@connext/utils";
import { Sequelize } from "sequelize";
import { BigNumber } from "ethers";

import {
  createClient,
  env,
  ETH_AMOUNT_MD,
  ethProviderUrl,
  expect,
  fundChannel,
  getTestLoggers,
} from "../util";

// NOTE: group correct number of promises associated with a payment.
// there is no validation done to ensure the events correspond to the payments,
// or to ensure that the event payloads are correct.

const registerFailureListeners = (reject: any, sender: ConnextClient, recipient: ConnextClient) => {
  recipient.on(EventNames.PROPOSE_INSTALL_FAILED_EVENT, reject);
  sender.on(EventNames.PROPOSE_INSTALL_FAILED_EVENT, reject);
  recipient.on(EventNames.INSTALL_FAILED_EVENT, reject);
  sender.on(EventNames.INSTALL_FAILED_EVENT, reject);
  recipient.on(EventNames.UPDATE_STATE_FAILED_EVENT, reject);
  sender.on(EventNames.UPDATE_STATE_FAILED_EVENT, reject);
  recipient.on(EventNames.UNINSTALL_FAILED_EVENT, reject);
  sender.on(EventNames.UNINSTALL_FAILED_EVENT, reject);
  recipient.on(EventNames.CONDITIONAL_TRANSFER_FAILED_EVENT, reject);
  sender.on(EventNames.CONDITIONAL_TRANSFER_FAILED_EVENT, reject);
};

const performConditionalTransfer = async (params: {
  ASSET: string;
  TRANSFER_AMT: BigNumber;
  conditionType: ConditionalTransferTypes;
  sender: IConnextClient;
  recipient: IConnextClient;
  chainId?: number;
  verifyingContract?: Address;
  requestCID?: Bytes32;
  subgraphDeploymentID?: Bytes32;
  paymentId?: string;
  secret?: string; // preimage for linked
  meta?: any;
}): Promise<[string, string]> => {
  const {
    ASSET,
    TRANSFER_AMT,
    sender,
    recipient,
    conditionType,
    chainId,
    verifyingContract,
    requestCID,
    subgraphDeploymentID,
    paymentId,
    secret,
    meta,
  } = params;
  let TRANSFER_PARAMS;
  const baseParams = {
    conditionType,
    amount: TRANSFER_AMT,
    assetId: ASSET,
    paymentId: paymentId || getRandomBytes32(),
    recipient: recipient.publicIdentifier,
    meta,
  };
  const networkContext = await sender.ethProvider.getNetwork();
  const receipt = getTestGraphReceiptToSign();
  switch (conditionType) {
    case ConditionalTransferTypes.LinkedTransfer: {
      TRANSFER_PARAMS = {
        ...baseParams,
        preImage: secret || getRandomBytes32(),
      } as PublicParams.LinkedTransfer;
      break;
    }
    case ConditionalTransferTypes.HashLockTransfer: {
      throw new Error(`Test util not yet configured for hashlock transfer`);
    }
    case ConditionalTransferTypes.GraphTransfer: {
      TRANSFER_PARAMS = {
        ...baseParams,
        signerAddress: recipient.signerAddress,
        chainId: chainId || networkContext.chainId,
        verifyingContract: verifyingContract || getTestVerifyingContract(),
        requestCID: requestCID || receipt.requestCID,
        subgraphDeploymentID: subgraphDeploymentID || receipt.subgraphDeploymentID,
      } as PublicParams.SignedTransfer;
      break;
    }
    case ConditionalTransferTypes.SignedTransfer: {
      throw new Error(`Test util not yet configured for signed transfer`);
    }
  }

  // send transfers from sender to recipient
  const [senderResponse] = await Promise.all([
    new Promise(async (resolve, reject) => {
      sender.once(EventNames.CONDITIONAL_TRANSFER_FAILED_EVENT, () => reject());
      try {
        const res = await sender.conditionalTransfer(TRANSFER_PARAMS);
        return resolve(res);
      } catch (e) {
        return reject(e.message);
      }
    }),
    new Promise((resolve, reject) => {
      recipient.once(EventNames.CONDITIONAL_TRANSFER_UNLOCKED_EVENT, (data) => {
        return resolve(data);
      });
      recipient.once(EventNames.CONDITIONAL_TRANSFER_FAILED_EVENT, () => reject());
    }),
    new Promise((resolve) => {
      sender.once(EventNames.CONDITIONAL_TRANSFER_UNLOCKED_EVENT, (data) => {
        return resolve(data);
      });
    }),
  ]);

  // preimage is undefined for signed transfers
  const { preImage, paymentId: responsePaymentId } = senderResponse as any;

  return [responsePaymentId, preImage] as [string, string];
};

const name = "Multichannel Store";
const { log, timeElapsed } = getTestLoggers(name);
describe(name, () => {
  let chainId: number;
  let initialRecipientFb: { [x: string]: BigNumber };
  let initialSenderFb: { [x: string]: string | BigNumber };
  let receipt: GraphReceipt;
  let recipient: ConnextClient;
  let recipientKey: string;
  let recipientSigner: ChannelSigner;
  let sender: ConnextClient;
  let senderKey: string;
  let senderSigner: ChannelSigner;
  let start: number;
  let verifyingContract: Address;

  const DEPOSIT_AMT = ETH_AMOUNT_MD;
  const ASSET = CONVENTION_FOR_ETH_ASSET_ID;

  beforeEach(async () => {
    start = Date.now();
    senderKey = getRandomPrivateKey();
    recipientKey = getRandomPrivateKey();
    senderSigner = new ChannelSigner(senderKey, ethProviderUrl);
    recipientSigner = new ChannelSigner(recipientKey, ethProviderUrl);
    const sequelize = new Sequelize(`sqlite:${env.storeDir}/store.sqlite`, { logging: false });
    // create stores with same sequelize instance but with different prefixes
    const senderStore = getFileStore(
      env.storeDir,
      { sequelize, prefix: senderSigner.publicIdentifier },
    );
    const recipientStore = getFileStore(
      env.storeDir,
      { sequelize, prefix: recipientSigner.publicIdentifier },
    );
    // create clients with shared store
    sender = (await createClient({
      signer: senderSigner,
      store: senderStore,
      id: "S",
    })) as ConnextClient;
    recipient = (await createClient({
      signer: recipientSigner,
      store: recipientStore,
      id: "R",
    })) as ConnextClient;
    receipt = getTestGraphReceiptToSign();
    chainId = (await sender.ethProvider.getNetwork()).chainId;
    verifyingContract = getTestVerifyingContract();
    await fundChannel(sender, DEPOSIT_AMT, ASSET);
    initialSenderFb = await sender.getFreeBalance(ASSET);
    initialRecipientFb = await recipient.getFreeBalance(ASSET);
    timeElapsed("beforeEach complete", start);
  });

  afterEach(async () => {
    await sender.messaging.disconnect();
    await recipient.messaging.disconnect();
    // clear stores
    await sender.store.clear();
    await recipient.store.clear();
  });

  it("should work when clients share the same sequelize instance with a different prefix (1 linked payment sent)", async () => {
    // establish tests constants
    const TRANSFER_AMT = toBN(100);

    await performConditionalTransfer({
      conditionType: ConditionalTransferTypes.LinkedTransfer,
      sender,
      recipient,
      ASSET,
      TRANSFER_AMT,
    });

    // verify transfer amounts
    const finalSenderFb = await sender.getFreeBalance(ASSET);
    const finalRecipientFb = await recipient.getFreeBalance(ASSET);
    expect(finalSenderFb[sender.signerAddress]).to.be.eq(
      initialSenderFb[sender.signerAddress].sub(TRANSFER_AMT),
    );
    expect(finalRecipientFb[recipient.signerAddress]).to.be.eq(
      initialRecipientFb[recipient.signerAddress].add(TRANSFER_AMT),
    );
  });

  it("should work when clients share the same sequelize instance with a different prefix (1 signed transfer payment sent)", async () => {
    // establish tests constants
    const TRANSFER_AMT = toBN(100);

    // register listener to resolve payment
    recipient.once(EventNames.CONDITIONAL_TRANSFER_CREATED_EVENT, async (payload) => {
      const signature = await signGraphReceiptMessage(
        receipt,
        chainId,
        verifyingContract,
        recipientKey,
      );

      await recipient.resolveCondition({
        conditionType: ConditionalTransferTypes.GraphTransfer,
        paymentId: payload.paymentId,
        responseCID: receipt.responseCID,
        signature,
      } as PublicParams.ResolveGraphTransfer);
    });

    await performConditionalTransfer({
      conditionType: ConditionalTransferTypes.GraphTransfer,
      sender,
      chainId,
      verifyingContract,
      requestCID: receipt.requestCID,
      subgraphDeploymentID: receipt.subgraphDeploymentID,
      recipient,
      ASSET,
      TRANSFER_AMT,
    });

    // verify transfer amounts
    const finalSenderFb = await sender.getFreeBalance(ASSET);
    const finalRecipientFb = await recipient.getFreeBalance(ASSET);
    expect(finalSenderFb[sender.signerAddress]).to.be.eq(
      initialSenderFb[sender.signerAddress].sub(TRANSFER_AMT),
    );
    expect(finalRecipientFb[recipient.signerAddress]).to.be.eq(
      initialRecipientFb[recipient.signerAddress].add(TRANSFER_AMT),
    );
  });

  it("should work when clients share the same sequelize instance with a different prefix (many linked payments sent)", async () => {
    // establish tests constants
    const TRANSFER_AMT = toBN(100);
    const MIN_TRANSFERS = 25;
    const TRANSFER_INTERVAL = 1000; // ms between consecutive transfer calls

    let receivedTransfers = 0;
    let intervals = 0;
    let pollerError: string | undefined;

    // call transfers on interval
    const start = Date.now();
    const interval = setInterval(async () => {
      intervals += 1;
      if (intervals > MIN_TRANSFERS) {
        clearInterval(interval);
        return;
      }
      let error: any = undefined;
      try {
        const [, preImage] = await performConditionalTransfer({
          conditionType: ConditionalTransferTypes.LinkedTransfer,
          sender,
          recipient,
          ASSET,
          TRANSFER_AMT,
        });
        log.info(`[${intervals}/${MIN_TRANSFERS}] preImage: ${preImage}`);
      } catch (e) {
        error = e;
      }
      if (error) {
        clearInterval(interval);
        throw error;
      }
    }, TRANSFER_INTERVAL);

    // setup promise to properly wait out the transfers / stop interval
    // will also periodically check if a poller error has been set and reject
    await new Promise((resolve, reject) => {
      registerFailureListeners(reject, sender, recipient);
      // setup listeners (increment on reclaim)
      recipient.on(EventNames.CONDITIONAL_TRANSFER_UNLOCKED_EVENT, () => {
        receivedTransfers += 1;
        log.info(`[${receivedTransfers}/${MIN_TRANSFERS}] redeemed`);
        if (receivedTransfers >= MIN_TRANSFERS) {
          resolve();
        }
      });
      recipient.on(EventNames.CONDITIONAL_TRANSFER_FAILED_EVENT, reject);
      sender.on(EventNames.CONDITIONAL_TRANSFER_FAILED_EVENT, reject);

      // register a check to see if the poller has been cleared
      setInterval(() => {
        if (pollerError) {
          reject(pollerError);
        }
      }, 250);
    });
    const end = Date.now();
    log.info(
      `Average latency of ${MIN_TRANSFERS} transfers: ${(end - start) / MIN_TRANSFERS}ms`,
    );

    expect(receivedTransfers).to.be.eq(MIN_TRANSFERS);
    const finalSenderFb = await sender.getFreeBalance(ASSET);
    const finalRecipientFb = await recipient.getFreeBalance(ASSET);
    expect(finalSenderFb[sender.signerAddress]).to.be.eq(
      initialSenderFb[sender.signerAddress].sub(TRANSFER_AMT.mul(receivedTransfers)),
    );
    expect(finalRecipientFb[recipient.signerAddress]).to.be.eq(
      initialRecipientFb[recipient.signerAddress].add(TRANSFER_AMT.mul(receivedTransfers)),
    );
  });

  it("should work when clients share the same sequelize instance with a different prefix (many payments sent)", async () => {
    // establish tests constants
    const TRANSFER_AMT = toBN(100);
    const MIN_TRANSFERS = 25;
    const TRANSFER_INTERVAL = 1000; // ms between consecutive transfer calls

    let receivedTransfers = 0;
    let intervals = 0;

    const { chainId } = await sender.ethProvider.getNetwork();

    recipient.on(EventNames.CONDITIONAL_TRANSFER_CREATED_EVENT, async (payload) => {
      log.info(`[${receivedTransfers}/${MIN_TRANSFERS}] Received transfer ${abrv(payload.paymentId)}`);
      const signature = await signGraphReceiptMessage(
        receipt,
        chainId,
        verifyingContract,
        recipientKey,
      );
      await recipient.resolveCondition({
        conditionType: ConditionalTransferTypes.GraphTransfer,
        paymentId: payload.paymentId,
        responseCID: receipt.responseCID,
        signature,
      } as PublicParams.ResolveGraphTransfer);
      log.info(`Resolved signed transfer: ${payload.paymentId}`);
    });

    // call transfers on interval
    const start = Date.now();
    const interval = setInterval(async () => {
      log.warn("heartbeat thump thump thump");
      intervals += 1;
      if (intervals > MIN_TRANSFERS) {
        clearInterval(interval);
        return;
      }
      try {
        const paymentId = getRandomBytes32();
        await sender.conditionalTransfer({
          amount: TRANSFER_AMT,
          paymentId,
          conditionType: ConditionalTransferTypes.GraphTransfer,
          signerAddress: recipient.signerAddress,
          chainId,
          verifyingContract,
          requestCID: receipt.requestCID,
          subgraphDeploymentID: receipt.subgraphDeploymentID,
          assetId: ASSET,
          recipient: recipient.publicIdentifier,
        } as PublicParams.GraphTransfer);
        log.info(`[${intervals}/${MIN_TRANSFERS}] Sent transfer with paymentId ${abrv(paymentId)}`);
      } catch (e) {
        clearInterval(interval);
        throw e;
      }
    }, TRANSFER_INTERVAL);

    // setup promise to properly wait out the transfers / stop interval
    // will also periodically check if a poller error has been set and reject
    await new Promise((resolve, reject) => {
      registerFailureListeners(reject, sender, recipient);
      // setup listeners (increment on reclaim)
      recipient.on(EventNames.CONDITIONAL_TRANSFER_UNLOCKED_EVENT, async (msg) => {
        receivedTransfers += 1;
        log.info(`[${receivedTransfers}/${MIN_TRANSFERS}] Unlocked transfer with payment Id: ${abrv(msg.paymentId)}`);
        if (receivedTransfers >= MIN_TRANSFERS) {
          resolve();
        }
      });
    });
    const end = Date.now();
    log.info(
      `Average latency of ${MIN_TRANSFERS} transfers: ${(end - start) / MIN_TRANSFERS}ms`,
    );

    expect(receivedTransfers).to.be.eq(MIN_TRANSFERS);
    const finalSenderFb = await sender.getFreeBalance(ASSET);
    const finalRecipientFb = await recipient.getFreeBalance(ASSET);
    expect(finalSenderFb[sender.signerAddress]).to.be.eq(
      initialSenderFb[sender.signerAddress].sub(TRANSFER_AMT.mul(receivedTransfers)),
    );
    expect(finalRecipientFb[recipient.signerAddress]).to.be.eq(
      initialRecipientFb[recipient.signerAddress].add(TRANSFER_AMT.mul(receivedTransfers)),
    );
  });
});