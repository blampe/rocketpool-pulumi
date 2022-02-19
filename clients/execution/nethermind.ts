import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ExecutionClient,
  ExecutionClientConfig,
  ExecutionClientOptions,
} from "./interfaces";

export class NethermindClient implements ExecutionClient {
  readonly enabled: boolean;
  readonly endpoint: pulumi.Output<string>;
  readonly wsEndpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    config: pulumi.Config
  ): NethermindClient {
    const opts = config.getObject<ExecutionClientConfig>("nethermind") || {};
    const mainnet = network === "mainnet";

    return new NethermindClient({
      provider: provider,
      network: network,
      replicas: opts.replicas ?? 1,
      image: opts.image || "nethermind/nethermind",
      tag: opts.tag || "1.12.4",
      cpu: opts.cpu || "2",
      memory: opts.memory || "4Gi",
      command: opts.command || [],
      external: opts.external || false,
      targetPeers: opts.targetPeers || 50,
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source || "data-nethermind-0",
        storage: opts.volume?.storage || (mainnet ? "512Gi" : "72Gi"),
        storageClass: opts.volume?.storageClass || (mainnet ? "fast" : "fast"),
      },
    });
  }

  constructor({
    provider,
    network,
    replicas,
    image,
    tag,
    cpu,
    memory,
    command,
    external,
    targetPeers,
    volume,
  }: ExecutionClientOptions) {
    this.enabled = replicas > 0;

    const statefulSet = new k8s.apps.v1.StatefulSet(
      "nethermind",
      {
        metadata: {
          name: "nethermind",
          labels: { app: "nethermind" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: "nethermind",
            },
          },
          serviceName: "nethermind",
          replicas: replicas,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "nethermind",
                },
              },
              spec: {
                storageClassName: volume.storageClass,
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: volume.storage,
                  },
                },
                ...(volume.source
                  ? {
                      dataSource: {
                        name: volume.source,
                        kind: "VolumeSnapshot",
                        apiGroup: "snapshot.storage.k8s.io",
                      },
                    }
                  : {}),
              },
            },
          ],
          template: {
            metadata: {
              labels: {
                app: "nethermind",
              },
            },
            spec: {
              containers: [
                {
                  name: "nethermind",
                  image: `${image}:${tag}`,
                  command: command.length
                    ? command
                    : [
                        "./Nethermind.Runner",
                        `--config=${
                          network === "mainnet" ? network : "goerli"
                        }`,
                        "--JsonRpc.Enabled=true",
                        "--JsonRpc.Host=0.0.0.0",
                        "--Pruning.Enabled=true",
                        "--Init.BaseDbPath=/data",
                        "--KeyStore.EnodeKeyFile=/data/node.key.plain",
                        `--Init.MemoryHint=1500000000`,
                        `--Network.MaxActivePeers=${targetPeers}`,
                        "--HealthChecks.Enabled=true",
                        "--Init.WebSocketsEnabled=true",
                        "--Sync.DownloadBodiesInFastSync=true",
                        "--Sync.DownloadReceiptsInFastSync=true",
                        ...(network === "mainnet"
                          ? [
                              "--Sync.AncientBodiesBarrier=11052984",
                              "--Sync.AncientReceiptsBarrier=11052984",
                            ]
                          : []),
                      ],
                  resources: {
                    limits: { cpu: cpu, memory: memory },
                    requests: { cpu: cpu, memory: memory },
                  },
                  volumeMounts: [
                    {
                      name: "data",
                      mountPath: "/data",
                    },
                  ],
                  ports: [
                    {
                      name: "http",
                      containerPort: 8545,
                    },
                    {
                      name: "discovery-udp",
                      containerPort: 30303,
                      protocol: "UDP",
                    },
                  ],
                  readinessProbe: {
                    httpGet: {
                      port: "http",
                      path: "/health",
                    },
                    failureThreshold: 1,
                    successThreshold: 1,
                    periodSeconds: 1,
                  },
                },
              ],
              terminationGracePeriodSeconds: 60,
              nodeSelector: {
                "cloud.google.com/gke-spot": "true",
              },
            },
          },
        },
      },
      { provider: provider }
    );

    const service = new k8s.core.v1.Service(
      "nethermind",
      {
        metadata: {
          name: "nethermind",
          labels: { app: "nethermind" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: "nethermind",
          },
          ports: [{ name: "http", port: 8545 }],
          sessionAffinity: "ClientIP",
        },
      },
      { provider: provider }
    );

    new k8s.apiextensions.CustomResource(
      "nethermind-vertical-autoscaling",
      {
        apiVersion: "autoscaling.k8s.io/v1",
        kind: "VerticalPodAutoscaler",
        metadata: {
          name: "nethermind",
        },
        spec: {
          targetRef: {
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            name: statefulSet.metadata.name,
          },
          resourcePolicy: {
            containerPolicies: [
              {
                containerName: "*",
                controlledResources: ["cpu", "memory"],
                maxAllowed: {
                  cpu: "4",
                  memory: "10Gi",
                },
                minAllowed: {
                  cpu: "50m",
                  memory: "64Mi",
                },
              },
            ],
          },
        },
      },
      {
        provider: provider,
      }
    );

    this.endpoint = pulumi.interpolate`http://${service.metadata.name}:${service.spec.ports[0].port}`;
    this.wsEndpoint = pulumi.interpolate`ws://${service.metadata.name}:${service.spec.ports[0].port}`;

    if (volume.snapshot) {
      new k8s.apiextensions.CustomResource(
        "nethermind-snapshot",

        {
          apiVersion: "snapshot.storage.k8s.io/v1",
          kind: "VolumeSnapshot",
          metadata: {
            name: volume.source,
          },
          spec: {
            source: {
              persistentVolumeClaimName: volume.source,
            },
          },
        },
        {
          provider: provider,
        }
      );
    }

    if (external) {
      new k8s.core.v1.Service(
        "nethermind-external",
        {
          metadata: {
            name: "nethermind-external",
            labels: { app: "nethermind" },
            annotations: {
              "cloud.google.com/network-tier": "Standard",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "nethermind",
            },
            ports: [
              { name: "discovery-udp", port: 30303, protocol: "UDP" },
              { name: "discovery-tcp", port: 30303, protocol: "TCP" },
            ],
          },
        },
        { provider: provider }
      );
    }
  }
}
