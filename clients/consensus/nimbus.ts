import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ConsensusClient,
  ConsensusClientConfig,
  ConsensusClientOptions,
} from "./interfaces";
import { ExecutionClient } from "../execution/interfaces";

export class NimbusClient implements ConsensusClient {
  readonly enabled: boolean;
  readonly endpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    executionClients: ExecutionClient[],
    config: pulumi.Config
  ): NimbusClient {
    const opts = config.getObject<ConsensusClientConfig>("nimbus") || {};

    return new NimbusClient({
      provider: provider,
      network: network,
      replicas: opts.replicas ?? 1,
      image: opts.image || "statusim/nimbus-eth2",
      tag: opts.tag || "multiarch-v1.6.0",
      cpu: opts.cpu || "3",
      memory: opts.memory || "3Gi",
      external: opts.external || false,
      targetPeers: opts.targetPeers || 160,
      executionClients: executionClients,
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source || "data-nimbus-0",
        storage: opts.volume?.storage || "64Gi",
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
    volume,
  }: ConsensusClientOptions) {
    this.enabled = replicas > 0;

    const statefulSet = new k8s.apps.v1.StatefulSet(
      "nimbus",
      {
        metadata: {
          name: "nimbus",
          labels: { app: "nimbus" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: "nimbus",
            },
          },
          serviceName: "nimbus",
          replicas: replicas,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "nimbus",
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
                app: "nimbus",
              },
            },
            spec: {
              containers: [
                {
                  name: "nimbus",
                  image: `${image}:${tag}`,
                  command: [
                    `./run-${network}-beacon-node.sh`,
                    "--non-interactive",
                    "--num-threads=0",
                    "--enr-auto-update",
                    "--data-dir=/data",
                    "--rest",
                    "--rest-address=0.0.0.0",
                    `--max-peers=${targetPeers}`,
                    ...executionClients.map(
                      (c) =>
                        pulumi.interpolate`--web3-url=${
                          c.wsEndpoint ?? c.endpoint
                        }`
                    ),
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
      "nimbus",
      {
        metadata: {
          name: "nimbus",
          labels: { app: "nimbus" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: "nimbus",
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
      "nimbus-vertical-autoscaling",
      {
        apiVersion: "autoscaling.k8s.io/v1",
        kind: "VerticalPodAutoscaler",
        metadata: {
          name: "nimbus",
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
        "nimbus-snapshot",

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
    if (external) {
      new k8s.core.v1.Service(
        "nimbus-external",
        {
          metadata: {
            name: "nimbus-external",
            labels: { app: "nimbus" },
            annotations: {
              "cloud.google.com/network-tier": "Standard",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "nimbus",
            },
            ports: [{ name: "discovery-tcp", port: 9000 }],
          },
        },
        { provider: provider }
      );
    }
  }
}
