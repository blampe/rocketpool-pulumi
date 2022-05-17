import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ConsensusClient,
  ConsensusClientConfig,
  ConsensusClientOptions,
} from "./interfaces";
import { ExecutionClient } from "../execution/interfaces";

export class TekuClient implements ConsensusClient {
  readonly enabled: boolean;
  readonly endpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    executionClients: ExecutionClient[],
    config: pulumi.Config
  ): TekuClient {
    const opts = config.getObject<ConsensusClientConfig>("teku") || {};
    const mainnet = network === "mainnet";

    return new TekuClient({
      provider: provider,
      network: network,
      replicas: opts.replicas ?? 1,
      image: opts.image || "consensys/teku",
      tag: opts.tag || "22.1.1-jdk17",
      cpu: opts.cpu || "4",
      memory: opts.memory || "3Gi",
      command: opts.command || [],
      external: opts.external || false,
      targetPeers: opts.targetPeers || 74,
      executionClients: executionClients,
      checkpointUrl: opts.checkpointUrl || pulumi.output(""),
      gkeMetrics: opts.gkeMetrics || false,
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source || "data-teku-0",
        storage: opts.volume?.storage || (mainnet ? "48Gi" : "40Gi"),
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
    command,
    external,
    targetPeers,
    executionClients,
    checkpointUrl,
    gkeMetrics,
    volume,
  }: ConsensusClientOptions) {
    this.enabled = replicas > 0;

    const statefulSet = new k8s.apps.v1.StatefulSet(
      "teku",
      {
        metadata: {
          name: "teku",
          labels: { app: "teku" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: "teku",
            },
          },
          serviceName: "teku",
          replicas: replicas,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "teku",
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
                app: "teku",
              },
            },

            spec: {
              containers: [
                {
                  name: "teku",
                  image: `${image}:${tag}`,
                  command: command.length
                    ? command
                    : [
                        "./bin/teku",
                        "--metrics-enabled",
                        "--metrics-port=8008",
                        "--metrics-host-allowlist=*",
                        "--log-destination=CONSOLE",
                        "--data-base-path=/data",
                        `--network=${network}`,
                        "--rest-api-enabled",
                        "--rest-api-interface=0.0.0.0",
                        "--rest-api-host-allowlist=*",
                        `--p2p-peer-upper-bound=${targetPeers}`,
                        pulumi.interpolate`--eth1-endpoints=${pulumi
                          .all(executionClients.map((c) => c.endpoint))
                          .apply((endpoints) => endpoints.join(","))}`,
                        // e.g. --initial-state https://INFURA/eth/v2/debug/beacon/states/finalized
                        ...(checkpointUrl !== undefined
                          ? [
                              pulumi.interpolate`--initial-state=${checkpointUrl}`,
                            ]
                          : []),
                      ],
                  env: [
                    {
                      name: "TEKU_OPTS",
                      value: "-XX:-HeapDumpOnOutOfMemoryError",
                    },
                    // https://docs.teku.consensys.net/en/latest/HowTo/Get-Started/Manage-Memory/
                    {
                      name: "JAVA_OPTS",
                      value: "-Xmx2g",
                    },
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
                    { name: "http", containerPort: 5051 },
                    { name: "metrics", containerPort: 8008 },
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
              securityContext: {
                runAsUser: 0,
              },
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
      "teku",
      {
        metadata: {
          name: "teku",
          labels: { app: "teku" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: "teku",
          },
          ports: [
            { name: "http", port: 5051 },
            { name: "metrics", port: 8008 },
            { name: "discovery", port: 9000 },
          ],
          sessionAffinity: "ClientIP",
        },
      },
      { provider: provider, dependsOn: [statefulSet] }
    );

    new k8s.apiextensions.CustomResource(
      "teku-vertical-autoscaling",
      {
        apiVersion: "autoscaling.k8s.io/v1",
        kind: "VerticalPodAutoscaler",
        metadata: {
          name: "teku",
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
                  cpu: "8",
                  memory: "8Gi",
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

    if (volume.snapshot) {
      new k8s.apiextensions.CustomResource(
        "teku-snapshot",

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

    if (gkeMetrics) {
      new k8s.apiextensions.CustomResource(
        "teku-pod-monitor",
        {
          apiVersion: "monitoring.googleapis.com/v1alpha1",
          kind: "PodMonitoring",
          metadata: {
            name: "teku-pod-monitor",
          },
          spec: {
            selector: {
              matchLabels: {
                app: "teku",
              },
            },
            endpoints: [
              {
                port: "metrics",
                interval: "3m",
              },
            ],
          },
        },
        { provider: provider }
      );
    }

    if (external) {
      new k8s.core.v1.Service(
        "teku-external",
        {
          metadata: {
            name: "teku-external",
            labels: { app: "teku" },
            annotations: {
              "cloud.google.com/network-tier": "Standard",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "teku",
            },
            ports: [{ name: "discovery-tcp", port: 9000 }],
          },
        },
        { provider: provider }
      );
    }
  }
}
