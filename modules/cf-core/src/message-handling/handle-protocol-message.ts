import {
  PROPOSE_INSTALL_EVENT,
  INSTALL_EVENT,
  UNINSTALL_EVENT,
  CREATE_CHANNEL_EVENT,
  WITHDRAWAL_STARTED_EVENT,
  UPDATE_STATE_EVENT,
} from "@connext/types";

import { UNASSIGNED_SEQ_NO } from "../constants";
import { NO_PROPOSED_APP_INSTANCE_FOR_APP_INSTANCE_ID } from "../errors";

import { RequestHandler } from "../request-handler";
import RpcRouter from "../rpc-router";
import {
  EventEmittedMessage,
  InstallProtocolParams,
  NetworkContext,
  NodeMessageWrappedProtocolMessage,
  ProposeInstallProtocolParams,
  Protocol,
  ProtocolParameters,
  SetupProtocolParams,
  SolidityValueType,
  TakeActionProtocolParams,
  UninstallProtocolParams,
  UpdateProtocolParams,
  WithdrawProtocolParams,
  WithdrawStartedMessage,
} from "../types";
import { bigNumberifyJson } from "../utils";
import { Store } from "../store";

/**
 * Forwards all received NodeMessages that are for the machine's internal
 * protocol execution directly to the protocolRunner's message handler:
 * `runProtocolWithMessage`
 */
export async function handleReceivedProtocolMessage(
  requestHandler: RequestHandler,
  msg: NodeMessageWrappedProtocolMessage,
) {
  const { protocolRunner, store, router, networkContext, publicIdentifier } = requestHandler;

  const { data } = bigNumberifyJson(msg) as NodeMessageWrappedProtocolMessage;

  const { protocol, seq, params } = data;

  if (seq === UNASSIGNED_SEQ_NO) return;

  await protocolRunner.runProtocolWithMessage(data);

  const outgoingEventData = await getOutgoingEventDataFromProtocol(
    protocol,
    params!,
    networkContext,
    store,
    publicIdentifier,
  );

  if (
    outgoingEventData && protocol === Protocol.Install
  ) {
    const appInstanceId =
      outgoingEventData!.data["appInstanceId"] ||
      (outgoingEventData!.data as any).params["appInstanceId"];
    if (appInstanceId) {
      let proposal;
      try {
        proposal = await store.getAppInstanceProposal(appInstanceId);
      } catch (e) {
        if (!e.toString().includes(NO_PROPOSED_APP_INSTANCE_FOR_APP_INSTANCE_ID(appInstanceId))) {
          throw e;
        }
      }
      if (proposal) {
        await store.saveStateChannel(
          (await store.getStateChannelFromAppInstanceID(appInstanceId)).removeProposal(
            appInstanceId,
          ),
        );
      }
    }
  }

  if (outgoingEventData) {
    await emitOutgoingNodeMessage(router, outgoingEventData);
  }
}

function emitOutgoingNodeMessage(router: RpcRouter, msg: EventEmittedMessage) {
  return router.emit(msg["type"], msg, "outgoing");
}

async function getOutgoingEventDataFromProtocol(
  protocol: Protocol,
  params: ProtocolParameters,
  networkContext: NetworkContext,
  store: Store,
  publicIdentifier: string,
): Promise<EventEmittedMessage | undefined> {
  // default to the pubId that initiated the protocol
  const baseEvent = { from: params.initiatorXpub };

  switch (protocol) {
    case Protocol.Propose:
      const {
        multisigAddress,
        initiatorXpub,
        responderXpub,
        ...emittedParams
      } = params as ProposeInstallProtocolParams;
      return {
        ...baseEvent,
        type: PROPOSE_INSTALL_EVENT,
        data: {
          params: {
            ...emittedParams,
            proposedToIdentifier: responderXpub,
          },
          appInstanceId: (
            await store.getStateChannel(multisigAddress)
          ).mostRecentlyProposedAppInstance().identityHash,
        },
      };
    case Protocol.Install:
      return {
        ...baseEvent,
        type: INSTALL_EVENT,
        data: {
          // TODO: It is weird that `params` is in the event data, we should
          // remove it, but after telling all consumers about this change
          params: {
            appInstanceId: (
              await store.getStateChannel((params as InstallProtocolParams).multisigAddress)
            ).mostRecentlyInstalledAppInstance().identityHash,
          },
        },
      };
    case Protocol.Uninstall:
      return {
        ...baseEvent,
        type: UNINSTALL_EVENT,
        data: getUninstallEventData(params as UninstallProtocolParams),
      };
    case Protocol.Setup:
      return {
        ...baseEvent,
        type: CREATE_CHANNEL_EVENT,
        data: getSetupEventData(
          params as SetupProtocolParams,
          (await store.getStateChannel((params as SetupProtocolParams).multisigAddress))!
            .multisigOwners,
        ),
      };
    case Protocol.Withdraw:
      // NOTE: responder will only ever emit a withdraw started
      // event. does not include tx hash
      // determine if the withdraw is finishing or if it is starting
      return {
        ...baseEvent,
        type: WITHDRAWAL_STARTED_EVENT,
        data: getWithdrawEventData(params as WithdrawProtocolParams),
      } as WithdrawStartedMessage;
    case Protocol.TakeAction:
    case Protocol.Update:
      return {
        ...baseEvent,
        type: UPDATE_STATE_EVENT,
        data: getStateUpdateEventData(
          params as UpdateProtocolParams,
          (
            await store.getAppInstance(
              (params as TakeActionProtocolParams | UpdateProtocolParams).appIdentityHash,
            )
          ).state,
        ),
      };
    default:
      throw Error(`handleReceivedProtocolMessage received invalid protocol message: ${protocol}`);
  }
}

