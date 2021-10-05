import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { StatefulSetConfig, VolumeConfig } from "../../interfaces";

export interface ExecutionClient {
  endpoint: pulumi.Output<string>;
  wsEndpoint?: pulumi.Output<string>;
}

export interface ExecutionClientConfig extends StatefulSetConfig {
  external?: boolean;
  targetPeers?: number;
}

export type ExecutionClientOptions = Required<ExecutionClientConfig> & {
  provider: k8s.Provider;
  network: string;
  volume: Omit<Required<VolumeConfig>, "source"> & { source?: string };
};
