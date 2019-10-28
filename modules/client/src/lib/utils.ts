import MinimumViableMultisig from "@counterfactual/cf-funding-protocol-contracts/expected-build-artifacts/MinimumViableMultisig.json";
import Proxy from "@counterfactual/cf-funding-protocol-contracts/expected-build-artifacts/Proxy.json";
import {
  BigNumber,
  computeAddress,
  getAddress,
  HDNode,
  hexlify,
  Interface,
  keccak256,
  randomBytes,
  solidityKeccak256,
} from "ethers/utils";
import { isNullOrUndefined } from "util";

export const replaceBN = (key: string, value: any): any =>
  value && value._hex ? value.toString() : value;

// Capitalizes first char of a string
export const capitalize = (str: string): string =>
  str.substring(0, 1).toUpperCase() + str.substring(1);

export const objMap = <T, F extends keyof T, R>(
  obj: T,
  func: (val: T[F], field: F) => R,
): { [key in keyof T]: R } => {
  const res: any = {};
  for (const key in obj) {
    if ((obj as any).hasOwnProperty(key)) {
      res[key] = func(key as any, obj[key] as any);
    }
  }
  return res;
};

export const objMapPromise = async <T, F extends keyof T, R>(
  obj: T,
  func: (val: T[F], field: F) => Promise<R>,
): Promise<{ [key in keyof T]: R }> => {
  const res: any = {};
  for (const key in obj) {
    if ((obj as any).hasOwnProperty(key)) {
      res[key] = await func(key as any, obj[key] as any);
    }
  }
  return res;
};

export const insertDefault = (val: string, obj: any, keys: string[]): any => {
  const adjusted = {} as any;
  keys.concat(Object.keys(obj)).map((k: any): any => {
    // check by index and undefined
    adjusted[k] = isNullOrUndefined(obj[k])
      ? val // not supplied set as default val
      : obj[k];
  });

  return adjusted;
};

export const mkHash = (prefix: string = "0x"): string => prefix.padEnd(66, "0");

export const delay = (ms: number): Promise<void> =>
  new Promise((res: any): any => setTimeout(res, ms));

// TODO: why doesnt deriving a path work as expected? sync w/rahul about
// differences in hub. (eg. only freeBalanceAddressFromXpub derives correct
// fb address but only below works for deposit bal checking)
export const publicIdentifierToAddress = (publicIdentifier: string): string => {
  return HDNode.fromExtendedKey(publicIdentifier).address;
};

export const freeBalanceAddressFromXpub = (xpub: string): string => {
  return HDNode.fromExtendedKey(xpub).derivePath("0").address;
};

export const createLinkedHash = (
  amount: BigNumber,
  assetId: string,
  paymentId: string,
  preImage: string,
): string => {
  return solidityKeccak256(
    ["uint256", "address", "bytes32", "bytes32"],
    [amount, assetId, paymentId, preImage],
  );
};

export const createRandom32ByteHexString = (): string => {
  return hexlify(randomBytes(32));
};

export const withdrawalKey = (xpub: string): string => {
  return `${xpub}/latestNodeSubmittedWithdrawal`;
};

export const createPaymentId = createRandom32ByteHexString;
export const createPreImage = createRandom32ByteHexString;

export function xkeyKthAddress(xkey: string, k: number): string {
  return computeAddress(xkeyKthHDNode(xkey, k).publicKey);
}

export function sortAddresses(addrs: string[]): string[] {
  return addrs.sort((a, b) => (parseInt(a, 16) < parseInt(b, 16) ? -1 : 1));
}

export function xkeysToSortedKthAddresses(xkeys: string[], k: number): string[] {
  return sortAddresses(xkeys.map(xkey => xkeyKthAddress(xkey, k)));
}

export function xkeyKthHDNode(xkey: string, k: number): HDNode.HDNode {
  return HDNode.fromExtendedKey(xkey).derivePath(`${k}`);
}

// TODO: this should be imported from the counterfactual utils
export function getMultisigAddressfromXpubs(
  owners: string[],
  proxyFactoryAddress: string,
  minimumViableMultisigAddress: string,
): string {
  return getAddress(
    solidityKeccak256(
      ["bytes1", "address", "uint256", "bytes32"],
      [
        "0xff",
        proxyFactoryAddress,
        solidityKeccak256(
          ["bytes32", "uint256"],
          [
            keccak256(
              new Interface(MinimumViableMultisig.abi).functions.setup.encode([
                xkeysToSortedKthAddresses(owners, 0),
              ]),
            ),
            0,
          ],
        ),
        solidityKeccak256(
          ["bytes", "uint256"],
          [`0x${Proxy.evm.bytecode.object}`, minimumViableMultisigAddress],
        ),
      ],
    ).slice(-40),
  );
}
