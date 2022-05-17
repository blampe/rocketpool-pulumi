import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ConsensusClient,
  ConsensusClientConfig,
  ConsensusClientOptions,
} from "./interfaces";
import { ExecutionClient } from "../execution/interfaces";

export class LodestarClient implements ConsensusClient {
  readonly enabled: boolean;
  readonly endpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    executionClients: ExecutionClient[],
    config: pulumi.Config
  ): LodestarClient {
    const opts = config.getObject<ConsensusClientConfig>("lodestar") || {};

    return new LodestarClient({
      provider: provider,
      network: network,
      replicas: opts.replicas ?? 1,
      image: opts.image || "chainsafe/lodestar",
      tag: opts.tag || "v0.33.0",
      cpu: opts.cpu || "3",
      memory: opts.memory || "3Gi",
      command: opts.command || [],
      external: opts.external || false,
      targetPeers: opts.targetPeers || 30,
      executionClients: executionClients,
      gkeMetrics: opts.gkeMetrics || false,
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source || "data-lodestar-0",
        storage: opts.volume?.storage || "16Gi",
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
    gkeMetrics,
    volume,
  }: ConsensusClientOptions) {
    this.enabled = replicas > 0;

    const statefulSet = new k8s.apps.v1.StatefulSet(
      "lodestar",
      {
        metadata: {
          name: "lodestar",
          labels: { app: "lodestar" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: "lodestar",
            },
          },
          serviceName: "lodestar",
          replicas: replicas,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "lodestar",
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
                app: "lodestar",
              },
            },
            spec: {
              enableServiceLinks: false,
              containers: [
                {
                  name: "lodestar",
                  image: `${image}:${tag}`,
                  command: command.length
                    ? command
                    : [
                        "./node_modules/.bin/lodestar",
                        "beacon",
                        `--network=${network}`,
                        "--metrics.enabled=true",
                        "--metrics.serverPort=8008",
                        "--rootDir=/data",
                        `--network.maxPeers=${targetPeers}`,
                        ...(network == "mainnet"
                          ? ["--weakSubjectivitySyncLatest=true"]
                          : []),
                        "--eth1.providerUrls",
                        ...executionClients.map((c) => c.endpoint),
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
                    { name: "http", containerPort: 9596 },
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
      "lodestar",
      {
        metadata: {
          name: "lodestar",
          labels: { app: "lodestar" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: "lodestar",
          },
          ports: [
            { name: "http", port: 9596 },
            { name: "metrics", port: 8008 },
          ],
          sessionAffinity: "ClientIP",
        },
      },
      { provider: provider, dependsOn: [statefulSet] }
    );

    new k8s.apiextensions.CustomResource(
      "lodestar-vertical-autoscaling",
      {
        apiVersion: "autoscaling.k8s.io/v1",
        kind: "VerticalPodAutoscaler",
        metadata: {
          name: "lodestar",
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
        "lodestar-snapshot",

        {
          apiVersion: "snapshot.storage.k8s.io/v1",
          kind: "VolumeSnapshot",
          metadata: {
            name: volume.source,
          },
          spec: {
            source: {
              //persistentVolumeClaimName: pulumi.interpolate`data-${statefulSet.metadata.name}-0`,
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
        "lodestar-pod-monitor",
        {
          apiVersion: "monitoring.googleapis.com/v1alpha1",
          kind: "PodMonitoring",
          metadata: {
            name: "lodestar-pod-monitor",
          },
          spec: {
            selector: {
              matchLabels: {
                app: "lodestar",
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
        "lodestar-external",
        {
          metadata: {
            name: "lodestar-external",
            labels: { app: "lodestar" },
            annotations: {
              "cloud.google.com/network-tier": "Standard",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "lodestar",
            },
            ports: [{ name: "discovery-tcp", port: 9000 }],
          },
        },
        { provider: provider }
      );
    }
  }
}
