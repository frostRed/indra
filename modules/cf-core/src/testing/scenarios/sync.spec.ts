import { EventEmitter } from "events";
import {
  JsonRpcProvider,
  IStoreService,
  EventNames,
  StateChannelJSON,
  ProtocolNames,
  MethodNames,
  MethodParams,
} from "@connext/types";
import { getMemoryStore } from "@connext/store";
import { utils } from "ethers";

import { env } from "../setup";
import { CFCore } from "../../cfCore";
import {
  createChannel,
  makeProposeCall,
  constructInstallRpc,
  makeAndSendProposeCall,
  installApp,
  constructUninstallRpc,
  constructTakeActionRpc,
  uninstallApp,
} from "../utils";
import { MemoryMessagingServiceWithLimits } from "../services/memory-messaging-service-limits";
import { deBigNumberifyJson, ChannelSigner, bigNumberifyJson } from "@connext/utils";
import { A_PRIVATE_KEY, B_PRIVATE_KEY } from "../test-constants.jest";
import { TestContractAddresses } from "../contracts";
import { MemoryLockService } from "../services";
import { Logger } from "../logger";
import { validAction } from "../tic-tac-toe";
import { expect } from "../assertions";

const { isHexString } = utils;

describe("Sync", () => {
  let multisigAddress: string;
  let nodeA: CFCore;
  let nodeB: CFCore;
  let storeServiceA: IStoreService;
  let storeServiceB: IStoreService;
  let sharedEventEmitter: EventEmitter;
  let ethUrl: string;
  let provider: JsonRpcProvider;
  let nodeConfig: any;
  let lockService: MemoryLockService;
  let channelSignerA: ChannelSigner;
  let channelSignerB: ChannelSigner;
  let expectedChannel: StateChannelJSON | undefined;
  let messagingServiceA: MemoryMessagingServiceWithLimits;
  let messagingServiceB: MemoryMessagingServiceWithLimits;

  const log = new Logger("SyncTest", env.logLevel, true);

  afterEach(async () => {
    // cleanup
    sharedEventEmitter.removeAllListeners();
  });

  beforeEach(async () => {
    // test global fixtures
    sharedEventEmitter = new EventEmitter();
    ethUrl = global["wallet"]["provider"].connection.url;
    provider = new JsonRpcProvider(ethUrl);
    nodeConfig = { STORE_KEY_PREFIX: "test" };
    lockService = new MemoryLockService();

    // create nodeA values
    storeServiceA = getMemoryStore();
    channelSignerA = new ChannelSigner(A_PRIVATE_KEY, ethUrl);
    await storeServiceA.init();
    await storeServiceA.clear();

    // create nodeB values
    messagingServiceB = new MemoryMessagingServiceWithLimits(
      sharedEventEmitter,
      undefined,
      undefined,
      undefined,
      "NodeB",
    );
    storeServiceB = getMemoryStore();
    channelSignerB = new ChannelSigner(B_PRIVATE_KEY, ethUrl);
    await storeServiceB.init();
    await storeServiceB.clear();
    nodeB = await CFCore.create(
      messagingServiceB,
      storeServiceB,
      global["contracts"],
      nodeConfig,
      provider,
      channelSignerB,
      lockService,
      0,
      new Logger("CreateClient", env.logLevel, true, "B"),
    );
  });

  describe("Sync::propose", () => {
    let identityHash: string;
    beforeEach(async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;

      // propose-specific setup
      messagingServiceA = new MemoryMessagingServiceWithLimits(sharedEventEmitter, 0, "propose");
      nodeA = await CFCore.create(
        messagingServiceA,
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A"),
      );

      // create channel
      multisigAddress = await createChannel(nodeA, nodeB);

      // load stores with proposal
      const rpc = makeProposeCall(nodeA, TicTacToeApp, multisigAddress);
      await new Promise(async (res) => {
        nodeB.once(EventNames.SYNC_FAILED_EVENT, res);
        try {
          await nodeB.rpcRouter.dispatch({
            ...rpc,
            parameters: deBigNumberifyJson(rpc.parameters),
          });
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      // get expected channel from nodeB
      expect(isHexString(multisigAddress)).to.eq(true);
      expectedChannel = await storeServiceA.getStateChannel(multisigAddress);
      identityHash = expectedChannel!.proposedAppInstances[0][0];
      const unsynced = await storeServiceB.getStateChannel(multisigAddress);
      expect(expectedChannel).to.be.ok;
      expect(expectedChannel!.proposedAppInstances.length).to.eq(1);
      expect(unsynced?.proposedAppInstances.length).to.eq(0);
    });

    it("sync protocol responder is missing a proposal held by the protocol initiator, sync on startup", async () => {
      const newNodeA = await CFCore.create(
        new MemoryMessagingServiceWithLimits(sharedEventEmitter),
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A-Recreated"),
        false,
      );
      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      await (newNodeA as CFCore).rpcRouter.dispatch(
        constructInstallRpc(identityHash, multisigAddress),
      );
      expect(syncedChannel).to.deep.eq(expectedChannel!);
      const newAppInstanceA = await storeServiceA.getAppInstance(identityHash);
      const newAppInstanceB = await storeServiceB.getAppInstance(identityHash);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceA!.identityHash).to.eq(identityHash);
      expect(newAppInstanceA!.appSeqNo).to.eq(2);
      expect(newAppInstanceA!.latestVersionNumber).to.eq(1);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(2);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
      expect(newChannelA!.appInstances.length).to.eq(1);
    });

    it("sync protocol initiator is missing a proposal held by the protocol responder, sync on startup", async () => {
      messagingServiceA.clearLimits();
      const [eventData, newNodeB] = await Promise.all([
        new Promise(async (resolve, reject) => {
          nodeA.on(EventNames.SYNC, (data) => resolve(data));
          nodeA.on(EventNames.SYNC_FAILED_EVENT, (msg) => reject(`Sync failed. ${msg.data.error}`));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceB,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerB,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "B"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(bigNumberifyJson(eventData)).to.deep.include({
        from: nodeB.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: bigNumberifyJson(expectedChannel) },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);
      await (newNodeB as CFCore).rpcRouter.dispatch(
        constructInstallRpc(identityHash, multisigAddress),
      );
      const newAppInstanceA = await storeServiceA.getAppInstance(identityHash);
      const newAppInstanceB = await storeServiceB.getAppInstance(identityHash);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(identityHash);
      expect(newAppInstanceB!.appSeqNo).to.eq(2);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(2);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
      expect(newChannelB!.appInstances.length).to.eq(1);
    });

    it("sync protocol responder is missing a proposal held by the protocol initiator, sync on error", async () => {
      messagingServiceA.clearLimits();
      await nodeA.rpcRouter.dispatch(constructInstallRpc(identityHash, multisigAddress));

      const newAppInstanceA = await storeServiceA.getAppInstance(identityHash);
      const newAppInstanceB = await storeServiceB.getAppInstance(identityHash);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceA!.identityHash).to.eq(identityHash);
      expect(newAppInstanceA!.appSeqNo).to.eq(2);
      expect(newAppInstanceA!.latestVersionNumber).to.eq(1);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(2);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
      expect(newChannelA!.appInstances.length).to.eq(1);
    });

    it("sync protocol initiator is missing a proposal held by the protocol responder, sync on error", async () => {
      messagingServiceA.clearLimits();
      await nodeB.rpcRouter.dispatch(constructInstallRpc(identityHash, multisigAddress));
      const newAppInstanceA = await storeServiceA.getAppInstance(identityHash);
      const newAppInstanceB = await storeServiceB.getAppInstance(identityHash);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(identityHash);
      expect(newAppInstanceB!.appSeqNo).to.eq(2);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(2);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
      expect(newChannelB!.appInstances.length).to.eq(1);
    });
  });

  describe("Sync::propose + rejectInstall", () => {
    beforeEach(async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      // propose-specific setup
      messagingServiceA = new MemoryMessagingServiceWithLimits(
        sharedEventEmitter,
        0,
        "propose",
        undefined,
        "A-Initial",
      );
      nodeA = await CFCore.create(
        messagingServiceA,
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A"),
      );

      // create channel
      multisigAddress = await createChannel(nodeA, nodeB);

      // load stores with proposal
      const rpc = makeProposeCall(nodeA, TicTacToeApp, multisigAddress);
      await new Promise(async (res) => {
        nodeB.once(EventNames.SYNC_FAILED_EVENT, res);
        try {
          await nodeB.rpcRouter.dispatch({
            ...rpc,
            parameters: deBigNumberifyJson(rpc.parameters),
          });
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      // get expected channel from nodeB
      expect(isHexString(multisigAddress)).to.eq(true);
      expectedChannel = await storeServiceA.getStateChannel(multisigAddress);
      const unsynced = await storeServiceB.getStateChannel(multisigAddress);
      expect(expectedChannel).to.be.ok;
      expect(expectedChannel!.proposedAppInstances.length).to.eq(1);
      expect(unsynced?.proposedAppInstances.length).to.eq(0);

      await nodeA.rpcRouter.dispatch({
        methodName: MethodNames.chan_rejectInstall,
        parameters: {
          appIdentityHash: expectedChannel!.proposedAppInstances[0][0],
          multisigAddress,
        } as MethodParams.RejectInstall,
      });

      expectedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(expectedChannel!.proposedAppInstances.length).to.eq(0);
    });

    it("sync protocol responder is missing a proposal held by the protocol initiator, sync on startup", async function () {
      this.timeout(90_000);
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      const [eventData, newNodeA] = await Promise.all([
        new Promise(async (resolve, reject) => {
          nodeB.on(EventNames.SYNC, (data) => resolve(data));
          nodeB.on(EventNames.SYNC_FAILED_EVENT, () => reject(`Sync failed`));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(
            sharedEventEmitter,
            undefined,
            undefined,
            undefined,
            "A-Recreated",
          ),
          storeServiceA,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerA,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "A-Recreated"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(bigNumberifyJson(eventData)).to.deep.eq({
        from: nodeA.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: bigNumberifyJson(expectedChannel) },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      const rpc = makeProposeCall(newNodeA as CFCore, TicTacToeApp, multisigAddress);
      const res: any = await new Promise(async (resolve) => {
        nodeB.once(EventNames.PROPOSE_INSTALL_EVENT, resolve);
        try {
          await nodeB.rpcRouter.dispatch({
            ...rpc,
            parameters: deBigNumberifyJson(rpc.parameters),
          });
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      const newAppInstanceA = await storeServiceA.getAppProposal(res.data.appInstanceId);
      const newAppInstanceB = await storeServiceB.getAppProposal(res.data.appInstanceId);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(res.data.appInstanceId);
      expect(newAppInstanceB!.appSeqNo).to.eq(3);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelB!.proposedAppInstances.length).to.eq(1);
    });

    it("sync protocol initiator is missing a proposal held by the protocol responder, sync on startup", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      messagingServiceA.clearLimits();
      const [eventData, newNodeB] = await Promise.all([
        new Promise(async (resolve, reject) => {
          nodeA.on(EventNames.SYNC, (data) => resolve(data));
          nodeA.on(EventNames.SYNC_FAILED_EVENT, (data) => reject(`Sync failed`));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceB,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerB,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "B"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(bigNumberifyJson(eventData)).to.deep.eq({
        from: (newNodeB as CFCore).publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: bigNumberifyJson(expectedChannel) },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      const rpc = makeProposeCall(nodeA, TicTacToeApp, multisigAddress);
      const res: any = await new Promise(async (resolve) => {
        nodeA.once(EventNames.PROPOSE_INSTALL_EVENT, resolve);
        try {
          await (newNodeB as CFCore).rpcRouter.dispatch({
            ...rpc,
            parameters: deBigNumberifyJson(rpc.parameters),
          });
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      const newAppInstanceA = await storeServiceA.getAppProposal(res.data.appInstanceId);
      const newAppInstanceB = await storeServiceB.getAppProposal(res.data.appInstanceId);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(res.data.appInstanceId);
      expect(newAppInstanceB!.appSeqNo).to.eq(3);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelB!.proposedAppInstances.length).to.eq(1);
    });

    it("sync protocol responder is missing a proposal held by the protocol initiator, sync on error", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      messagingServiceA.clearLimits();
      const rpc = makeProposeCall(nodeB, TicTacToeApp, multisigAddress);
      const res: any = await new Promise(async (resolve) => {
        nodeB.once("PROPOSE_INSTALL_EVENT", resolve);
        try {
          await nodeA.rpcRouter.dispatch({
            ...rpc,
            parameters: deBigNumberifyJson(rpc.parameters),
          });
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      const newAppInstanceA = await storeServiceA.getAppProposal(res.data.appInstanceId);
      const newAppInstanceB = await storeServiceB.getAppProposal(res.data.appInstanceId);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(res.data.appInstanceId);
      expect(newAppInstanceB!.appSeqNo).to.eq(3);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelB!.proposedAppInstances.length).to.eq(1);
    });

    it("sync protocol initiator is missing a proposal held by the protocol responder, sync on error", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      messagingServiceA.clearLimits();
      const rpc = makeProposeCall(nodeA, TicTacToeApp, multisigAddress);
      const res: any = await new Promise(async (resolve) => {
        nodeA.once("PROPOSE_INSTALL_EVENT", resolve);
        try {
          await nodeB.rpcRouter.dispatch({
            ...rpc,
            parameters: deBigNumberifyJson(rpc.parameters),
          });
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      const newAppInstanceA = await storeServiceA.getAppProposal(res.data.appInstanceId);
      const newAppInstanceB = await storeServiceB.getAppProposal(res.data.appInstanceId);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(res.data.appInstanceId);
      expect(newAppInstanceB!.appSeqNo).to.eq(3);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelB!.proposedAppInstances.length).to.eq(1);
    });
  });

  describe("Sync::install", () => {
    let appIdentityHash: string;
    let unsynced: StateChannelJSON | undefined;
    // TODO: figure out how to fast-forward IO_SEND_AND_WAIT
    beforeEach(async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      // install-specific setup
      messagingServiceA = new MemoryMessagingServiceWithLimits(
        sharedEventEmitter,
        0,
        ProtocolNames.install,
        "send",
      );
      nodeA = await CFCore.create(
        messagingServiceA,
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A"),
      );

      // create channel
      multisigAddress = await createChannel(nodeA, nodeB);

      // create proposal
      const [ret] = await Promise.all([
        makeAndSendProposeCall(nodeA, nodeB, TicTacToeApp, multisigAddress),
        new Promise((resolve) => {
          nodeB.once(EventNames.SYNC_FAILED_EVENT, () => {
            resolve();
          });
        }),
      ]);
      appIdentityHash = (ret as any).appIdentityHash;

      await new Promise(async (res, rej) => {
        nodeA.once(EventNames.INSTALL_EVENT, res);
        try {
          await nodeB.rpcRouter.dispatch(constructInstallRpc(appIdentityHash, multisigAddress));
          rej(`Node B should not complete installation`);
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      // get expected channel from nodeB
      expectedChannel = (await storeServiceA.getStateChannel(multisigAddress))!;
      unsynced = await storeServiceB.getStateChannel(multisigAddress);
      expect(unsynced?.appInstances.length).to.eq(0);
      expect(expectedChannel?.appInstances.length).to.eq(1);
    });

    it("sync protocol -- initiator is missing an app held by responder", async () => {
      messagingServiceA.clearLimits();
      const [eventData, newNodeB] = await Promise.all([
        new Promise(async (resolve) => {
          nodeA.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceB,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerB,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "B"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(eventData).to.deep.eq({
        from: nodeB.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      await uninstallApp(newNodeB as CFCore, nodeA, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelA!.appInstances.length).to.eq(0);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
    });

    it("sync protocol -- responder is missing an app held by initiator", async () => {
      const [eventData, newNodeA] = await Promise.all([
        new Promise(async (resolve) => {
          nodeB.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceA,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerA,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "A"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(eventData).to.deep.eq({
        from: nodeA.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      await uninstallApp(nodeB, newNodeA as CFCore, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelB!.appInstances.length).to.eq(0);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
    });

    // NOTE: same test for initiator/responder ordering would fail bc storeB
    // does not have installed app
    it("sync protocol -- responder is missing an app held by initiator, sync on error", async () => {
      messagingServiceA.clearLimits();
      await uninstallApp(nodeA, nodeB, appIdentityHash, multisigAddress);

      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelA!.appInstances.length).to.eq(0);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
    });
  });

  describe("Sync::install + rejectInstall", () => {
    let appIdentityHash: string;
    let unsynced: StateChannelJSON | undefined;
    // TODO: figure out how to fast-forward IO_SEND_AND_WAIT
    beforeEach(async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      // install-specific setup
      messagingServiceA = new MemoryMessagingServiceWithLimits(
        sharedEventEmitter,
        0,
        ProtocolNames.install,
        "send",
      );
      nodeA = await CFCore.create(
        messagingServiceA,
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A"),
      );

      // create channel
      multisigAddress = await createChannel(nodeA, nodeB);

      // create proposal
      const [ret] = await Promise.all([
        makeAndSendProposeCall(nodeA, nodeB, TicTacToeApp, multisigAddress),
        new Promise((resolve) => {
          nodeB.once(EventNames.PROPOSE_INSTALL_EVENT, () => {
            resolve();
          });
        }),
      ]);
      appIdentityHash = (ret as any).appIdentityHash;

      await new Promise(async (res, rej) => {
        nodeA.once(EventNames.INSTALL_EVENT, res);
        try {
          await nodeB.rpcRouter.dispatch(constructInstallRpc(appIdentityHash, multisigAddress));
          rej(`Node B should not complete installation`);
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      // get expected channel from nodeB
      expectedChannel = (await storeServiceA.getStateChannel(multisigAddress))!;
      unsynced = await storeServiceB.getStateChannel(multisigAddress);
      expect(unsynced?.appInstances.length).to.eq(0);
      expect(unsynced!.proposedAppInstances.length).to.eq(1);
      expect(expectedChannel?.appInstances.length).to.eq(1);

      // nodeB rejects proposal
      await nodeB.rpcRouter.dispatch({
        methodName: MethodNames.chan_rejectInstall,
        parameters: {
          appIdentityHash,
          multisigAddress,
        } as MethodParams.RejectInstall,
      });

      const postRejectChannel = await storeServiceB.getStateChannel(multisigAddress);
      expect(postRejectChannel!.proposedAppInstances.length).to.eq(0);
    });

    it("sync protocol -- initiator is missing an app held by responder, sync on startup", async () => {
      messagingServiceA.clearLimits();
      const [eventData, newNodeB] = await Promise.all([
        new Promise(async (resolve) => {
          nodeA.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceB,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerB,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "B"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(eventData).to.deep.eq({
        from: nodeB.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      await uninstallApp(newNodeB as CFCore, nodeA, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelA!.appInstances.length).to.eq(0);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
    });

    it("sync protocol -- responder is missing an app held by initiator, sync on startup", async () => {
      const [eventData, newNodeA] = await Promise.all([
        new Promise(async (resolve) => {
          nodeB.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceA,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerA,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "A"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(eventData).to.deep.eq({
        from: nodeA.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      await uninstallApp(nodeB, newNodeA as CFCore, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelB!.appInstances.length).to.eq(0);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
    });

    // NOTE: same test for initiator/responder ordering would fail bc storeB
    // does not have installed app
    it("sync protocol -- responder is missing an app held by initiator, sync on error", async () => {
      messagingServiceA.clearLimits();
      await uninstallApp(nodeA, nodeB, appIdentityHash, multisigAddress);

      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelA!.appInstances.length).to.eq(0);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
    });
  });

  describe("Sync::uninstall", () => {
    let identityHash: string;
    beforeEach(async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      // uninstall-specific setup
      messagingServiceA = new MemoryMessagingServiceWithLimits(
        sharedEventEmitter,
        0,
        ProtocolNames.uninstall,
        "send",
      );
      nodeA = await CFCore.create(
        messagingServiceA,
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A"),
      );

      // create channel
      multisigAddress = await createChannel(nodeA, nodeB);

      // create app
      [identityHash] = await installApp(nodeA, nodeB, multisigAddress, TicTacToeApp);

      // nodeB should respond to the uninstall, nodeA will not get the
      // message, but nodeB thinks its sent
      await new Promise(async (resolve, reject) => {
        nodeB.once(EventNames.SYNC_FAILED_EVENT, () => resolve);
        try {
          await nodeB.rpcRouter.dispatch(constructUninstallRpc(identityHash, multisigAddress));
          return reject(`Node B should be able to complete uninstall`);
        } catch (e) {
          return resolve();
        }
      });

      // get expected channel from nodeB
      expectedChannel = (await storeServiceA.getStateChannel(multisigAddress))!;
      const unsynced = await storeServiceB.getStateChannel(multisigAddress);
      expect(expectedChannel.appInstances.length).to.eq(0);
      expect(unsynced?.appInstances.length).to.eq(1);
    });

    it("sync protocol -- initiator has an app uninstalled by responder, sync on startup", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      await messagingServiceB.disconnect();
      messagingServiceA.clearLimits();
      const [eventData, newNodeB] = await Promise.all([
        new Promise(async (resolve) => {
          nodeA.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceB,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerB,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "B"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(eventData).to.deep.eq({
        from: nodeB.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      // create new app
      [identityHash] = await installApp(newNodeB as CFCore, nodeA, multisigAddress, TicTacToeApp);
      const [newAppInstanceA, newAppInstanceB] = await Promise.all([
        storeServiceA.getAppInstance(identityHash),
        storeServiceB.getAppInstance(identityHash),
      ]);
      const [newChannelA, newChannelB] = await Promise.all([
        storeServiceA.getStateChannel(multisigAddress),
        storeServiceB.getStateChannel(multisigAddress),
      ]);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceA!.identityHash).to.eq(identityHash);
      expect(newAppInstanceA!.appSeqNo).to.eq(3);
      expect(newAppInstanceA!.latestVersionNumber).to.eq(1);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(4);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelA!.appInstances.length).to.eq(1);
    });

    it("sync protocol -- responder has an app uninstalled by initiator, sync on startup", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      await messagingServiceA.disconnect();
      const [eventData, newNodeA] = await Promise.all([
        new Promise(async (resolve) => {
          nodeB.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceA,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerA,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "A"),
        ),
      ]);

      const syncedChannel = await storeServiceA.getStateChannel(multisigAddress);
      expect(eventData).to.deep.eq({
        from: nodeA.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });
      expect(syncedChannel).to.deep.eq(expectedChannel!);

      // create new app
      [identityHash] = await installApp(nodeB, newNodeA as CFCore, multisigAddress, TicTacToeApp);
      const [newAppInstanceA, newAppInstanceB] = await Promise.all([
        storeServiceA.getAppInstance(identityHash),
        storeServiceB.getAppInstance(identityHash),
      ]);
      const [newChannelA, newChannelB] = await Promise.all([
        storeServiceA.getStateChannel(multisigAddress),
        storeServiceB.getStateChannel(multisigAddress),
      ]);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(identityHash);
      expect(newAppInstanceB!.appSeqNo).to.eq(3);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(4);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelB!.appInstances.length).to.eq(1);
    });

    it("sync protocol -- initiator has an app uninstalled by responder, sync on error", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      messagingServiceA.clearLimits();
      // create new app
      [identityHash] = await installApp(nodeA, nodeB, multisigAddress, TicTacToeApp);
      const [newAppInstanceA, newAppInstanceB] = await Promise.all([
        storeServiceA.getAppInstance(identityHash),
        storeServiceB.getAppInstance(identityHash),
      ]);
      const [newChannelA, newChannelB] = await Promise.all([
        storeServiceA.getStateChannel(multisigAddress),
        storeServiceB.getStateChannel(multisigAddress),
      ]);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceA!.identityHash).to.eq(identityHash);
      expect(newAppInstanceA!.appSeqNo).to.eq(3);
      expect(newAppInstanceA!.latestVersionNumber).to.eq(1);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(4);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelA!.appInstances.length).to.eq(1);
    });

    it("sync protocol -- responder has an app uninstalled by initiator, sync on error", async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      messagingServiceA.clearLimits();
      // create new app
      [identityHash] = await installApp(nodeB, nodeA, multisigAddress, TicTacToeApp);
      const [newAppInstanceA, newAppInstanceB] = await Promise.all([
        storeServiceA.getAppInstance(identityHash),
        storeServiceB.getAppInstance(identityHash),
      ]);
      const [newChannelA, newChannelB] = await Promise.all([
        storeServiceA.getStateChannel(multisigAddress),
        storeServiceB.getStateChannel(multisigAddress),
      ]);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newAppInstanceA!).to.deep.eq(newAppInstanceB!);
      expect(newAppInstanceB!.identityHash).to.eq(identityHash);
      expect(newAppInstanceB!.appSeqNo).to.eq(3);
      expect(newAppInstanceB!.latestVersionNumber).to.eq(1);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(4);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(3);
      expect(newChannelB!.appInstances.length).to.eq(1);
    });
  });

  describe("Sync::takeAction", () => {
    let appIdentityHash: string;
    beforeEach(async () => {
      const { TicTacToeApp } = global["contracts"] as TestContractAddresses;
      // uninstall-specific setup
      messagingServiceA = new MemoryMessagingServiceWithLimits(
        sharedEventEmitter,
        0,
        ProtocolNames.takeAction,
      );
      nodeA = await CFCore.create(
        messagingServiceA,
        storeServiceA,
        global["contracts"],
        nodeConfig,
        provider,
        channelSignerA,
        lockService,
        0,
        new Logger("CreateClient", env.logLevel, true, "A"),
      );

      // create channel
      multisigAddress = await createChannel(nodeA, nodeB);

      // create app
      [appIdentityHash] = await installApp(nodeA, nodeB, multisigAddress, TicTacToeApp);

      await new Promise(async (resolve, reject) => {
        nodeB.once(EventNames.SYNC_FAILED_EVENT, () => resolve());
        try {
          await nodeB.rpcRouter.dispatch(
            constructTakeActionRpc(appIdentityHash, multisigAddress, validAction),
          );
          reject(`Should not be able to complete protocol`);
        } catch (e) {
          log.info(`Caught error sending rpc: ${e.message}`);
        }
      });

      // get expected channel from nodeB
      expectedChannel = (await storeServiceA.getStateChannel(multisigAddress))!;
      expect(expectedChannel.appInstances.length).to.eq(1);
      const aheadApp = expectedChannel.appInstances.find(([id, app]) => id === appIdentityHash);
      expect(aheadApp).to.be.ok;
      const expectedAppInstance = aheadApp![1];
      expect(expectedAppInstance.latestVersionNumber).to.eq(2);

      const unsynced = (await storeServiceB.getStateChannel(multisigAddress))!;
      expect(unsynced.appInstances.length).to.eq(1);
      const behindApp = unsynced.appInstances.find(([id, app]) => id === appIdentityHash);
      expect(behindApp).to.be.ok;
      const unsyncedAppInstance = behindApp![1];
      expect(unsyncedAppInstance.latestVersionNumber).to.eq(1);
    });

    it("initiator has an app that has a single signed update that the responder does not have, sync on startup", async () => {
      const [eventData, newNodeA] = await Promise.all([
        new Promise(async (resolve) => {
          nodeB.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceA,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerA,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "A"),
        ),
      ]);

      expect(eventData).to.deep.eq({
        from: nodeA.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });

      // attempt to uninstall
      await uninstallApp(newNodeA as CFCore, nodeB, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelA!.appInstances.length).to.eq(0);
      expect(newChannelA!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelA!.monotonicNumProposedApps).to.eq(2);
    });

    it("responder has an app that has a single signed update that the initiator does not have, sync on startup", async () => {
      messagingServiceA.clearLimits();
      const [eventData, newNodeB] = await Promise.all([
        new Promise(async (resolve) => {
          nodeA.on(EventNames.SYNC, (data) => resolve(data));
        }),
        CFCore.create(
          new MemoryMessagingServiceWithLimits(sharedEventEmitter),
          storeServiceB,
          global["contracts"],
          nodeConfig,
          provider,
          channelSignerB,
          lockService,
          0,
          new Logger("CreateClient", env.logLevel, true, "B"),
        ),
      ]);

      expect(eventData).to.deep.eq({
        from: nodeB.publicIdentifier,
        type: EventNames.SYNC,
        data: { syncedChannel: expectedChannel },
      });

      //attempt to uninstall
      await uninstallApp(nodeA, newNodeB as CFCore, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelB!.appInstances.length).to.eq(0);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
    });

    it("initiator has an app that has a single signed update that the responder does not have, sync on error", async () => {
      messagingServiceA.clearLimits();
      //attempt to uninstall
      await uninstallApp(nodeA, nodeB, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelB!.appInstances.length).to.eq(0);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
    });

    it("responder has an app that has a single signed update that the initiator does not have, sync on error", async () => {
      messagingServiceA.clearLimits();
      //attempt to uninstall
      await uninstallApp(nodeB, nodeA, appIdentityHash, multisigAddress);
      const newChannelA = await storeServiceA.getStateChannel(multisigAddress);
      const newChannelB = await storeServiceB.getStateChannel(multisigAddress);
      expect(newChannelA!).to.deep.eq(newChannelB!);
      expect(newChannelB!.appInstances.length).to.eq(0);
      expect(newChannelB!.freeBalanceAppInstance!.latestVersionNumber).to.eq(3);
      expect(newChannelB!.monotonicNumProposedApps).to.eq(2);
    });
  });
});
