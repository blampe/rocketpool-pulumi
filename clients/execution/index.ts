export { ExecutionClient as AbstractClient } from "./interfaces";
import { ErigonClient } from "./erigon";
import { NethermindClient } from "./nethermind";
import { InfuraExecutionClient } from "./infura";

export const ClientClasses = {
  erigon: ErigonClient,
  nethermind: NethermindClient,
  infura: InfuraExecutionClient,
} as const;
