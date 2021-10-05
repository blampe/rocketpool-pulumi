export { ConsensusClient as AbstractClient } from "./interfaces";

import { LighthouseBeacon } from "./lighthouse";
import { LodestarClient } from "./lodestar";
import { NimbusClient } from "./nimbus";
import { TekuClient } from "./teku";

export const ClientClasses = {
  lighthouse: LighthouseBeacon,
  lodestar: LodestarClient,
  nimbus: NimbusClient,
  teku: TekuClient,
} as const;
