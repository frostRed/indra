import { getMemoryStore } from "@connext/store";
import { getRandomChannelSigner } from "@connext/utils";
import { providers } from "ethers";
import { MemoryLockService } from "./testing/services/memory-lock-service";

import { CFCore } from "./cfCore";
import { memoryMessagingService } from "./testing/services";
import { expect } from "./testing/assertions";

describe("CFCore", () => {
  it("is defined", () => {
    expect(CFCore).to.be.ok;
  });

  it("can be created", async () => {
    const provider = new providers.JsonRpcProvider(global["wallet"].provider.connection.url);
    // TODO: getMemoryStore should run init() internally
    const store = getMemoryStore();
    await store.init();
    const node = await CFCore.create(
      memoryMessagingService,
      store,
      { 1337: { contractAddresses: global["contracts"], provider } },
      getRandomChannelSigner(),
      new MemoryLockService(),
    );

    expect(node).to.be.ok;
  });
});
