import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ExecutionClient } from "./interfaces";

export interface InfuraExecutionClientOptions {
  eth1Endpoint: pulumi.Output<string>;
  eth2Endpoint?: pulumi.Output<string>;
}

export class InfuraExecutionClient
  extends pulumi.ComponentResource
  implements ExecutionClient
{
  enabled = true;
  endpoint: pulumi.Output<string>;
  wsEndpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    config: pulumi.Config
  ): InfuraExecutionClient {
    return new InfuraExecutionClient(
      config.requireSecretObject<InfuraExecutionClientOptions>("infura")
    );
  }

  constructor(opts: pulumi.Output<InfuraExecutionClientOptions>) {
    super("rocketpool:InfuraExecutionClient", "infura");
    this.endpoint = opts.eth1Endpoint;
    this.wsEndpoint = opts.eth1Endpoint.apply((e) =>
      e
        .replace("https://", "wss://")
        .replace("infura.io/v3/", "infura.io/ws/v3/")
    );
  }
}