function getStateUpdateEventData(
  params: TakeActionProtocolParams | UpdateProtocolParams,
  newState: SolidityValueType,
) {
  // note: action does not exist on type `UpdateProtocolParams`
  // so use any cast
  const { appIdentityHash: appInstanceId, action } = params as any;
  return { newState, appInstanceId, action };
}

function getUninstallEventData({ appIdentityHash: appInstanceId }: UninstallProtocolParams) {
  return { appInstanceId };
}

function getWithdrawEventData(params: WithdrawProtocolParams) {
  const { multisigAddress, tokenAddress, recipient, amount } = params;
  return {
    params: {
      multisigAddress,
      tokenAddress,
      recipient,
      amount,
    },
  };
}

function getSetupEventData(
  { initiatorXpub: counterpartyXpub, multisigAddress }: SetupProtocolParams,
  owners: string[],
) {
  return { multisigAddress, owners, counterpartyXpub };
}

/**
 * Produces an array of queues that the client must halt execution on
 * for some particular protocol and its set of parameters/
 *
 * @param {string} protocol - string name of the protocol
 * @param {ProtocolParameters} params - parameters relevant for the protocol
 * @param {Store} store - the store the client is connected to
 * @param {RequestHandler} requestHandler - the request handler object of the client
 *
 * @returns {Promise<string[]>} - list of the names of the queues
 */
async function getQueueNamesListByProtocolName(
  protocol: string,
  params: ProtocolParameters,
  requestHandler: RequestHandler,
): Promise<string[]> {
  const { networkContext, provider, publicIdentifier, store } = requestHandler;

  async function multisigAddressFor(xpubs: string[]) {
    // allow generated multisig for setup protocol only!

    // in propose, you may need to generate a multisig address for
    // initiator and responder if it is a virtual app. but in the `install`
    // step, these channels should have been persisted with end participants,
    // and previously exist for intermediaries.
    const allowed = protocol === Protocol.Setup;
    return await store.getMultisigAddressWithCounterparty(
      xpubs,
      networkContext.ProxyFactory,
      networkContext.MinimumViableMultisig,
      allowed ? provider : undefined,
    );
  }

  switch (protocol) {
    /**
     * Queue on the multisig address of the direct channel.
     */
    case Protocol.Install:
    case Protocol.Setup:
    case Protocol.Withdraw:
    case Protocol.Propose:
      const { multisigAddress } = params as
        | InstallProtocolParams
        | SetupProtocolParams
        | WithdrawProtocolParams;

      return [multisigAddress];

    /**
     * Queue on the appInstanceId of the AppInstance.
     */
    case Protocol.TakeAction:
    case Protocol.Update:
      const { appIdentityHash } = params as TakeActionProtocolParams | UpdateProtocolParams;

      return [appIdentityHash];

    case Protocol.Uninstall:
      const {
        multisigAddress: addr,
        appIdentityHash: appInstanceId,
      } = params as UninstallProtocolParams;

      return [addr, appInstanceId];

    // NOTE: This file is only reachable if a protocol message is sent
    // from an initiator to an intermediary, an intermediary to
    // a responder, or an initiator to a responder. It is never possible
    // for the publicIdentifier to be the initiatorXpub, so we ignore
    // that case.

    default:
      break;
  }
  throw Error(`handleReceivedProtocolMessage received invalid protocol message: ${protocol}`);
}
