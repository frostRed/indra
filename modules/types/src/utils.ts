import { toBN } from "./math";

// stolen from https://github.com/microsoft/TypeScript/issues/3192#issuecomment-261720275
export const enumify = <T extends {[index: string]: U}, U extends string>(x: T): T => x;

// TODO: dedup this + cf-core/src/utils
export const parseBN = (obj: any): object =>
  typeof obj === "string" ? obj : JSON.parse(
    JSON.stringify(obj),
    (key: string, value: any): any => (value && value["_hex"]) ? toBN(value._hex) : value,
  );

export const stringify = (obj: any, space: number = 2): string =>
  JSON.stringify(
    obj,
    (key: string, value: any): any => (value && value._hex) ? toBN(value._hex).toString() : value,
    space,
  );

export const delay = (ms: number): Promise<void> =>
  new Promise((res: any): any => setTimeout(res, ms));
