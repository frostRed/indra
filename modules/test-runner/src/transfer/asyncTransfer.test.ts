/* global before after */
import { utils } from "@connext/client";
import { IConnextClient, LINKED_TRANSFER_TO_RECIPIENT, toBN } from "@connext/types";
import { ContractFactory, Wallet } from "ethers";
import { AddressZero } from "ethers/constants";
import { HDNode, hexlify, randomBytes } from "ethers/utils";
import tokenArtifacts from "@openzeppelin/contracts/build/contracts/ERC20Mintable.json";

import {
  AssetOptions,
  asyncTransferAsset,
  createClient,
  env,
  ETH_AMOUNT_LG,
  ETH_AMOUNT_MD,
  ETH_AMOUNT_SM,
  ethProvider,
  expect,
  fundChannel,
  FUNDED_MNEMONICS,
  TOKEN_AMOUNT,
  requestCollateral,
  Logger,
  delay,
  withdrawFromChannel,
  ZERO_ZERO_TWO_ETH,
  ZERO_ZERO_ONE_ETH,
} from "../util";
import { connectNats, closeNats } from "../util/nats";
import { Client } from "ts-nats";

const { xpubToAddress } = utils;
const log = new Logger("AsyncTransfers", env.logLevel);

describe("Async Transfers", () => {
  let clientA: IConnextClient;
  let clientB: IConnextClient;
  let tokenAddress: string;
  let nats: Client;

  before(async () => {
    nats = await connectNats();
  });

  beforeEach(async () => {
    clientA = await createClient();
    clientB = await createClient();
    tokenAddress = clientA.config.contractAddresses.Token;
  });

  afterEach(async () => {
    await clientA.messaging.disconnect();
    await clientB.messaging.disconnect();
  });

  after(() => {
    closeNats();
  });

  it("happy case: client A transfers eth to client B through node", async () => {
    const transfer: AssetOptions = { amount: ETH_AMOUNT_SM, assetId: AddressZero };
    await fundChannel(clientA, transfer.amount, transfer.assetId);
    await requestCollateral(clientB, transfer.assetId);
    await asyncTransferAsset(clientA, clientB, transfer.amount, transfer.assetId, nats);
  });

  it("happy case: client A transfers tokens to client B through node", async () => {
    const transfer: AssetOptions = { amount: TOKEN_AMOUNT, assetId: tokenAddress };
    await fundChannel(clientA, transfer.amount, transfer.assetId);
    await clientB.requestCollateral(transfer.assetId);
    await asyncTransferAsset(clientA, clientB, transfer.amount, transfer.assetId, nats);
  });

  it.only("latency test: deposit, collateralize, transfer, transfer, withdraw", async () => {
    const transfer: AssetOptions = { amount: ETH_AMOUNT_SM, assetId: AddressZero };

    let start = Date.now();
    log.info(`Depositing into channel`);
    await fundChannel(clientA, ETH_AMOUNT_MD, transfer.assetId);

    log.info(`Requesting collateral after ${Date.now() - start}ms`);
    start = Date.now();
    await requestCollateral(clientB, transfer.assetId);

    log.info(`${new Date().toISOString()} [TestRunner] start transfers`);

    log.info(`Starting first transfer after ${Date.now() - start}ms`);
    start = Date.now();
    await asyncTransferAsset(clientA, clientB, transfer.amount, transfer.assetId, nats);

    log.info(`Starting second transfer after ${Date.now() - start}ms`);
    start = Date.now();

    await asyncTransferAsset(clientA, clientB, transfer.amount, transfer.assetId, nats);

    log.info(`Starting withdrawal after ${Date.now() - start}ms`);
    start = Date.now();

    await withdrawFromChannel(clientA, ZERO_ZERO_ONE_ETH, AddressZero, true);

    /*
    return new Promise(async res => {
      // @ts-ignore
      this.timeout(1200000);
      const transfer: AssetOptions = { amount: ETH_AMOUNT_SM, assetId: AddressZero };
      await fundChannel(clientA, transfer.amount, transfer.assetId);
      await requestCollateral(clientB, transfer.assetId);
      let startTime: number[] = [];
      let y = 0;
      clientB.on("RECEIVE_TRANSFER_FINISHED_EVENT", data => {
        // log.info(data)
        const duration = Date.now() - startTime[data.meta.index];
        log.info("Caught #: " + y + ". Index: " + data.meta.index + ". Time: " + duration / 1000);
        log.info("===========================");
        y++;
        if (y === 5) {
          res();
        }
      });

      for (let i = 0; i < 5; i++) {
        startTime[i] = Date.now();
        await clientA.transfer({
          amount: transfer.amount.div(toBN(10)).toString(),
          assetId: AddressZero,
          meta: { index: i },
          recipient: clientB.publicIdentifier,
        });
        delay(30000);
        log.info("i: " + i);
      }
    });
    */
  });

  it("client A transfers eth to client B without collateralizing", async () => {
    const transfer: AssetOptions = { amount: ETH_AMOUNT_SM, assetId: AddressZero };
    await fundChannel(clientA, transfer.amount, transfer.assetId);

    const receiverBal = await clientB.getFreeBalance(transfer.assetId);
    expect(receiverBal[xpubToAddress(clientB.nodePublicIdentifier)].lt(transfer.amount)).to.be.true;

    await asyncTransferAsset(clientA, clientB, transfer.amount, transfer.assetId, nats);
  });

  it("client A transfers tokens to client B without collateralizing", async () => {
    const transfer: AssetOptions = { amount: TOKEN_AMOUNT, assetId: tokenAddress };
    await fundChannel(clientA, transfer.amount, transfer.assetId);

    await asyncTransferAsset(clientA, clientB, transfer.amount, transfer.assetId, nats);
  });

  it("Bot A tries to transfer a negative amount", async () => {
    await fundChannel(clientA, ETH_AMOUNT_MD, tokenAddress);
    // verify collateral
    await clientB.requestCollateral(tokenAddress);

    const amount = ETH_AMOUNT_SM.mul(-1).toString();
    await expect(
      clientA.transfer({
        amount,
        assetId: tokenAddress,
        recipient: clientB.publicIdentifier,
      }),
    ).to.be.rejectedWith(`Value ${amount} is negative`);
  });

  it("Bot A tries to transfer with an invalid token address", async () => {
    await fundChannel(clientA, ETH_AMOUNT_SM, tokenAddress);

    const amount = ETH_AMOUNT_SM.toString();
    const assetId = "0xabc";
    await expect(
      clientA.transfer({
        amount,
        assetId,
        recipient: clientB.publicIdentifier,
      }),
    ).to.be.rejectedWith(
      `Value "${assetId}" is not a valid eth address, Value (${amount}) is not less than or equal to 0`,
    );
    // NOTE: will also include a `Value (..) is not less than or equal to 0
    // because it will not be able to fetch the free balance of the assetId
  });

  // TODO: Fix race condition in this one
  it.skip("Bot A transfers w a valid, unsupported token address", async () => {
    // deploy a token
    const factory = ContractFactory.fromSolidity(tokenArtifacts);
    const token = await factory
      .connect(Wallet.fromMnemonic(FUNDED_MNEMONICS[0]).connect(ethProvider))
      .deploy();
    const deployHash = token.deployTransaction.hash;
    expect(deployHash).to.exist;
    await ethProvider.waitForTransaction(token.deployTransaction.hash!);
    // mint token to client
    await token.mint(clientA.signerAddress, TOKEN_AMOUNT);
    // assert sender balance
    const senderBal = await token.balanceOf(clientA.signerAddress);
    expect(senderBal).to.equal(TOKEN_AMOUNT);

    // fund channel
    await fundChannel(clientA, ETH_AMOUNT_LG, token.address);

    await expect(
      clientA.transfer({
        amount: ETH_AMOUNT_LG.toString(),
        assetId: token.address,
        recipient: clientB.publicIdentifier,
      }),
    ).to.be.rejectedWith("Install failed");
    // NOTE: you will not get a more descriptive title
    // because the node maintains the valid tokens list
  });

  it("Bot A tries to transfer with invalid recipient xpub", async () => {
    await fundChannel(clientA, ETH_AMOUNT_SM, tokenAddress);

    const recipient = "nope";
    await expect(
      clientA.transfer({
        amount: ETH_AMOUNT_SM.toString(),
        assetId: tokenAddress,
        recipient,
      }),
    ).to.be.rejectedWith(`Value "${recipient}" must start with "xpub"`);
  });

  it("Bot A tries to transfer an amount greater than they have in their free balance", async () => {
    const amount = ETH_AMOUNT_SM.toString();
    await expect(
      clientA.transfer({
        amount,
        assetId: tokenAddress,
        recipient: clientB.publicIdentifier,
      }),
    ).to.be.rejectedWith(`Value (${amount}) is not less than or equal to 0`);
  });

  it("Bot A tries to transfer with a paymentId that is not 32 bytes", async () => {
    await fundChannel(clientA, ETH_AMOUNT_SM, tokenAddress);

    const paymentId = "nope";
    await expect(
      clientA.conditionalTransfer({
        amount: ETH_AMOUNT_SM.toString(),
        assetId: tokenAddress,
        conditionType: LINKED_TRANSFER_TO_RECIPIENT,
        paymentId,
        preImage: hexlify(randomBytes(32)),
        recipient: clientB.publicIdentifier,
      }),
    ).to.be.rejectedWith(`Value "${paymentId}" is not a valid hex string`);
  });

  it("Bot A tries to transfer with a preimage that is not 32 bytes", async () => {
    await fundChannel(clientA, ETH_AMOUNT_SM, tokenAddress);

    const preImage = "nope";
    await expect(
      clientA.conditionalTransfer({
        amount: ETH_AMOUNT_SM.toString(),
        assetId: tokenAddress,
        conditionType: LINKED_TRANSFER_TO_RECIPIENT,
        paymentId: hexlify(randomBytes(32)),
        preImage,
        recipient: clientB.publicIdentifier,
      }),
    ).to.be.rejectedWith(`Value "${preImage}" is not a valid hex string`);
  });

  // TODO: this actually works now since the preimage storage was changed. there's really no
  // reason this shouldn't work, since you can deterministically get an xpub for someone without
  // them having a channel
  it.skip("Bot A proposes a transfer to an xpub that doesn’t have a channel", async () => {
    await fundChannel(clientA, ETH_AMOUNT_SM, tokenAddress);

    await expect(
      clientA.transfer({
        amount: ETH_AMOUNT_SM.toString(),
        assetId: tokenAddress,
        recipient: HDNode.fromMnemonic(Wallet.createRandom().mnemonic).neuter().extendedKey,
      }),
    ).to.be.rejectedWith("No channel exists for recipientPublicIdentifier");
  });
});
