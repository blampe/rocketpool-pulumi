import * as pulumi from "@pulumi/pulumi";

interface ConfigOptions {
  network: string;
  tag: string;
  eth1Endpoint: pulumi.Output<string>;
  eth1WsEndpoint?: pulumi.Output<string>;
}

export function getRocketpoolConfig({
  network,
  tag,
  eth1Endpoint,
  eth1WsEndpoint,
}: ConfigOptions): pulumi.Output<string> {
  const mainnet = network == "mainnet";
  return pulumi.interpolate`
rocketpool:
  storageAddress: ${
    mainnet
      ? "0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46"
      : "0xd8Cd47263414aFEca62d6e2a3917d6600abDceB3"
  }
  oneInchOracleAddress: ${
    mainnet
      ? "0x07D91f5fb9Bf7798734C3f606dB065549F6893bb"
      : "0x4eDC966Df24264C9C817295a0753804EcC46Dd22"
  }
  rplTokenAddress: ${
    mainnet
      ? "0xb4efd85c19999d84251304bda99e90b92300bd93"
      : "0xb4efd85c19999d84251304bda99e90b92300bd93"
  }
  ${
    mainnet
      ? ""
      : "rplFaucetAddress: 0x95D6b8E2106E3B30a72fC87e2B56ce15E37853F9"
  }
smartnode:
  projectName: rocketpool
  graffitiVersion: ${tag}
  image: rocketpool/smartnode:${tag}
  passwordPath: /.rocketpool/password
  walletPath: /.rocketpool/wallet
  validatorKeychainPath: /.rocketpool/data/validators
  validatorRestartCommand: "/bin/true" # Validator is managed by k8s
  maxFee: 0 # The maximum amount you're willing to pay, in gwei, to use for transactions.
            # Set it to 0 if you want to view the current suggested prices and choose this number manually for each transaction.
  maxPriorityFee: 2 # The most "extra" you want to spend on a transaction to make it faster, in gwei.
  rplClaimGasThreshold: 100  # Automatic RPL reward claims will wait until the network's average gas price, in gwei, is below this limit.

                            # Set it to 0 to disable automatic claiming of RPL rewards entirely.
  txWatchUrl: ${
    mainnet ? "https://etherscan.io/tx" : "https://goerli.etherscan.io/tx"
  }
  stakeUrl: ${
    mainnet ? "https://stake.rocketpool.net" : "https://testnet.rocketpool.net"
  }
chains:
  eth1:
    provider: ${eth1Endpoint}
    wsProvider: ${eth1WsEndpoint || ""}
    chainID: ${mainnet ? "1 # Mainnet" : "5 # Goerli"}
    client:
      options:
      - id: geth
        name: Geth
        desc: "\tGeth is one of the three original implementations of the\n
          \t\tEthereum protocol. It is written in Go, fully open source and\n
          \t\tlicensed under the GNU LGPL v3."
        link: https://geth.ethereum.org/
        image: ethereum/client-go:v1.10.10
        params:
        - name: Ethstats Label
          desc: optional - for reporting Eth 1.0 node status to ethstats.net
          env: ETHSTATS_LABEL
        - name: Ethstats Login
          desc: optional - for reporting Eth 1.0 node status to ethstats.net
          env: ETHSTATS_LOGIN
      - id: infura
        name: Infura
        desc: "\tUse infura.io as a light client for Eth 1.0. Not recommended\n
          \t\tfor use in production."
        link: https://infura.io/
        image: rocketpool/smartnode-pow-proxy:${tag}
        params:
        - name: Infura Project ID
          desc: the ID of your project created in Infura
          env: INFURA_PROJECT_ID
          regex: ^[0-9a-fA-F]{32}$
          required: true
      - id: custom
        name: Custom
        desc: "\tUse a custom Eth 1.0 client at a specified address (does not\n
          \t\twork on localhost)."
        image: rocketpool/smartnode-pow-proxy:${tag}
        params:
        - name: Provider URL
          desc: the Eth 1.0 client HTTP server address
          env: PROVIDER_URL
          required: true
  eth2:
    provider: "http://lighthouse-beacon:5052"
    client:
      options:
      - id: lighthouse
        name: Lighthouse
        desc: "\tLighthouse is an Eth2.0 client with a heavy focus on speed and\n
          \t\tsecurity. The team behind it, Sigma Prime, is an information\n
          \t\tsecurity and software engineering firm who have funded Lighthouse\n
          \t\talong with the Ethereum Foundation, Consensys, and private\n
          \t\tindividuals. Lighthouse is built in Rust and offered under an\n
          \t\tApache 2.0 License."
        image: sigp/lighthouse:v2.0.0
        link: https://lighthouse-book.sigmaprime.io/
        params:
        - name: Custom Graffiti
          desc: optional - for adding custom text to signed Eth 2.0 blocks - 16 chars max
          env: CUSTOM_GRAFFITI
          regex: ^.{0,16}$
      - id: nimbus
        name: Nimbus
        desc: "\tNimbus is a client implementation for both Ethereum 2.0 and\n
          \t\tEthereum 1.0 that strives to be as lightweight as possible in\n
          \t\tterms of resources used. This allows it to perform well on\n
          \t\tembedded systems, resource-restricted devices -- including\n
          \t\tRaspberry Pis and mobile devices -- and multi-purpose servers."
        image: statusim/nimbus-eth2:multiarch-v1.5.1
        link: https://nimbus.guide/intro.html
        params:
        - name: Custom Graffiti
          desc: optional - for adding custom text to signed Eth 2.0 blocks - 16 chars max
          env: CUSTOM_GRAFFITI
          regex: ^.{0,16}$
      - id: prysm
        name: Prysm
        desc: "\tPrysm is a Go implementation of Ethereum 2.0 protocol with a\n
          \t\tfocus on usability, security, and reliability. Prysm is developed\n
          \t\tby Prysmatic Labs, a company with the sole focus on the\n
          \t\tdevelopment of their client. Prysm is written in Go and released\n
          \t\tunder a GPL-3.0 license."
        beaconImage: prysmaticlabs/prysm-beacon-chain:HEAD-843ed5-debug #v2.0.1
        validatorImage: prysmaticlabs/prysm-validator:HEAD-843ed5-debug #v2.0.1
        link: https://docs.prylabs.network/docs/getting-started
        supermajority: true
        params:
        - name: Custom Graffiti
          desc: optional - for adding custom text to signed Eth 2.0 blocks - 16 chars max
          env: CUSTOM_GRAFFITI
          regex: ^.{0,16}$
      - id: teku
        name: Teku
        desc: "\tPegaSys Teku (formerly known as Artemis) is a Java-based\n
          \t\tEthereum 2.0 client designed & built to meet institutional needs\n
          \t\tand security requirements. PegaSys is an arm of ConsenSys\n
          \t\tdedicated to building enterprise-ready clients and tools for\n
          \t\tinteracting with the core Ethereum platform. Teku is Apache 2\n
          \t\tlicensed and written in Java, a language notable for its\n
          \t\tmaturity & ubiquity."
        image: consensys/teku:21.2.0-jdk14 # JDK15 incompatible with ARM
        link: https://docs.teku.consensys.net/en/stable/
        params:
        - name: Custom Graffiti
          desc: optional - for adding custom text to signed Eth 2.0 blocks - 16 chars max
          env: CUSTOM_GRAFFITI
          regex: ^.{0,16}$
    `;
}
