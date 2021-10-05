import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ConsensusClient,
  ConsensusClientConfig,
  ConsensusClientOptions,
} from "./interfaces";
import { ExecutionClient } from "../execution/interfaces";

export class LighthouseBeacon implements ConsensusClient {
  readonly enabled: boolean;
  readonly endpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    executionClients: ExecutionClient[],
    config: pulumi.Config
  ): LighthouseBeacon {
    const opts = config.getObject<ConsensusClientConfig>("lighthouse") || {};
    const mainnet = network === "mainnet";

    return new LighthouseBeacon({
      provider: provider,
      network: network,
      replicas: opts.replicas ?? 1,
      image: opts.image || "sigp/lighthouse",
      tag: opts.tag || "v2.1.3-modern",
      cpu: opts.cpu || "750m",
      memory: opts.memory || "3Gi",
      external: opts.external || false,
      targetPeers: opts.targetPeers || 50,
      executionClients: executionClients,
      checkpointUrl: opts.checkpointUrl,
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source || "data-lighthouse-beacon-0",
        storage: opts.volume?.storage || (mainnet ? "72Gi" : "72Gi"),
        storageClass: opts.volume?.storageClass || "fast",
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
    external,
    targetPeers,
    executionClients,
    checkpointUrl,
    volume,
  }: ConsensusClientOptions) {
    this.enabled = replicas > 0;

    const statefulSet = new k8s.apps.v1.StatefulSet(
      "lighthouse-beacon",
      {
        metadata: {
          name: "lighthouse-beacon",
          labels: { app: "lighthouse-beacon" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: "lighthouse-beacon",
            },
          },
          serviceName: "lighthouse-beacon",
          replicas: replicas,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "lighthouse-beacon",
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
                app: "lighthouse-beacon",
              },
            },
            spec: {
              containers: [
                {
                  name: "lighthouse-beacon",
                  image: `${image}:${tag}`,
                  command: [
                    "lighthouse",
                    "beacon",
                    "--datadir=/data",
                    "--debug-level=info",
                    `--network=${network}`,
                    "--staking",
                    "--http-address=0.0.0.0",
                    "--validator-monitor-auto",
                    "--metrics",
                    "--metrics-address=0.0.0.0",
                    "--private",
                    "--slots-per-restore-point=8192", // Reduce storage space since we're only validating
                    "--eth1-blocks-per-log-query=150",
                    // TODO --import-all-attestations might help with delays?
                    pulumi.interpolate`--eth1-endpoints=${pulumi
                      .all(executionClients.map((c) => c.endpoint))
                      .apply((endpoints) => endpoints.join(","))}`,
                    ...(checkpointUrl !== undefined
                      ? [
                          pulumi.interpolate`--checkpoint-sync-url=${checkpointUrl}`,
                        ]
                      : []),
                    ...(targetPeers !== 0
                      ? [`--target-peers=${targetPeers}`]
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
                    { name: "http", containerPort: 5052 },
                    { name: "metrics", containerPort: 5054 },
                    { name: "discovery", containerPort: 9000 },
                  ],
                  readinessProbe: {
                    httpGet: {
                      port: "http",
                      path: "/eth/v1/node/health?syncing_status=501",
                    },
                    failureThreshold: 1,
                    successThreshold: 1,
                    periodSeconds: 1,
                  },
                },
              ],
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
      "lighthouse-beacon",
      {
        metadata: {
          name: "lighthouse-beacon",
          labels: { app: "lighthouse-beacon" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: "lighthouse-beacon",
          },
          ports: [
            { name: "http", port: 5052 },
            { name: "metrics", port: 5054 },
          ],
          sessionAffinity: "ClientIP",
        },
      },
      { provider: provider, dependsOn: [statefulSet] }
    );

    new k8s.apiextensions.CustomResource(
      "lighthouse-vertical-autoscaling",
      {
        apiVersion: "autoscaling.k8s.io/v1",
        kind: "VerticalPodAutoscaler",
        metadata: {
          name: "lighthouse",
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
                  cpu: "3",
                  memory: "8Gi",
                },
                minAllowed: {
                  cpu: "250m",
                  memory: "512Mi",
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

    if (volume.snapshot) {
      new k8s.apiextensions.CustomResource(
        "lighthouse-snapshot",
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
        "lighthouse-beacon-external",
        {
          metadata: {
            name: "lighthouse-beacon-external",
            labels: { app: "lighthouse-beacon" },
            annotations: {
              "cloud.google.com/network-tier": "Standard",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "lighthouse-beacon",
            },
            ports: [{ name: "discovery-tcp", port: 9000 }],
          },
        },
        { provider: provider }
      );
    }
  }
}
