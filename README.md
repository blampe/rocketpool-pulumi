# 🚀 Rocket Pool Pulumi Stack

[Rocket Pool](https://rocketpool.net) is a distributed [staking
protocol](https://docs.rocketpool.net/guides/node/responsibilities.html#how-eth2-staking-works)
for next-gen [Ethereum](https://ethereum.org/en/eth2/).

This repository contains two [Pulumi](http://pulumi.com) projects:

1. `./rocketpool-pulumi`: deploys the necessary components for staking with the
   Rocket Pool protocol into a Kubernetes cluster; and
2. `./rocketpool-pulumi/cluster/`: an optional stack for deploying a [GKE
   Autopilot](https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview)
   Kubernetes cluster, if you don't have already have one handy.

Operating an RP node requires 17.6ETH to stake (vs. 32ETH for a full validator)
and provides additional rewards via the RPL token. You should understand the
long-term commitment and financial risks associated with staking before
attempting to use this project.

(You can run a full validator with this setup, but you'll need to bring your
own validator keys and deposits.)

## Motivation

Rocket Pool is [_very
easy_](https://docs.rocketpool.net/guides/node/docker.html#process-overview) to
deploy as an all-in-one ["smartnode"](https://github.com/rocket-pool/smartnode)
using their install scripts, and for most users this is sufficient.

I wanted more control over my deployment topology. For example I wanted to

- use clients not already bundled into the smartnode stack,
- version and deploy components independently,
- incorporate redundancy into the setup for high availability, and
- deploy on a cloud provider for elasticity.

[Kubernetes](https://kubernetes.io) was a natural fit.

## Requirements

You'll need working knowledge of Linux, Kubernetes, and (optionally) Pulumi to
get this up and running.

### Cloud Deployment

- A [GCP
  account](https://console.cloud.google.com/home/dashboard?project=rocket-pool-328103),
  [`gcloud` binary](https://cloud.google.com/sdk/docs/downloads-interactive),
  and a
  [project](https://cloud.google.com/resource-manager/docs/creating-managing-projects)
  to install into.
- A [Pulumi](https://www.pulumi.com) account. It's highly recommend you use
  [GCP KMS for secret
  encryption](https://www.pulumi.com/docs/intro/concepts/secrets/#changing-the-secrets-provider-for-a-stack).
- (optional) An [infura.io](http://infura.io) account for ETH1 fallback and/or
  checkpoint sync.
- (optional) A [notification
  channel](https://cloud.google.com/monitoring/support/notification-options)
  configured if you'd like to get alerted for operational issues like low
  volume capacity.

### Existing Cluster

If using your own cluster, configure `rocketpool:kubeconfig:` with the path to
your `kubeconfig`.

Ensure you have vertical pod autoscaling enabled by following the instructions
[here](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler).

See "Configuration" below for overriding storage classes.

## Supported Clients

### Consensus

- [Lighthouse](https://github.com/sigp/lighthouse)
- [Teku](https://github.com/ConsenSys/teku)
- [Nimus](https://github.com/status-im/nimbus-eth2)
- [Lodestar](https://github.com/ChainSafe/lodestar)

### Execution

- [Erigon](https://github.com/ledgerwatch/erigon)
- [Nethermind](https://github.com/NethermindEth/nethermind)
- [Infura](http://infura.io) (discouraged for mainnet)

### Validation

- Lighthouse is currently the only validator supported.

## Usage

The `Pulumi.mainnet.yaml`, `Pulumi.prater.yaml` and `./cluster/Pulumi.gcp.yaml`
show example configurations to use as a starting point.

Running `pulumi up -s prater` will get you up and running. While clients are
sync'ing, you can connect to the rocketpool pod to initialize your wallet and
deposits.

tl;dr: configure `rocketpool:consensus` and `rocketpool:execution` with the
clients you'd like to use. Terminate pods to automatically scale up/down their
resource reservations. Optionally configure snapshots if you'd like to tear
everything down and come back to it later.

A 0.5 vCPU pod is always deployed with containers for the Lighthouse validator
and the Rocket Pool rewards claim tool.

### Configuration

The stack attempts to use sane defaults (depending on whether you're deploying
to mainnet or a testnet) as much as possible, but you can configure the
overrides described in the table below.

Some config values are expected to be encrypted and can be set like so:

```
pulumi config -s mainnet set --secret --path teku.checkpointUrl 'https://...@eth2-beacon-mainnet.infura.io/eth/v2/debug/beacon/states/finalized'
```

| config                                                      | description                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rocketpool:consensus: _list[string]_                        | A list of consensus clients to use. This is in priority order, so the validator will prefer to connect to the first client. Available values are: "lighthouse", "lodestar", "nimbus" and "teku".                                                      |
| rocketpool:execution: _list[string]_                        | A list of execution clients to use. This is inpriority order, so consensus clients will prefer to connect to the first execution client in this list. Available values are: "erigon", "nethermind" and "infura". Infura should be avoided on mainnet. |
| rocketpool:gkeMonitoring: _bool_                            | If this is a cloud deployment and a notification channel is configured on the cluster, then set this to "true" to receive operational alerts.                                                                                                         |
| rocketpool:infura: { eth1Endpoint: _secret_ }               | Secret. Address of your Infura Eth1 API. Useful as a fallback but should be avoided on mainnet.                                                                                                                                                       |
| rocketpool:infura: { eth2Endpoint: _secret_ }               | Secret. Address of your Infura Eth2 API. Useful as a fallback but should be avoided on mainnet.                                                                                                                                                       |
| rocketpool:kubeconfig: _string_                             | Path to an existing cluster's `kubeconfig`.                                                                                                                                                                                                           |
| rocketpool:_client_: { command: _list[string]_ }            | A custom command to start the container with, helpful for starting a container with "sleep infinity" to load data into the PVC.                                                                                                                       |
| rocketpool:_client_: { external: _bool_ }                   | Whether to expose the client to the internet for discovery. Optional, and defaults to false; incurs additional costs if enabled.                                                                                                                      |
| rocketpool:_client_: { image: _string_ }                    | Docker image to use.                                                                                                                                                                                                                                  |
| rocketpool:_client_: { tag: _string_ }                      | Image tag to use.                                                                                                                                                                                                                                     |
| rocketpool:_client_: { replicas: _int_ }                    | How many instances to deploy. Set this to 0 to disable the client while preserving persistent volumes.                                                                                                                                                |
| rocketpool:_client_: { volume: { snapshot: _bool_ } }       | If "true" this will create a volume snapshot. Only set this after a volume has been created.                                                                                                                                                          |
| rocketpool:_client_: { volume: { source: _string_ } }       | If set, new persistent volume claims will be created based on the volume snapshot with this name.                                                                                                                                                     |
| rocketpool:_client_: { volume: { storage: _string_ } }      | The size of the persistent volume claim.                                                                                                                                                                                                              |
| rocketpool:_client_: { volume: { storageClass: _string_ } } | The PVC's storage class.                                                                                                                                                                                                                              |
| rocketpool:_client_: { targetPeers: _int_ }                 | The maximum or desired number of peers.                                                                                                                                                                                                               |
| rocketpool:_consensusclient_: { checkpointUrl: _string_ }   | Consensus clients accept the same options as execution clients, plus a `checkpointUrl:` option. For Lighthouse this can be an Infura Eth2 address; for Teku it's of the form given above.                                                             |
| rocketpool:rocketpool: { graffiti: _string_ }               | Graffiti for signed nodes.                                                                                                                                                                                                                            |
| rocketpool:rocketpool: { nodePassword: _secret_ }           | Secret. Password for the Rocket Pool node.                                                                                                                                                                                                            |

### Syncing

Clients are initially _very over-provisioned_ to speed up the sync process.
This works fine on testnets like Prater; after the sync is done, terminate the
pod to automatically scale down its resource reservations (otherwise you'll be
over-paying!).

A mainnet sync will take much longer than it would if running locally, or it
might not complete at all:

- Nethermind requires at least "fast" / "pd-balanced" storage and takes about a week to sync.
- Erigon will not complete and requires manually uploading a complete database
  to the container.

TODO: Please file an issue if you'd like instructions for uploading chain data
to the cluster.

## Costs

I've tried to tune this to be as cost-effective as possible while
still providing reliable, penalty-free attestations.

I'm currently running a 100% effective mainnet stack with Erigon, Lighthouse
and Teku for ~$5 a day.

Your costs will vary depending on your configuration and region.

## Why Pulumi? Why not Helm?

This is a hobby project that I don't expect much interest in, and I just find
Typescript to be more enjoyable to work with than HCL, Kustomize, or YAML.
Sorry!

## Similar Projects

- [rocketpool-deploy](https://github.com/cloudstruct/rocketpool-deploy) (AWS, Terraform, Ansible)
- [rp-ha](https://github.com/CryptoManufaktur-io/rp-ha) (Docker Swarm)
- [rocketpool-helm](https://github.com/eskapaid/rocketpool-helm) (Kubernetes)
