import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

new gcp.compute.ProjectDefaultNetworkTier("network-tier", {
  networkTier: "STANDARD",
  project: gcp.config.project,
});

const gkeEnabled = new gcp.projects.Service("enable-container-api", {
  project: gcp.config.project,
  service: "container.googleapis.com",
  disableDependentServices: true,
});

const cluster = new gcp.container.Cluster(
  "rocketpool",
  {
    enableAutopilot: true,
    location: gcp.config.region,
    monitoringConfig: {
      enableComponents: ["SYSTEM_COMPONENTS", "WORKLOADS"],
    },
    verticalPodAutoscaling: {
      enabled: true,
    },
  },
  { dependsOn: [gkeEnabled] }
);

export const kubeconfig = pulumi
  .all([cluster.name, cluster.endpoint, cluster.masterAuth])
  .apply(([name, endpoint, masterAuth]) => {
    const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
    const kubeconfig = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
`;
    return kubeconfig;
  });

new k8s.storage.v1.StorageClass("cheap", {
  metadata: {
    name: "cheap",
  },
  provisioner: "pd.csi.storage.gke.io",
  parameters: {
    type: "pd-standard",
  },
  allowVolumeExpansion: true,
  volumeBindingMode: "WaitForFirstConsumer",
  reclaimPolicy: "Delete",
});

new k8s.storage.v1.StorageClass("fast", {
  metadata: {
    name: "fast",
  },
  provisioner: "pd.csi.storage.gke.io",
  parameters: {
    type: "pd-balanced",
  },
  allowVolumeExpansion: true,
  volumeBindingMode: "WaitForFirstConsumer",
  reclaimPolicy: "Delete",
});

new k8s.apiextensions.CustomResource("snapshot-class", {
  apiVersion: "snapshot.storage.k8s.io/v1",
  kind: "VolumeSnapshotClass",
  metadata: {
    name: "snapshot",
    annotations: {
      "snapshot.storage.kubernetes.io/is-default-class": "true",
    },
  },
  parameters: {
    "storage-locations": gcp.config.region,
  },
  driver: "pd.csi.storage.gke.io",
  deletionPolicy: "Retain",
});

new gcp.monitoring.AlertPolicy("container-restarts", {
  displayName: "Container restarts are high",
  documentation: {
    content:
      "This could indicate malformed config or startup commands; problems with networking/storage; or other issues.",
  },
  conditions: [
    {
      displayName: "Kubernetes Container - Restart count",
      conditionThreshold: {
        aggregations: [
          {
            alignmentPeriod: "1800s",
            crossSeriesReducer: "REDUCE_SUM",
            groupByFields: ["resource.label.container_name"],
            perSeriesAligner: "ALIGN_DELTA",
          },
        ],
        comparison: "COMPARISON_GT",
        duration: "3600s",
        filter: pulumi.interpolate`resource.type = "k8s_container" AND resource.labels.cluster_name = "${cluster.name}" AND metric.type = "kubernetes.io/container/restart_count"`,
        thresholdValue: 5,
        trigger: {
          count: 1,
        },
      },
    },
  ],
  combiner: "OR",
  notificationChannels:
    config.getObject<string[]>("notificationChannels") ?? [],
});

new gcp.monitoring.AlertPolicy("volume-utilization", {
  displayName: "Persistant volume needs to be expanded",
  documentation: {
    content:
      "See this page for a description of how to expand the volume: https://kubernetes.io/blog/2018/07/12/resizing-persistent-volumes-using-kubernetes/",
  },
  conditions: [
    {
      displayName: "Kubernetes Pod - Volume utilization",
      conditionThreshold: {
        aggregations: [
          {
            alignmentPeriod: "3600s",
            crossSeriesReducer: "REDUCE_MAX",
            groupByFields: ["resource.label.pod_name"],
            perSeriesAligner: "ALIGN_MAX",
          },
        ],
        comparison: "COMPARISON_GT",
        duration: "3600s",
        filter: pulumi.interpolate`resource.type = "k8s_pod" AND resource.labels.cluster_name = "${cluster.name}" AND metric.type = "kubernetes.io/pod/volume/utilization"`,
        thresholdValue: 0.9,
        trigger: {
          count: 1,
        },
      },
    },
  ],
  combiner: "OR",
  alertStrategy: {
    autoClose: "3600s",
  },
  notificationChannels:
    config.getObject<string[]>("notificationChannels") ?? [],
});
