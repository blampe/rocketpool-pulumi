import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { Alerts } from "./alerts";

import * as execution from "./clients/execution";
import * as consensus from "./clients/consensus";

import { Rocketpool } from "./rocketpool";

const config = new pulumi.Config();
const network = pulumi.getStack();

const kubeconfig =
  config.get("kubeconfig") ||
  new pulumi.StackReference("kubeconfig", {
    name: "/rocketpool-cluster/gcp",
  }).getOutput("kubeconfig");

const provider = new k8s.Provider("rocketpool-cluster", {
  kubeconfig: kubeconfig,
  namespace: network,
});

new k8s.core.v1.Namespace(
  `${network}-namespace`,
  {
    metadata: {
      name: network,
    },
  },
  { provider: provider }
);

const consensusList =
  config.requireObject<[keyof typeof consensus.ClientClasses]>("consensus");

const executionList =
  config.requireObject<[keyof typeof execution.ClientClasses]>("execution");

const executionClients: execution.AbstractClient[] = [];
const consensusClients: consensus.AbstractClient[] = [];

for (const executionClientName of executionList) {
  const clientClass = execution.ClientClasses[executionClientName];
  const client = clientClass.fromConfig(provider, network, config);
  if (client.enabled) {
    executionClients.push(client);
  }
}

for (const consensusClientName of consensusList) {
  const clientClass = consensus.ClientClasses[consensusClientName];
  const client = clientClass.fromConfig(
    provider,
    network,
    executionClients,
    config
  );
  if (client.enabled) {
    consensusClients.push(client);
  }
}

Rocketpool.fromConfig(
  provider,
  network,
  executionClients,
  consensusClients,
  config
);

if (config.getBoolean("gkeMonitoring")) {
  new Alerts(network);
}
