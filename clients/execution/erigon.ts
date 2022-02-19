import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ExecutionClient,
  ExecutionClientConfig,
  ExecutionClientOptions,
} from "./interfaces";

interface ErigonClientOptions extends ExecutionClientOptions {
  provider: k8s.Provider;
  network: string;
}

export class ErigonClient implements ExecutionClient {
  readonly enabled: boolean;
  readonly endpoint: pulumi.Output<string>;
  readonly wsEndpoint: pulumi.Output<string>;

  static fromConfig(
    provider: k8s.Provider,
    network: string,
    config: pulumi.Config
  ): ErigonClient {
    const opts = config.getObject<ExecutionClientConfig>("erigon") || {};
    const mainnet = network === "mainnet";

    return new ErigonClient({
      provider: provider,
      network: network,
      replicas: opts.replicas ?? 1,
      image: opts.image || "thorax/erigon",
      tag: opts.tag || "v2022.02.03",
      cpu: opts.cpu || "4000m",
      memory: opts.memory || "10Gi",
      external: opts.external || false,
      targetPeers: opts.targetPeers || 33,
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source || "data-erigon-0",
        storage: opts.volume?.storage || (mainnet ? "1024Gi" : "64Gi"),
        storageClass: opts.volume?.storageClass || (mainnet ? "cheap" : "fast"),
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
    volume,
  }: ErigonClientOptions) {
    this.enabled = replicas > 0;

    const statefulSet = new k8s.apps.v1.StatefulSet(
      "erigon",
      {
        metadata: {
          name: "erigon",
          labels: { app: "erigon" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: "erigon",
            },
          },
          serviceName: "erigon",
          replicas: replicas,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "erigon",
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
                app: "erigon",
              },
            },
            spec: {
              containers: [
                {
                  name: "erigon",
                  image: `${image}:${tag}`,
                  command: [
                    "erigon",
                    "--prune.r.before=11184524",
                    "--prune=htc",
                    "--datadir=/data",
                    `--chain=${network == "mainnet" ? network : "goerli"}`,
                    "--state.stream.disable", // Caching is disable on the rpcdaemon
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
                      name: "private-rpc",
                      containerPort: 9090,
                      protocol: "TCP",
                    },
                    {
                      name: "discovery-udp",
                      containerPort: 30303,
                      protocol: "UDP",
                    },
                  ],
                },

                {
                  name: "rpcdaemon",
                  image: `${image}:${tag}`,
                  command: [
                    "rpcdaemon",
                    //"--datadir=/data", // TODO: try with datadir?
                    "--private.api.addr=127.0.0.1:9090",
                    "--state.cache=0",
                    "--http.addr=0.0.0.0",
                    "--ws",
                    "--http.api=eth,net,erigon",
                    "--http.vhosts=*",
                    // Compression?
                    // --ws.compression
                    // --http.vhosts=*
                  ],
                  //volumeMounts: [
                  //{
                  //name: "data",
                  //mountPath: "/data",
                  //},
                  //],
                  ports: [
                    {
                      name: "http",
                      containerPort: 8545,
                    },
                  ],
                  readinessProbe: {
                    exec: {
                      command: [
                        "sh",
                        "-c",
                        "wget -q localhost:8545/health -O - --post-data '{}'",
                      ],
                    },
                    //httpGet: {
                    //port: "http",
                    //path: "/health",
                    //},
                    failureThreshold: 1,
                    successThreshold: 1,
                    periodSeconds: 1,
                  },
                },
              ],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                fsGroupChangePolicy: "OnRootMismatch",
              },
              terminationGracePeriodSeconds: 600,
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
      "erigon",
      {
        metadata: {
          name: "erigon",
          labels: { app: "erigon" },
          annotations: {
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          type: "ClusterIP",
          selector: {
            app: "erigon",
          },
          ports: [{ name: "http", port: 8545 }],
          sessionAffinity: "ClientIP",
        },
      },
      { provider: provider, dependsOn: [statefulSet] }
    );

    new k8s.apiextensions.CustomResource(
      "erigon-vertical-autoscaling",
      {
        apiVersion: "autoscaling.k8s.io/v1",
        kind: "VerticalPodAutoscaler",
        metadata: {
          name: "erigon",
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
        "erigon-snapshot",

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
        "erigon-external",
        {
          metadata: {
            name: "erigon-external",
            labels: { app: "erigon" },
            annotations: {
              "cloud.google.com/network-tier": "Standard",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "erigon",
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
