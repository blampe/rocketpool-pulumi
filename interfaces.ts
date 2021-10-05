export interface VolumeConfig {
  snapshot?: boolean;
  source?: string;
  storage?: string;
  storageClass?: string;
}

export interface StatefulSetConfig {
  cpu?: string;
  image?: string;
  tag?: string;
  memory?: string;
  replicas?: number;
  volume?: VolumeConfig;
}

export interface RocketpoolConfig extends StatefulSetConfig {
  nodePassword: string;
  graffiti?: string;
}
