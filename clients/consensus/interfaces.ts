import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ExecutionClient } from "../execution/interfaces";
import { StatefulSetConfig, VolumeConfig } from "../../interfaces";

export interface ConsensusClient {
  endpoint: pulumi.Output<string>;
}

export interface ConsensusClientConfig extends StatefulSetConfig {
  external?: boolean;
  targetPeers?: number;
  checkpointUrl?: pulumi.Output<string>;
}

export type ConsensusClientOptions = Omit<
  Required<ConsensusClientConfig>,
  "checkpointUrl"
> & {
  provider: k8s.Provider;
  network: string;
  executionClients: ExecutionClient[];
  volume: Omit<Required<VolumeConfig>, "source"> & { source?: string };
  checkpointUrl?: pulumi.Output<string>;
};
