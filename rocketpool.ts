import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import * as execution from "./clients/execution";
import * as consensus from "./clients/consensus";

import { getRocketpoolConfig } from "./config";
import { RocketpoolConfig } from "./interfaces";

interface RocketpoolOptions {
  provider: k8s.Provider;
  tag: string;
  lighthouseTag: string;
  network: string;
  cpu: string;
  memory: string;
  nodePassword: string;
  executionClients: execution.AbstractClient[];
  consensusClients: consensus.AbstractClient[];
  graffiti?: string;
  volume: {
    snapshot: boolean;
    source?: string;
    storage: string;
    storageClass: string;
  };
}

export class Rocketpool {
  static fromConfig(
    provider: k8s.Provider,
    network: string,
    executionClients: execution.AbstractClient[],
    consensusClients: consensus.AbstractClient[],
    config: pulumi.Config
  ): Rocketpool {
    const opts = config.requireObject<RocketpoolConfig>("rocketpool");

    return new Rocketpool({
      provider: provider,
      tag: opts.tag || "v1.1.2",
      lighthouseTag:
        config.getObject<{ tag: string }>("lighthouse")?.tag || "v2.2.1-modern",
      network: network,
      cpu: opts.cpu || "50m",
      memory: opts.memory || "128Mi",
      nodePassword: opts.nodePassword,
      executionClients: executionClients,
      consensusClients: consensusClients,
      graffiti: opts.graffiti || "",
      volume: {
        snapshot: opts.volume?.snapshot || false,
        source: opts.volume?.source,
        storage: opts.volume?.storage || "1Gi",
        storageClass: opts.volume?.storageClass || "cheap",
      },
    });
  }

  constructor({
    provider,
    tag,
    lighthouseTag,
    network,
    cpu,
    memory,
    nodePassword,
    executionClients,
    consensusClients,
    graffiti,
    volume,
  }: RocketpoolOptions) {
    if (executionClients.length == 0) {
      return; // Nothing to do
    }
    const eth1Endpoint = executionClients[0].endpoint;
    const eth1WsEndpoint = executionClients[0].wsEndpoint;

    const configMap = new k8s.core.v1.ConfigMap(
      "rocketpool-config",
      {
        data: {
          "config.yml": getRocketpoolConfig({
            network,
            tag,
            eth1Endpoint,
            eth1WsEndpoint,
          }),
          "settings.yml": pulumi.interpolate`
chains:
  eth1:
    client:
      selected: custom
      params:
      - env: PROVIDER_URL
        value: ${eth1Endpoint}
  eth2:
    client:
      selected: lighthouse
`,
        },
      },
      { provider: provider }
    );

    new k8s.apps.v1.StatefulSet(
      "rocketpool",
      {
        metadata: {
          name: "rocketpool",
          labels: { app: "rocketpool" },
        },

        spec: {
          selector: {
            matchLabels: {
              app: "rocketpool",
            },
          },
          serviceName: "rocketpool",
          replicas: 1,
          volumeClaimTemplates: [
            {
              metadata: {
                name: "data",
                labels: {
                  app: "rocketpool",
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
                app: "rocketpool",
              },
            },
            spec: {
              initContainers: [
                {
                  name: "install-rocketpool-cli",
                  image: "busybox:1.34.0",
                  command: [
                    "sh",
                    "-c",
                    `test -x /mnt/data/rocketpool-cli-${tag}` +
                      ` || wget https://github.com/rocket-pool/smartnode-install/releases/download/${tag}/rocketpool-cli-linux-amd64 -O /mnt/data/rocketpool-cli-${tag}` +
                      ` && chmod +x /mnt/data/rocketpool-cli-${tag}`,
                  ],
                  resources: resources(cpu, memory),
                  volumeMounts: [
                    {
                      name: "data",
                      mountPath: "/mnt/data",
                    },
                  ],
                },
              ],
              containers: [
                {
                  name: "rocketpool-node",
                  image: `rocketpool/smartnode:${tag}`,
                  command: [
                    "sh",
                    "-c",
                    `echo "alias rocketpool='/.rocketpool/rocketpool-cli-${tag} --allow-root -c /.rocketpool -d /go/bin/rocketpool'" > /etc/profile.d/rocketpool.sh` +
                      " && /go/bin/rocketpool node",
                  ],
                  env: [
                    {
                      name: "ENV",
                      value: "/etc/profile",
                    },
                  ],
                  ports: [{ name: "metrics", containerPort: 5052 }],
                  resources: resources(cpu, memory),
                  volumeMounts: [
                    {
                      name: "data",
                      mountPath: "/.rocketpool/",
                    },
                    {
                      name: "config",
                      mountPath: "/.rocketpool/config.yml",
                      subPath: "config.yml",
                    },
                    {
                      name: "config",
                      mountPath: "/.rocketpool/settings.yml",
                      subPath: "settings.yml",
                    },
                    {
                      name: "secrets",
                      mountPath: "/.rocketpool/password",
                      subPath: "password",
                    },
                  ],
                },
                {
                  name: "lighthouse-validator",
                  image: `sigp/lighthouse:${lighthouseTag}`,
                  command: [
                    "lighthouse",
                    "validator",
                    "--datadir=/data/data/validators/lighthouse/",
                    "--debug-level=info",
                    "--init-slashing-protection",
                    "--logfile-max-number=1",
                    `--network=${network}`,
                    // Lighthouse has funky timeout behavior with only 1
                    // beacon, so force it to use more aggressive timeouts
                    // by always giving it 4 to connect to.
                    pulumi.interpolate`--beacon-nodes=${pulumi
                      .all(
                        [0, 1, 2, 3].map(
                          (i) =>
                            consensusClients[i % consensusClients.length]
                              .endpoint
                        )
                      )
                      .apply((endpoints) => endpoints.join(","))}`,
                    ...(graffiti != "" ? [`--graffiti=${graffiti}`] : []),
                  ],
                  ports: [
                    {
                      name: "metrics",
                      containerPort: 5052,
                    },
                  ],
                  resources: resources("200m", "512Mi"),
                  volumeMounts: [
                    {
                      name: "data",
                      mountPath: "/data",
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: "config",
                  configMap: {
                    name: configMap.metadata.name,
                  },
                },
                {
                  name: "secrets",
                  secret: {
                    secretName: new k8s.core.v1.Secret(
                      "rocketpool-node-password",
                      {
                        stringData: {
                          password: nodePassword,
                        },
                      },
                      { provider: provider }
                    ).metadata.name,
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
  }
}

function resources(cpu: string, memory: string) {
  return {
    requests: {
      cpu: cpu,
      memory: memory,
    },
    limits: {
      cpu: cpu,
      memory: memory,
    },
  };
}
